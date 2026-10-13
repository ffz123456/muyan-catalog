/**
 * SEA 启动壳（CommonJS）
 *
 * 为什么需要它：
 *   Node 的 SEA（单可执行文件）**只支持 CommonJS 入口**——
 *   直接塞 ESM 会报 `Cannot use import statement outside a module`（实测确认）。
 *   而本项目从第一天起就是 ESM（`import`/`export`）。
 *
 *   所以这里放一个极小的 CJS 壳，它只做一件事：
 *   把真正的 ESM 服务端 `import()` 进来。
 *
 * 为什么不用打包器把服务端转成 CJS：
 *   服务端有 `import.meta.dirname`（找 public/、data/ 目录）、
 *   动态 `import()`、`await import()`——转 CJS 要处理的边界很多，
 *   而这个壳只需要三行。**能不动就不动。**
 *
 * 文件布局（exe 旁边必须有的东西）：
 *   <包根>/
 *   ├── 家具开单-服务端.exe     ← 本壳编译成的可执行文件
 *   ├── launcher.cjs            ← 就是本文件（打包时内嵌进 exe，磁盘上可无）
 *   └── app/
 *       ├── server/  public/  shared/  assets/
 *       └── (可选) node_modules/    有浏览器时能服务端出 PDF
 *
 * 数据写在 <包根>/data/。
 */
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

/** 包根：exe 所在目录（SEA 里 process.execPath 就是 exe 自己）。 */
function packageRoot() {
  // 开发时直接用 node 跑这个文件：退回文件自身所在目录
  const base = process.execPath.toLowerCase().endsWith('node.exe')
    ? __dirname
    : path.dirname(process.execPath);
  return base;
}

const ROOT = packageRoot();
const SERVER = path.join(ROOT, 'app', 'server', 'index.mjs');

if (!fs.existsSync(SERVER)) {
  console.error('');
  console.error('  找不到程序文件，无法启动。');
  console.error('');
  console.error(`  期望位置：${SERVER}`);
  console.error('');
  console.error('  多半是解压不完整。请把整个压缩包重新解压到本地磁盘，');
  console.error('  并确保 exe 与 app 文件夹在同一层。');
  console.error('');
  console.error('  按回车键退出…');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
} else {
  /* 数据目录放在包根，跟着包走（便携） */
  process.env.FS_DATA_ROOT = process.env.FS_DATA_ROOT || ROOT;
  process.env.HOST = process.env.HOST || '0.0.0.0';

  import(pathToFileURL(SERVER).href).catch((err) => {
    console.error('');
    console.error('  启动失败：', err.message);
    console.error('');
    console.error('  按回车键退出…');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  });
}
