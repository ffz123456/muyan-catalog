/**
 * 打包「团队版中心」—— 一个双击就能用的文件夹
 *
 * 产物结构：
 *   windows/dist/木言/
 *   ├── 启动.cmd                    ← 用户双击这个
 *   ├── 木言-服务端.exe          ← 独立可执行（不依赖装 Node）
 *   ├── README.txt                  ← 给不会用电脑的人看
 *   ├── app/
 *   │   ├── server/  public/  shared/  assets/
 *   │   └── node_modules/           ← 只带 puppeteer-core（出 PDF 用）
 *   ├── browser/                    ← 可选：带 Chromium 才能服务端出 PDF
 *   └── data/                       ← 运行后自动生成，放所有数据
 *
 * 为什么不带 CouchDB：
 *   服务端在没有 COUCHDB_URL 时用自带文件存储（server/orderstore.mjs）。
 *   CouchDB 在 Windows 上没有便携版（官方 issue #3028），装它要管理员权限，
 *   而"很多人不会用电脑"。自带存储让这个包**解压即用、不需要装任何东西**。
 *
 * 用法：
 *   node tools/build-hub.mjs              # 不带浏览器（约 90 MB）
 *   node tools/build-hub.mjs --with-browser   # 带 Chromium（约 370 MB，能服务端出 PDF）
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const APP = path.join(import.meta.dirname, '..');
const ROOT = path.join(APP, '..');
const HUB = path.join(ROOT, 'windows', 'hub');
const DIST = path.join(ROOT, 'windows', 'dist', '木言');

const WITH_BROWSER = process.argv.includes('--with-browser');
const NODE_EXE = process.env.BUILD_NODE_EXE || 'C:\\nodejs\\node.exe';
const POSTJECT = path.join(APP, 'node_modules', 'postject', 'dist', 'cli.js');

const problems = [];
const step = (m) => console.log(`  ${m}`);

/* ------------------------------------------------------------------ *
 * 1. 编译独立 exe
 * ------------------------------------------------------------------ */

async function buildExe() {
  if (!fs.existsSync(NODE_EXE)) {
    problems.push(`找不到 Node 可执行文件：${NODE_EXE}（可用 BUILD_NODE_EXE 指定）`);
    return null;
  }
  if (!fs.existsSync(POSTJECT)) {
    problems.push(`缺少 postject（npm install --no-save postject）：${POSTJECT}`);
    return null;
  }

  const work = path.join(HUB, '_build');
  await fsp.mkdir(work, { recursive: true });

  // 启动壳要改名成 .cjs（SEA 只支持 CommonJS 入口）
  await fsp.copyFile(path.join(HUB, 'launcher.cjs'), path.join(work, 'launcher.cjs'));
  await fsp.writeFile(path.join(work, 'sea-config.json'), JSON.stringify({
    main: 'launcher.cjs',
    output: 'prep.blob',
    disableExperimentalSEAWarning: true,
  }, null, 2), 'utf-8');

  step('生成 SEA blob…');
  execFileSync(NODE_EXE, ['--experimental-sea-config', 'sea-config.json'], { cwd: work, stdio: 'pipe' });

  const exe = path.join(DIST, '木言-服务端.exe');
  await fsp.copyFile(NODE_EXE, exe);

  step('注入到 exe…');
  execFileSync(process.execPath, [
    POSTJECT, exe, 'NODE_SEA_BLOB', path.join(work, 'prep.blob'),
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ], { stdio: 'pipe' });

  return exe;
}

/* ------------------------------------------------------------------ *
 * 2. 拷应用文件
 * ------------------------------------------------------------------ */

