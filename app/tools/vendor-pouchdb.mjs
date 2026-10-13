/**
 * 把 PouchDB 的浏览器构建取到 public/vendor/ 下。
 *
 * 为什么要这个脚本：
 *   1. public/ 是唯一的静态资源根，路径规则简单，不会有目录穿越风险
 *   2. 运行时不需要 node_modules 存在（部署时前端可独立）
 *   3. **仓库里不存第三方构建**——它是可再生的，存进 git 只会让仓库变胖
 *
 * 三种来源，按顺序尝试（越靠前越省事）：
 *   ① 本地已装好的 pouchdb（`sync/` 或 `app/` 的 node_modules）
 *   ② 官方 npm registry 直接下载 tgz（**不需要 npm install**）
 *   ③ npm pack（需要 npm 可用）
 *
 * ⚠️ 为什么必须有 ②：
 *    最初只做了 ①——从 `sync/node_modules` 里复制。
 *    结果**新克隆的仓库里这个脚本直接报错**，
 *    因为 node_modules 是 gitignore 的、克隆出来根本没有。
 *    新人第一次上手就卡在这里，而且报错信息是 `require.resolve` 的堆栈，
 *    完全看不出"你得先装依赖"。
 *    现在②让它**零依赖也能跑通**。
 *
 * 运行：node tools/vendor-pouchdb.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

const HERE = import.meta.dirname;
const APP_DIR = path.join(HERE, '..');
const ROOT = path.join(APP_DIR, '..');
const OUT_DIR = path.join(APP_DIR, 'public', 'vendor');

/** 想要的文件（在 pouchdb 包的 dist/ 下）。 */
const WANT = ['pouchdb.min.js'];
/** 版本范围：与 package.json 里声明的一致，避免前后端版本漂移。 */
const RANGE = '^9.0.0';
const REGISTRY = process.env.NPM_REGISTRY || 'https://registry.npmjs.org';

/* ------------------------------------------------------------------ *
 * 来源① ：本地 node_modules
 * ------------------------------------------------------------------ */

async function fromLocal() {
  for (const base of [path.join(ROOT, 'sync'), path.join(APP_DIR)]) {
    try {
      const req = createRequire(path.join(base, 'package.json'));
      const pkgPath = req.resolve('pouchdb/package.json');
      const dist = path.join(path.dirname(pkgPath), 'dist');
      const files = {};
      for (const name of WANT) {
        files[name] = await fs.readFile(path.join(dist, name));
      }
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
      return { files, version: pkg.version, via: `本地 node_modules（${path.relative(ROOT, base) || '.'}）` };
    } catch { /* 换下一个 */ }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 来源② ：直接从 registry 下载（不需要 npm install）
 * ------------------------------------------------------------------ */

/** 取符合版本范围的 pouchdb 版本号。 */
async function resolveVersion() {
  const res = await fetch(`${REGISTRY}/pouchdb`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`查询版本失败：HTTP ${res.status}`);
  const meta = await res.json();
  const versions = Object.keys(meta.versions ?? {});
  // 极简 semver：取 ^major.minor.patch 里 major 相同、且不小于 minor 的最高版本
  const [, wantMajor, wantMinor] = RANGE.match(/\^(\d+)\.(\d+)\.(\d+)/) ?? [];
  const major = Number(wantMajor ?? 9);
  const minorMin = Number(wantMinor ?? 0);
  const ok = versions
    .filter((v) => {
      const [M, m, p] = v.split('.').map(Number);
      return M === major && m >= minorMin && Number.isFinite(p) && !v.includes('-');
    })
    .sort((a, b) => {
      const A = a.split('.').map(Number);
      const B = b.split('.').map(Number);
      return A[0] - B[0] || A[1] - B[1] || A[2] - B[2];
    });
  if (!ok.length) throw new Error(`registry 里没有符合 ${RANGE} 的版本`);
  return ok[ok.length - 1];
}

/** 下载 tgz 并解出需要的文件（自己解 tar，不引依赖）。 */
async function fromRegistry() {
  const version = await resolveVersion();
  const url = `${REGISTRY}/pouchdb/-/pouchdb-${version}.tgz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${url}`);
  const tgz = Buffer.from(await res.arrayBuffer());
  const tar = gunzipSync(tgz);

  // 极简 tar 解析：512 字节头 + 内容（按 512 对齐），到全零块结束
  const files = {};
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;                 // 结束块
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const type = String.fromCharCode(header[156]);
    const dataStart = off + 512;

    if (type === '0' || type === '\0' || type === '') {
      for (const want of WANT) {
        if (name === `package/dist/${want}`) {
          files[want] = Buffer.from(tar.subarray(dataStart, dataStart + size));
        }
      }
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }

  for (const name of WANT) {
    if (!files[name]) throw new Error(`tgz 里没找到 package/dist/${name}`);
  }
  return { files, version, via: `npm registry（${url}）` };
}

/* ------------------------------------------------------------------ *
 * 来源③ ：npm pack
 * ------------------------------------------------------------------ */

async function fromNpmPack() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pouchdb-pack-'));
  try {
    execFileSync('npm', ['pack', `pouchdb@${RANGE}`, '--silent'], { cwd: tmp, stdio: 'pipe' });
    const tgzName = (await fs.readdir(tmp)).find((f) => f.endsWith('.tgz'));
    if (!tgzName) throw new Error('npm pack 没有产出 tgz');
    const tar = gunzipSync(await fs.readFile(path.join(tmp, tgzName)));
    const files = {};
    let off = 0;
    while (off + 512 <= tar.length) {
      const header = tar.subarray(off, off + 512);
      if (header.every((b) => b === 0)) break;
      const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
      const dataStart = off + 512;
      for (const want of WANT) {
        if (name === `package/dist/${want}`) files[want] = Buffer.from(tar.subarray(dataStart, dataStart + size));
      }
      off = dataStart + Math.ceil(size / 512) * 512;
    }
    const version = tgzName.replace(/^pouchdb-/, '').replace(/\.tgz$/, '');
    return { files, version, via: 'npm pack' };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const sources = [
  ['本地已装的 pouchdb', fromLocal],
  ['npm registry 直接下载', fromRegistry],
  ['npm pack', fromNpmPack],
];

let got = null;
for (const [label, fn] of sources) {
  try {
    const r = await fn();
    if (r) {
      got = { ...r, label };
      break;
    }
  } catch (e) {
    // 只在最后全都失败时才把细节抛出来，中间失败通常是"这条路不通"
    if (label === sources[sources.length - 1][0]) throw e;
  }
}

if (!got) {
  console.error('');
  console.error('  ✗ 三种方式都没取到 pouchdb。');
  console.error('    请检查网络，或手动把一个 pouchdb 9.x 的 dist/pouchdb.min.js');
  console.error(`    放到 ${path.relative(ROOT, OUT_DIR)}/ 下。`);
  console.error('');
  process.exit(1);
}

await fs.mkdir(OUT_DIR, { recursive: true });
for (const name of WANT) {
  await fs.writeFile(path.join(OUT_DIR, name), got.files[name]);
  const size = got.files[name].length;
  console.log(`  ✓ ${name}  ${(size / 1024).toFixed(0)} KB  （pouchdb ${got.version}，来源：${got.label}）`);
}

console.log('');
console.log(`  输出目录：${path.relative(ROOT, OUT_DIR)}`);
console.log('  这是可再生的第三方文件，已加入 .gitignore，不进仓库。');
