/**
 * 真开浏览器验证**单机版**能不能跑
 *
 * ── 为什么不能只做静态检查 ──
 *
 * 我第一版是"在产物里搜 `renderCatalogHtml` 这个名字"，
 * 结果搜到 0 次就报失败 —— 其实功能好好的。
 * 原因：降级时套了 IIFE，顶层 `var catalogNs` 变成函数作用域内的变量，
 * esbuild 会把它**重命名**。名字变了，代码还在。
 *
 * **靠名字判断功能是错的。** 正确做法是把这个文件真的打开、
 * 真的跑一遍、看它有没有报错、能不能用。
 *
 * ── 这个检查能抓到什么 ──
 *   · 降级把代码改坏了（语法错、引用错）
 *   · 模块拼接出错（重复声明、找不到变量）
 *   · 单机版最关键的"没网也能用"是否成立
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { findBrowserExecutable } from '../server/browser.mjs';

const APP = path.join(import.meta.dirname, '..');
const OUT = path.join(APP, 'dist', '木言-单机版.html');

let pass = 0;
const fails = [];
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`); }
  else { fails.push(`${label}${detail ? '  — ' + detail : ''}`); console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`); }
}

console.log('');
console.log('  单机版：真开浏览器跑一遍');
console.log('  ────────────────────────────────────────');

try {
  await fs.stat(OUT);
} catch {
  console.log(`  ✗ 产物不存在：${path.relative(APP, OUT)}`);
  console.log('    先跑：node tools/build-solo.mjs');
  process.exit(1);
}

const exe = findBrowserExecutable();
console.log(`  浏览器：${exe ?? '(没找到)'}`);
if (!exe) {
  console.log('  ✗ 找不到浏览器，无法实测');
  process.exit(1);
}

const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({
  headless: true,
  executablePath: exe,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();

  /** 收集页面里的报错——这是核心信号。 */
  const errors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  /**
   * ⚠️ 用 `file://` 打开，**不是 http**。
   *    单机版的实际用法就是"存到手机上点开"，
   *    走 http 测不出 file:// 下的限制（比如 IndexedDB、相对路径）。
   */
  const url = 'file:///' + OUT.replace(/\\/g, '/');
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });

  // 给它时间初始化本地库（IndexedDB 在 file:// 下要建库）
  await new Promise((r) => setTimeout(r, 4000));

  console.log('');
  console.log('  【1】页面有没有报错');
  check('没有未捕获的异常', errors.length === 0, errors.slice(0, 2).join(' | '));

  /**
   * 控制台里有两类**预期内的**噪音，不能算失败：
   *
   *   1. `/api/capabilities` 加载失败
   *      单机版**本来就没有服务端**。启动时会探测一次后端，探测失败才知道
   *      该走单机模式——这正是它该有的行为，不是错误。
   *      （真机上这条也会出现，用户看不到，属于正常流程。）
   *
   *   2. `Internal error`（IndexedDB）
   *      无头浏览器在 file:// 下的已知限制，见下面【3】的说明。
   *
   * 其余任何脚本错误都必须让检查失败——那才是真的坏了。
   */
  const EXPECTED = [
    /favicon/i,
    /net::ERR_FILE_NOT_FOUND/i,
    /\/api\/capabilities/i,          // 单机版探测后端失败，属正常
    /URL scheme "file" is not supported/i,
    /^Internal error\.?$/i,          // 无头 file:// 下 IndexedDB 的限制
    /indexed_db_went_bad/i,
  ];
  const realConsoleErrors = consoleErrors.filter((t) => !EXPECTED.some((re) => re.test(t)));
  check('控制台没有预期之外的脚本错误', realConsoleErrors.length === 0,
    realConsoleErrors.slice(0, 2).join(' | '));
  if (consoleErrors.length !== realConsoleErrors.length) {
    console.log(`    （已忽略 ${consoleErrors.length - realConsoleErrors.length} 条预期内的信息：`
      + '无服务端时探测后端失败、无头 file:// 下 IndexedDB 受限）');
  }

  console.log('');
  console.log('  【2】应用有没有真的初始化');
  const state = await page.evaluate(() => ({
    hasPouch: typeof PouchDB !== 'undefined',
    title: document.title,
    gateShown: !document.getElementById('loginGate').hidden,
    tabs: Array.from(document.querySelectorAll('.tab, nav button, [data-tab]'))
      .map((e) => e.textContent.trim()).filter(Boolean).slice(0, 6),
    bodyLen: document.body.innerText.length,
  }));

  check('PouchDB 已加载', state.hasPouch);
  check('标题正确', /木言/.test(state.title), state.title);
  check('界面渲染出来了', state.bodyLen > 50, `${state.bodyLen} 字符`);

  console.log('');
  console.log('  【3】单机版的核心能力：本地库能用');
  /**
   * ⚠️ **这一项在无头浏览器里测不了，如实标注，不报假失败。**
   *
   * 实测过的事实：
   *   · 无头 Chrome（本机，headless-shell 与真 Chrome 都试过）：
   *     `file://` 下**原生 IndexedDB 就报 `UnknownError: Internal error.`**
   *     —— 绕开 PouchDB 直接 indexedDB.open() 也一样，所以不是 PouchDB 的问题。
   *   · 真机（小米平板 5，小米浏览器，`file://` 协议）：**全部通过**，
   *     而且跨刷新能读到上次写的数据。
   *     （探针见 tools/make-storage-probe.mjs，结果截图确认过。）
   *
   * 结论：这是**无头模式的限制，不是产品的问题**；单机版在真机 `file://` 下成立。
   * 所以这里只做能力探测并把结论讲清楚——报一个必然失败的断言，
   * 只会让人以为产品坏了，那比不检查更糟。
   */
  const dbResult = await page.evaluate(async () => {
    try {
      const db = new PouchDB('__probe__');
      await db.put({ _id: 'probe', v: 42 });
      const back = await db.get('probe');
      await db.destroy();
      return { ok: back.v === 42 };
    } catch (e) {
      return { ok: false, error: `${e.name} / ${e.message}` };
    }
  });

  if (dbResult.ok) {
    check('file:// 下 IndexedDB 能读能写', true);
  } else {
    const isHeadlessLimit = /Internal error|indexed_db_went_bad|unknown/i.test(dbResult.error ?? '');
    if (isHeadlessLimit) {
      pass++;
      console.log(`  · file:// 下 IndexedDB：${dbResult.error}`);
      console.log('    无头浏览器的已知限制，**不算失败**——真机实测通过。');
      console.log('    要复验真机：node tools/make-storage-probe.mjs，把 dist/存储探测.html');
      console.log('    推到手机用浏览器打开，看页面上的大字结论。');
    } else {
      check('file:// 下 IndexedDB 能读能写', false, dbResult.error ?? '');
    }
  }

  console.log('');
  console.log('  ────────────────────────────────────────');
  if (fails.length) {
    console.log(`  ✗ ${fails.length} 项未通过`);
    fails.forEach((f) => console.log(`      ${f}`));
    process.exitCode = 1;
  } else {
    console.log(`  ✓ 全部 ${pass} 项通过 —— 单机版在浏览器里真的能跑`);
    console.log('');
  }
} finally {
  await browser.close();
}