async function copyApp() {
  const dst = path.join(DIST, 'app');
  await fsp.mkdir(dst, { recursive: true });

  for (const d of ['server', 'public', 'shared']) {
    await fsp.cp(path.join(APP, d), path.join(dst, d), { recursive: true });
  }
  // 示例图片（首次运行就有东西可看）
  const assets = path.join(APP, 'assets');
  if (fs.existsSync(assets)) {
    await fsp.cp(assets, path.join(dst, 'assets'), { recursive: true });
  }

  /* 只带 puppeteer-core：它是"出 PDF"需要的驱动。
     完整的 puppeteer 会带一堆构建工具，没必要。 */
  const pc = path.join(APP, 'node_modules', 'puppeteer-core');
  if (fs.existsSync(pc)) {
    await fsp.mkdir(path.join(dst, 'node_modules'), { recursive: true });
    await fsp.cp(pc, path.join(dst, 'node_modules', 'puppeteer-core'), { recursive: true });
    // 它的依赖也要带上，否则 import 会失败
    for (const dep of ['debug', 'ms', 'ws', 'devtools-protocol', 'typed-query-selector',
      'chromium-bidi', 'mitt', 'zod', 'parse5', 'progress', 'tar-fs', 'tar-stream',
      'streamx', 'bare-events', 'bare-fs', 'bare-path', 'bare-stream', 'bare-url',
      'fast-fifo', 'text-decoder', 'b4a', 'events-universal', 'end-of-stream',
      'once', 'wrappy', 'pump', 'semver', 'extract-zip', 'yauzl', 'fd-slicer',
      'pend', 'buffer-crc32', 'get-stream', 'mkdirp', 'import-fresh', 'argparse']) {
      const from = path.join(APP, 'node_modules', dep);
      if (fs.existsSync(from)) {
        await fsp.cp(from, path.join(dst, 'node_modules', dep), { recursive: true });
      }
    }
    step('已带上 puppeteer-core（服务端出 PDF 的驱动）');
  } else {
    step('⚠ 没找到 puppeteer-core，包里不会带 —— 画册仍可用「打印为 PDF」');
  }
}

/* ------------------------------------------------------------------ *
 * 3. 浏览器（可选）
 * ------------------------------------------------------------------ */

async function copyBrowser() {
  if (!WITH_BROWSER) return false;

  /*
   * ⚠️ 优先用 chrome-headless-shell 而不是完整 Chrome。
   *   完整 Chrome 解压后 437 MB（chrome.dll 一个就 290 MB），
   *   headless-shell 只要 279 MB 且没有用不到的界面代码。
   */
  const candidates = [
    path.join(process.env.PUPPETEER_CACHE_DIR || '', 'chrome-headless-shell'),
    path.join(process.env.LOCALAPPDATA || '', '..', '..', '.cache', 'puppeteer', 'chrome-headless-shell'),
    path.join('C:\\LYX_Codex_workspace\\Workspace\\.puppeteer-cache', 'chrome-headless-shell'),
  ].filter((p) => p && p.length > 20);

  let found = null;
  for (const base of candidates) {
    if (!fs.existsSync(base)) continue;
    // 目录结构是 chrome-headless-shell/<平台>/chrome-headless-shell-win64/
    for (const v of fs.readdirSync(base)) {
      const d = path.join(base, v);
      if (!fs.statSync(d).isDirectory()) continue;
      for (const p of fs.readdirSync(d)) {
        const inner = path.join(d, p);
        if (fs.statSync(inner).isDirectory()
            && fs.existsSync(path.join(inner, 'chrome-headless-shell.exe'))) {
          found = inner;
          break;
        }
      }
      if (found) break;
    }
    if (found) break;
  }

  if (!found) {
    problems.push('指定了 --with-browser 但没找到 chrome-headless-shell。\n'
      + '     先运行 app/tools/vendor-pouchdb.mjs 之外的方式获取，'
      + '或用 PUPPETEER_CACHE_DIR 指定缓存目录。');
    return false;
  }

  await fsp.cp(found, path.join(DIST, 'browser'), { recursive: true });
  step(`已带上浏览器（${Math.round(dirSize(found) / 1024 / 1024)} MB）`);
  return true;
}

