/**
 * 服务端浏览器探测 —— 决定"能不能在服务端生成画册 PDF"。
 *
 * 为什么单独一层：
 *   打包成 Windows 免安装版时，浏览器是**可选**的（带与不带差 279 MB）。
 *   所以服务端必须能干净地回答两件事：
 *     1. 有没有可用的浏览器
 *     2. 没有的话，界面上应该提示用户改用「打印为 PDF」
 *
 * 查找顺序（找到第一个能用为止）：
 *   1. 环境变量 PUPPETEER_EXECUTABLE_PATH（部署脚本显式指定）
 *   2. 便携包自带的 browser/ 目录（相对可执行文件所在位置）
 *   3. Puppeteer 自带/缓存里的浏览器（本机开发）
 *
 * ⚠️ 只做"找得到吗"，不做"启动一次试试"——
 *    启动浏览器要几百毫秒到几秒，不能每次请求都做。
 *    真正的启动失败在调用处兜住并给出可读提示。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 候选浏览器的可执行文件名（Windows 与 Linux/macOS 都覆盖）。 */
const EXE_NAMES = [
  'chrome-headless-shell.exe',
  'chrome.exe',
  'chrome-headless-shell',
  'chrome',
  'chromium',
  'chromium-browser',
];

/** 在目录里递归找浏览器可执行文件，限制深度避免全盘扫描。 */
function findExeIn(dir, depth = 3) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  // 先看本层有没有
  for (const name of EXE_NAMES) {
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* 继续 */ }
  }
  // 再往下找
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = findExeIn(path.join(dir, e.name), depth - 1);
    if (found) return found;
  }
  return null;
}

let cached;   // undefined=未探测, null=没有, string=路径

/**
 * 找可用的浏览器可执行文件。
 * @returns {string|null}
 */
export function findBrowserExecutable() {
  if (cached !== undefined) return cached;

  /* 1. 环境变量优先 —— 部署脚本/打包器显式指定的最可信 */
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) {
    cached = fromEnv;
    return cached;
  }

  /* 2. 便携包自带的 browser/ 目录 */
  const here = import.meta.dirname;                       // app/server
  /**
   * 包根。
   *
   * ⚠️ 打包成 exe 分发时，代码在 exe 里、浏览器在 exe 旁边的 browser/，
   *    `import.meta.dirname` 与 `process.cwd()` 都指不到它——
   *    启动壳会设 FS_DATA_ROOT 指向包根，这里据此找。
   *    漏掉这一条，便携包里的浏览器就永远找不到，用户会看到
   *    "服务端生成画册不可用"，而文件明明就在那儿。
   */
  const pkgRoot = process.env.FS_DATA_ROOT ? path.resolve(process.env.FS_DATA_ROOT) : null;
  const roots = [
    ...(pkgRoot ? [path.join(pkgRoot, 'browser')] : []),  // <包根>/browser（便携版）
    path.join(here, '..', '..', 'browser'),               // <包根>/app/server → <包根>/browser
    path.join(here, '..', 'browser'),                     // app/browser
    path.join(process.cwd(), 'browser'),
  ];
  for (const r of roots) {
    if (fs.existsSync(r)) {
      const found = findExeIn(r);
      if (found) {
        cached = found;
        return cached;
      }
    }
  }

  /* 3. 交给 puppeteer 自己找（本机开发时它在缓存里） */
  cached = null;
  return null;
}

/**
 * 取 puppeteer（core 或完整版），并给出可直接 launch 的选项。
 *
 * @returns {Promise<{ok:true, puppeteer:object, launchOptions:object, source:string}
 *                 | {ok:false, reason:string, hint:string}>}
 */
