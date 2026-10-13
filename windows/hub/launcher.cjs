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
 *   而这个壳只需要几行。**能不动就不动。**
 *
 * 文件布局（exe 旁边必须有的东西）：
 *   <包根>/
 *   ├── 家具开单-服务端.exe     ← 本壳编译成的可执行文件
 *   ├── 启动.cmd                ← 用户双击这个（设置好控制台编码）
 *   ├── README.txt
 *   └── app/
 *       ├── server/  public/  shared/  assets/
 *   ├── browser/                ← 可选：带 Chromium 才能服务端出 PDF
 *   └── data/                   ← 所有数据（自动创建）
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
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

/** 出错时不要一闪而过——双击运行的人看不到堆栈就无从下手。 */
function die(lines) {
  console.error('');
  for (const l of lines) console.error('  ' + l);
  console.error('');
  console.error('  按回车键退出…');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(1));
}

/**
 * 找本机可用于访问的局域网地址。
 *
 * 为什么要挑：销售要用手机连这台电脑，必须给它**局域网**地址。
 *   127.0.0.1 在手机上打不开，虚拟网卡（VMware/WSL）的地址也不行——
 *   给了错的地址，用户会以为"这个东西坏了"。
 */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const ip = ni.address;
      /**
       * 排除**手机上打不开**的地址。给错地址比不给更糟——
       * 用户会以为"这个东西坏了"。
       *
       *   169.254.x.x  链路本地（没拿到 DHCP 时的自动地址）
       *   172.16–31.x  WSL / Docker
       *   192.168.56.x VirtualBox 默认
       */
      if (/^169\.254\./.test(ip)) continue;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) continue;
      if (/^192\.168\.56\./.test(ip)) continue;
      out.push({ ip, name: ni.name ?? '' });
    }
  }
  // 家用/办公网段优先
  out.sort((a, b) => {
    const rank = (x) => (x.ip.startsWith('192.168.') ? 0
      : x.ip.startsWith('10.') ? 1 : 2);
    return rank(a) - rank(b);
  });
  return out;
}

if (!fs.existsSync(SERVER)) {
  die([
    '找不到程序文件，无法启动。',
    '',
    `期望位置：${SERVER}`,
    '',
    '多半是解压不完整。请把整个压缩包重新解压到本地磁盘，',
    '并确保 exe 与 app 文件夹在同一层。',
  ]);
} else {
  /* 数据目录放在包根，跟着包走（便携） */
  process.env.FS_DATA_ROOT = process.env.FS_DATA_ROOT || ROOT;
  process.env.HOST = process.env.HOST || '0.0.0.0';

  const port = Number(process.env.PORT) || 8080;
  const addrs = lanAddresses();

  import(pathToFileURL(SERVER).href).then(() => {
    /**
     * 启动后再打印"给销售用的地址"。
     *
     * 服务端自己会打印监听信息，但那是给技术人看的。
     * 这里额外把**手机能直接打开的网址**列出来——用户要的就是这个。
     */
    setTimeout(() => {
      console.log('');
      console.log('  ══════════════════════════════════════════');
      console.log('   把这个网址发给销售，他们在手机上打开就能用：');
      console.log('');
      if (addrs.length) {
        for (const a of addrs) {
          console.log(`     http://${a.ip}:${port}`);
        }
      } else {
        console.log(`     http://<这台电脑的IP>:${port}`);
        console.log('     （没检测到局域网地址，请确认已连上 WiFi 或网线）');
      }
      console.log('');
      console.log('   ⚠️  这个窗口**不要关**，关了销售就连不上了。');
      console.log('       电脑可以锁屏，但不要关机。');
      console.log('  ══════════════════════════════════════════');
      console.log('');

      /* 自动在本机打开管理界面，省得用户手动敲网址 */
      if (process.env.NO_OPEN !== '1') {
        const url = `http://127.0.0.1:${port}/`;
        const { exec } = require('node:child_process');
        // Windows 用 start，macOS 用 open，Linux 用 xdg-open
        const cmd = process.platform === 'win32' ? `start "" "${url}"`
          : process.platform === 'darwin' ? `open "${url}"`
            : `xdg-open "${url}"`;
        exec(cmd, () => { /* 打不开就算了，用户可手动访问 */ });
      }
    }, 600);
  }).catch((err) => {
    die([
      '启动失败：' + err.message,
      '',
      '如果是端口被占用，可以设置环境变量换一个端口：',
      '  在「启动.cmd」里把 set PORT=8081 加进去',
    ]);
  });
}