function dirSize(d) {
  let total = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

/* ------------------------------------------------------------------ *
 * 4. 用户入口（双击的文件 + 说明）
 * ------------------------------------------------------------------ */

async function writeEntryPoints(hasBrowser) {
  const cmd = `@echo off
chcp 65001 >nul
title 木言 · 团队版中心
cd /d "%~dp0"

echo.
echo   正在启动，请稍等...
echo.

"%~dp0木言-服务端.exe"

echo.
echo   程序已停止运行。
echo   如果上面有报错信息，请截图发给帮你安装的人。
echo.
pause
`;
  await fsp.writeFile(path.join(DIST, '启动.cmd'), cmd.replace(/\n/g, '\r\n'), 'utf-8');

  const readme = `木言 · 开单画册
========================================

怎么用
------
1. 双击「启动.cmd」
2. 会弹出一个黑色窗口，里面显示一个网址（形如 http://192.168.1.5:8080）
3. 把那个网址发给销售，他们在手机上打开就能用
4. **这个黑窗口不要关**，关了销售就连不上了

第一次打开会显示每个账号的初始密码，**只显示一次，请立刻记下来**，
然后当面告诉本人。他们第一次登录后会要求改密码。

销售能看到什么
--------------
· 只能看到**自己的**订单，看不到别人的
· 管理员（admin）能看到全部订单
· 产品资料是共享的，谁都能看，只有管理员能改

数据存在哪
----------
就在这个文件夹的 data 子目录里。**这个文件夹不能删**。
建议每周把 data 目录复制一份到别的地方做备份。

想换台电脑用
------------
把整个文件夹复制过去，双击「启动.cmd」即可。数据跟着走。

常见问题
--------
问：手机连不上怎么办？
答：手机要和这台电脑在**同一个 WiFi** 下。
   如果要在外面也能用，需要用 Tailscale 之类的工具打通网络，
   详见项目文档。

问：黑窗口里报错了？
答：截图发给帮你安装的人。常见原因是端口被占用。

问：能关掉黑窗口吗？
答：不能。关了销售就连不上了。电脑可以锁屏，但不要关机。
${hasBrowser ? '' : `
问：为什么画册的「服务端生成」不可用？
答：这个包没有带浏览器（省了 280 MB）。
   用「打印为 PDF」一样能出画册，手机上也行，效果相同。
`}
`;
  await fsp.writeFile(path.join(DIST, 'README.txt'), readme.replace(/\n/g, '\r\n'), 'utf-8');
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

console.log('');
console.log(`  打包团队版中心${WITH_BROWSER ? '（含浏览器）' : '（不含浏览器，省 280 MB）'}`);
console.log('');

await fsp.rm(DIST, { recursive: true, force: true });
await fsp.mkdir(DIST, { recursive: true });

const exe = await buildExe();
if (exe) {
  step(`已编译 exe（${Math.round(fs.statSync(exe).size / 1024 / 1024)} MB）`);
  await copyApp();
  const hasBrowser = await copyBrowser();
  await writeEntryPoints(hasBrowser);
  await fsp.mkdir(path.join(DIST, 'data'), { recursive: true });
  await fsp.rm(path.join(HUB, '_build'), { recursive: true, force: true });
}

if (problems.length) {
  console.error('');
  console.error('  ✗ 打包失败：');
  for (const p of problems) console.error('     ' + p);
  console.error('');
  process.exit(1);
}

const total = dirSize(DIST);
console.log('');
console.log('  ✓ 打包完成');
console.log(`    产物: ${path.relative(ROOT, DIST)}`);
console.log(`    大小: ${Math.round(total / 1024 / 1024)} MB`);
console.log('');
console.log('  接下来：双击该目录下的「启动.cmd」');
console.log('  验证：node tools/verify-hub-e2e.mjs（需先把服务端跑起来）');
console.log('');