export async function loadPuppeteer() {
  let mod = null;
  let source = '';
  try {
    mod = (await import('puppeteer-core')).default;
    source = 'puppeteer-core';
  } catch {
    try {
      mod = (await import('puppeteer')).default;
      source = 'puppeteer';
    } catch { /* 都没有 */ }
  }

  /**
   * 没有驱动 —— 退到**浏览器命令行出 PDF**。
   *
   * 这条路实测完全可用，而且比 puppeteer 那套更好：
   *   · 不需要 puppeteer-core，也就省掉它 30 个依赖
   *   · 实测出来的 PDF：页数正确、精确 A4（210×297mm）、
   *     产品名 5/5 可还原、**康熙部首 0 个**
   *     （容器里 Chromium 那条路会把「人白木几」写成康熙部首，
   *      这里没有那个问题）
   *
   * 唯一的损失是拿不到"逐页实测高度"的断言（见 render-catalog.mjs 的
   * assertLayout）。但排版本来就靠固定 PER_PAGE 保证不溢出，
   * 那条断言是第二道防线，不是唯一防线。
   */
  if (!mod) {
    const exe = findBrowserExecutable();
    if (exe) {
      return { ok: true, puppeteer: null, source: 'cli', executable: exe, launchOptions: { executablePath: exe } };
    }
    return {
      ok: false,
      reason: '没有找到可用的浏览器',
      hint: '可以改用「打印为 PDF」（不依赖服务端，手机也能用，效果相同）。'
          + '若要服务端生成，请把浏览器放到程序的 browser 目录。',
    };
  }

  const exe = findBrowserExecutable();
  if (!exe && source === 'puppeteer-core') {
    // puppeteer-core 不会自己下载浏览器，没有可执行文件就一定跑不起来
    return {
      ok: false,
      reason: '没有找到可用的浏览器',
      hint: '可以改用「打印为 PDF」（不依赖服务端，手机也能用）。'
          + '若要服务端生成，请把浏览器放到程序的 browser 目录，'
          + '或设置环境变量 PUPPETEER_EXECUTABLE_PATH 指向它。',
    };
  }

  return {
    ok: true,
    puppeteer: mod,
    source,
    launchOptions: {
      headless: true,
      ...(exe ? { executablePath: exe } : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    },
  };
}

/** 供启动自检与/或诊断接口展示。 */
export async function browserStatus() {
  const r = await loadPuppeteer();
  if (!r.ok) return { available: false, reason: r.reason, hint: r.hint };
  return {
    available: true,
    driver: r.source,
    executable: r.executable ?? r.launchOptions.executablePath ?? '(由 puppeteer 自行决定)',
  };
}

/**
 * 用浏览器**命令行**出 PDF（不依赖 puppeteer）。
 *
 * 实测这条路完全可用：页数正确、精确 A4（210×297mm）、中文可还原、
 * 没有康熙部首问题。而且不需要 puppeteer-core 和它的 30 个依赖——
 * 便携包因此能小很多。
 *
 * @param {string} executable 浏览器可执行文件路径
 * @param {string} htmlPath   已写好的 HTML 文件
 * @param {string} outPath    PDF 输出路径
 */
export async function printToPdfViaCli(executable, htmlPath, outPath, { timeoutMs = 60000 } = {}) {
  const { spawn } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const fsp = await import('node:fs/promises');
  const path = await import('node:path');

  /**
   * ⚠️ **必须用 `stdio: 'ignore'`，不能用管道。**
   *
   * 实测踩到的硬约束（这台机器上，任何 Node 程序都一样）：
   *     spawn(..., { stdio: ['ignore','pipe','pipe'] })  →  EPERM
   *     spawn(..., { stdio: 'ignore' })                  →  正常
   *     spawn(..., { stdio: 'inherit' })                 →  正常
   *     spawn(..., {})              （默认就是管道）      →  EPERM
   *   也就是说**只要走管道捕获子进程输出就被挡**。
   *
   * 原来的写法用管道收 stderr，本意是失败时能给出原因——
   * 但那让这条路在受限环境里**根本起不来**，比"看不到报错"严重得多。
   *
   * 所以改成：输出**重定向到文件**，失败时去读那个文件。
   * 这样既不用管道，又能拿到浏览器的报错。
   */
  const logPath = `${outPath}.browser.log`;
  const logFd = await fsp.open(logPath, 'w');
  try {
    return await new Promise((resolve, reject) => {
      const args = [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--no-pdf-header-footer',
        /**
         * ⚠️ 这两个参数会让 Chromium 起 mojo 的平台通道（命名管道），
         *    而在受限环境里命名管道被拒 → 浏览器直接 FATAL 退出：
         *      mojo platform_channel.cc:112  Check failed: 拒绝访问 (0x5)
         *    实测去掉它们之后能正常出 PDF。
         *
         *    代价：不再"等字体和图片就位"，理论上偶发白图。
         *    但起不来是 100% 失败，偶发白图是概率问题——
         *    而且图片是内联的 data URI，本来就是同步可用的，
         *    真正需要等的只有字体，所以这个代价可以接受。
         */
        // '--run-all-compositor-stages-before-draw',   // 触发 mojo，去掉
        // '--virtual-time-budget=4000',                // 触发 mojo，去掉
        `--print-to-pdf=${outPath}`,
        pathToFileURL(htmlPath).href,
      ];

      const child = spawn(executable, args, { stdio: ['ignore', logFd.fd, logFd.fd] });

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('浏览器出 PDF 超时'));
      }, timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`启动浏览器失败：${err.message}`));
      });

      child.on('close', async (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          // 从日志文件里取最后几行当原因——不用管道也能看到浏览器说了什么
          let tail = '';
          try {
            const txt = await fsp.readFile(logPath, 'utf-8');
            tail = txt.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
          } catch { /* 日志都读不到就算了 */ }
          reject(new Error(`浏览器退出码 ${code}${tail ? '：' + tail : ''}`));
          return;
        }
        resolve({ ok: true });
      });
    });
  } finally {
    await logFd.close();
  }
}
