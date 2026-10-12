/**
 * 把 PouchDB 的浏览器构建复制到 public/vendor/ 下。
 *
 * 为什么复制而不是从 node_modules 直接托管：
 *   1. public/ 是唯一的静态资源根，路径规则简单，不会有目录穿越风险
 *   2. 运行时不需要 node_modules 存在（部署时前端可独立）
 *
 * 产物是可再生的第三方文件，已加入 .gitignore；此脚本负责重新生成。
 *
 * 运行：node tools/vendor-pouchdb.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const HERE = import.meta.dirname;
const APP_DIR = path.join(HERE, '..');
const OUT_DIR = path.join(APP_DIR, 'public', 'vendor');

// 复用 sync/ 下已装好的 pouchdb（与验证脚本同一份，避免版本不一致）
const require = createRequire(path.join(APP_DIR, '..', 'sync', 'package.json'));
const pkgPath = require.resolve('pouchdb/package.json');
const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
const srcDir = path.join(path.dirname(pkgPath), 'dist');

const WANT = ['pouchdb.min.js'];

await fs.mkdir(OUT_DIR, { recursive: true });

for (const name of WANT) {
  const src = path.join(srcDir, name);
  const dst = path.join(OUT_DIR, name);
  await fs.copyFile(src, dst);
  const size = (await fs.stat(dst)).size;
  console.log(`✓ ${name}  ${(size / 1024).toFixed(0)} KB  (pouchdb ${pkg.version})`);
}

console.log(`\n输出目录：${path.relative(APP_DIR, OUT_DIR)}`);
console.log('提示：这是可再生的第三方文件，已加入 .gitignore。');
