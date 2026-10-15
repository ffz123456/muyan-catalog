/**
 * 把前端代码降级到**旧手机也能跑**的语法级别
 *
 * ── 为什么必须有这一步 ──
 *
 * 实测：旧手机（OPPO A3，Android 10）上的 Edge 用的是**自己打包的 Chromium 77**，
 * 而不是系统的 WebView 89。而代码里用了 `??`（空值合并，要 Chrome 80+）——
 * 结果 `app.mjs` 的**解析**就失败，一行都不执行。现象是：
 *   页面骨架在、账号下拉是空的、一个接口都不调、什么都点不动。
 *
 * 这不是"小概率的兼容问题"，是**一部分用户完全用不了**。
 * 而且这类问题不会报错、不会白屏，只会"看起来正常但什么都没发生"，
 * 极难排查——所以**必须由构建步骤兜住，不能靠写代码时小心**。
 *
 * ── 两个层次，缺一不可 ──
 *
 *   1. **语法**（`??` `?.` `||=` `&&=`）
 *      esbuild 能转成等价的旧写法。做了就不再有解析错误。
 *
 *   2. **API**（`replaceAll` `Array.at` `structuredClone` `Object.hasOwn` `findLast`）
 *      esbuild **转不了**——那是运行时方法，不是语法。
 *      只能加补丁。实测 esbuild 转完这 5 个还在，所以必须手写。
 *
 *   用 `supported` 关掉 esbuild 对这几个 API 的"自动假设"，
 *   否则它会以为目标环境有、就不做任何处理。
 *
 * ── 产物 ──
 *
 *   public/*.mjs        → public/*.js          （index.html 改成加载 .js）
 *   public/*.html       → public/*.html        （内联脚本也要降级）
 *   shared/catalog.mjs  → public/shared/catalog.js
 *
 * 单机版（那个独立 HTML）走的是另一条路（build-solo.mjs 自己打包），
 * 它也要降级，见那边的调用。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * `esbuild` 是**可选的**——按需动态引入，缺了也不让服务端崩。
 *
 * ⚠️ 为什么不能写成顶层的 `import * as esbuild from 'esbuild'`：
 *    服务端启动时会 import 本模块来跑"过期就重建"。
 *    如果 esbuild 是顶层静态 import，那么在**没装 esbuild 的机器**
 *    （比如用户拿到的发布包里只有 node_modules 的一部分）
 *    服务端启动就直接 ERR_MODULE_NOT_FOUND **整个挂掉**——
 *    而构建本来是件"最好有、没有也能跑"的事。
 *
 *    实测踩到：`npm install puppeteer-core` 把 `--no-save` 装的 esbuild
 *    当多余依赖清掉了，之后服务端起不来。
 *
 * 降级行为：拿不到 esbuild 就跳过构建，用已有的产物继续跑
 * （产物是随仓库发布的，所以正常情况本来就不需要重建）。
 */
let _esbuild = null;
async function getEsbuild() {
  if (_esbuild) return _esbuild;
  try {
    _esbuild = await import('esbuild');
    return _esbuild;
  } catch (e) {
    throw new Error(`缺少 esbuild（${e.code ?? e.message}）。安装：npm install --save-dev esbuild`);
  }
}

const APP = path.join(import.meta.dirname, '..');
const PUBLIC = path.join(APP, 'public');
const SHARED = path.join(APP, 'shared');

/**
 * 目标浏览器：**Chrome 77**。
 *
 * 为什么是 77 而不是"最近两个版本"：
 *   用户的手机不会跟着升级。Android 10 的老机器上，
 *   浏览器内核可能永远停在 77。**兼容目标要对着用户手里的设备，
 *   不是对着我们的开发机。**
 */
const TARGET = 'chrome77';

/**
 * 运行时补丁。
 *
 * ── 为什么现在是空的 ──
 *
 * 我一开始写了 5 个补丁（replaceAll / Array.at / structuredClone /
 * Object.hasOwn / findLast），理由是"esbuild 转不了 API 类，只能手写"。
 *
 * **但后来逐个核实源码，发现一个都没用到：**
 *     replaceAll       唯一的匹配是 `replaceAllProducts`（我们自己的函数名）
 *     Array.at         0 处
 *     structuredClone  0 处
 *     Object.hasOwn    0 处
 *     findLast         0 处
 *
 * 那 1.7 KB 是**死代码**。没被验证过的代码不该留在交付物里——
 * 它既不会被测试覆盖，又会让人以为"这些 API 我们用了"。
 * 所以删掉，只留一个空壳，供以后真的用到时再填。
 *
 * ── 以后要加的话 ──
 *
 * 判断标准：**旧内核（Chrome 77）没有、且我们在浏览器端真的调用了**。
 * 加完必须跑 `node tools/verify-legacy-compat.mjs`，
 * 它会检查"产物里用到的 API 是否都有补丁覆盖"。
 * 只写不验证的补丁等于没有。
 */
const POLYFILLS = {};

/** 需要补的运行时方法的名称清单（供校验用）。 */
export const POLYFILL_NAMES = Object.keys(POLYFILLS);

function polyfillCode() {
  const entries = Object.entries(POLYFILLS);
  if (!entries.length) {
    return `/* 旧浏览器运行时补丁 —— 目前为空。
 *
 * 曾经有 5 个（replaceAll / Array.at / structuredClone / Object.hasOwn / findLast），
 * 后来逐个核实发现**源码一个都没用到**，是死代码，已删除。
 * 加补丁的判断标准：旧内核没有、且浏览器端真的调用了。
 * 加完跑 tools/verify-legacy-compat.mjs 验证覆盖。 */
`;
  }
  const body = entries.map(([name, code]) => `  /* ${name} */${code}`).join('\n');
  return `/* 旧浏览器运行时补丁 —— Chrome 77 缺少、且我们真的调用了的方法。 */
(function () {
  'use strict';
${body}
})();
`;
}

/**
 * 把产物里的 import 路径从 `.mjs` 改成 `.js`。
 *
 * ⚠️ **这一步不能省。**
 *    esbuild 的 `transform()` 只做语法降级，**完全不管 import 路径**——
 *    产物里仍然写着 `import './syncdb.mjs'`。
 *    浏览器加载 app.js 后会去请求 `/syncdb.mjs`，拿到的是**没降级的源码**，
 *    于是又 SyntaxError，而且这次更难查（app.js 明明是好的）。
 *
 *    实测踩过：第一版构建出来的 app.js 第一行就是
 *    `import * as sync from "./syncdb.mjs";`
 *
 * 顺带把路径收敛成"从站点根算"的绝对路径，
 * 这样 `./../shared/catalog.mjs` 这种绕来绕去的写法也一并理顺成
 * `/shared/catalog.js`——它实际落在 public/shared/ 下。
 */
function rewriteImports(code) {
  return code.replace(
    /(from\s*|import\s*)(['"])([^'"]+)\.mjs\2/g,
    (full, kw, q, spec) => {
      let p = spec;
      // './../shared/catalog' → './shared/catalog'（shared 被放到 public/shared 下）
      p = p.replace(/^\.\/\.\.\/shared\//, './shared/');
      // '../shared/catalog' → './shared/catalog'
      p = p.replace(/^\.\.\/shared\//, './shared/');
      return `${kw}${q}${p}.js${q}`;
    },
  );
}

/** 降级一段 JS 源码。 */
async function lower(code, { minify = false, sourcefile = 'x.js' } = {}) {
  /**
   * 只做**语法**降级（`??` `?.` `||=` `&&=` → 旧写法）。
   *
   * ⚠️ 不要在这里配 `supported: { 'string-replace-all': false, ... }`。
   *    我第一版就是想"顺手告诉 esbuild 目标环境没有这些 API"，
   *    结果 esbuild 直接报 `"string-replace-all" is not a valid feature name`
   *    ——`supported` 只接受它能转换的特性名，API 类方法不在其中。
   *
   *    API 类（replaceAll / Array.at / structuredClone / Object.hasOwn / findLast）
   *    esbuild **本来就转不了**，靠的是下面生成的那个运行时补丁文件。
   */
  const esb = await getEsbuild();
  const r = await esb.transform(code, {
    target: TARGET,
    format: 'esm',
    loader: 'js',
    minify,
    sourcefile,
  });
  return rewriteImports(r.code);
}

/** 降级一个 HTML 文件里所有内联 <script>。 */
async function lowerHtml(html, name) {
  const parts = [];
  let last = 0;
  // 只处理没有 src 的 <script>（有 src 的是外链，单独降级）
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  let count = 0;
  while ((m = re.exec(html)) !== null) {
    const [full, attrs, body] = m;
    if (!body.trim()) continue;
    const isModule = /type\s*=\s*["']module["']/i.test(attrs);
    try {
      const esb = await getEsbuild();
      const lowered = await esb.transform(body, {
        target: TARGET,
        format: isModule ? 'esm' : 'iife',
        loader: 'js',
      });
      parts.push(html.slice(last, m.index));
      parts.push(`<script${attrs}>${lowered.code}</script>`);
      last = m.index + full.length;
      count++;
    } catch (e) {
      throw new Error(`${name} 里的内联脚本降级失败：${e.message}`);
    }
  }
  parts.push(html.slice(last));
  return { html: parts.join(''), count };
}

/**
 * 判断产物是不是比源码旧（或者压根不存在）。
 *
 * 用途：服务端启动时调一次，只在真的过期时才重建。
 * 这样"改了源码忘了构建"这个坑被自动堵上，同时不会每次启动都白跑一遍。
 */
async function isStale() {
  /**
   * ⚠️ **动态扫描目录，不要维护一份写死的文件清单。**
   *
   * 第一版这里是手写的 pairs 列表。后来加了 shared/csv.mjs，忘了同步加进来 ——
   * 后果是：改了 csv.mjs 之后 `isStale()` 认为产物是最新的、**不重建**，
   * 于是浏览器加载的还是旧的 csv.js。
   * 症状是"改了代码却没生效"，而且**不报任何错**，比报错难查得多。
   *
   * 现在改成：public 和 shared 下每个 .mjs 都要求有对应的 .js 产物，
   * 新增文件自动纳入判断。
   */
  const pairs = [];
  for (const dir of [PUBLIC, SHARED]) {
    for (const f of await fs.readdir(dir).catch(() => [])) {
      if (!f.endsWith('.mjs')) continue;
      const outDir = dir === PUBLIC ? PUBLIC : path.join(PUBLIC, 'shared');
      pairs.push([path.join(dir, f), path.join(outDir, f.replace(/\.mjs$/, '.js'))]);
    }
  }

  for (const [src, out] of pairs) {
    let s;
    let o;
    try {
      s = (await fs.stat(src)).mtimeMs;
    } catch { continue; }
    try {
      o = (await fs.stat(out)).mtimeMs;
    } catch { return true; }              // 产物不存在 → 要构建
    if (s > o) return true;               // 源码更新 → 要构建
  }
  /**
   * 构建工具自己也变了也要重建。
   * 否则会出现"改了降级规则、但产物还是按旧规则生成的"——
   * 这种不一致比不构建更糟，因为它看起来是新的。
   */
  try {
    const self = (await fs.stat(import.meta.filename)).mtimeMs;
    for (const out of ['app.js', 'polyfills.js']) {
      if (self > (await fs.stat(path.join(PUBLIC, out))).mtimeMs) return true;
    }
  } catch { return true; }
  return false;
}

/**
 * 构建一次。
 * @returns {Promise<Array<[string,string,number,number]>>} [来源, 产物, 原大小, 新大小]
 */
async function build() {
  const written = [];

  /* ---------- 1. 前端模块 ---------- */
  const mods = (await fs.readdir(PUBLIC)).filter((f) => f.endsWith('.mjs'));
  for (const f of mods) {
    const src = await fs.readFile(path.join(PUBLIC, f), 'utf-8');
    const out = await lower(src, { sourcefile: f });
    await fs.writeFile(path.join(PUBLIC, f.replace(/\.mjs$/, '.js')), out, 'utf-8');
    written.push([f, f.replace(/\.mjs$/, '.js'), src.length, out.length]);
  }

  /* ---------- 2. 共享模块（服务端与浏览器共用，浏览器端也要降级）---------- */
  /**
   * ⚠️ 这里要**遍历整个 shared 目录**，不能把文件名写死。
   *    第一版只处理 catalog.mjs；后来加了 csv.mjs（订单导出用）——
   *    浏览器直接 404，而症状是"点导出按钮没反应"，
   *    跟"少构建了一个文件"看起来毫无关系，极难对上。
   */
  await fs.mkdir(path.join(PUBLIC, 'shared'), { recursive: true });
  for (const f of (await fs.readdir(SHARED)).filter((x) => x.endsWith('.mjs'))) {
    const src = await fs.readFile(path.join(SHARED, f), 'utf-8');
    const out = await lower(src, { sourcefile: f });
    const dst = f.replace(/\.mjs$/, '.js');
    await fs.writeFile(path.join(PUBLIC, 'shared', dst), out, 'utf-8');
    written.push([`shared/${f}`, `public/shared/${dst}`, src.length, out.length]);
  }

  /* ---------- 3. 运行时补丁 ---------- */
  const pfCode = polyfillCode();
  await fs.writeFile(path.join(PUBLIC, 'polyfills.js'), pfCode, 'utf-8');
  written.push(['(生成)', 'polyfills.js', 0, pfCode.length]);

  /* ---------- 4. 内联脚本降级 ---------- */
  for (const f of (await fs.readdir(PUBLIC)).filter((x) => x.endsWith('.html'))) {
    const p = path.join(PUBLIC, f);
    const src = await fs.readFile(p, 'utf-8');
    const { html, count } = await lowerHtml(src, f);
    /**
     * 只在降级**确实改动了内容**时才写回。
     * 否则每次构建都重写 HTML 的时间戳，git 会一直显示"有改动"，
     * 真正需要 review 的改动就淹没在噪音里了。
     */
    if (count && html !== src) {
      await fs.writeFile(p, html, 'utf-8');
      written.push([f, f, src.length, html.length]);
    }
  }

  return written;
}

/**
 * 供服务端启动时调用：过期就重建。
 * @returns {Promise<{rebuilt:boolean, target?:string, files?:number, ms?:number}>}
 */
export async function buildIfStale() {
  if (!(await isStale())) return { rebuilt: false };
  const t0 = Date.now();
  const files = await build();
  return { rebuilt: true, target: TARGET, files: files.length, ms: Date.now() - t0 };
}

async function main() {
  const started = Date.now();
  console.log('');
  console.log(`  降级目标：${TARGET}（旧安卓机上浏览器内核的真实水平）`);
  console.log('  ────────────────────────────────────────');

  const written = await build();
  for (const [from, to, a, b] of written) {
    const size = a ? `${(a / 1024).toFixed(1)} KB → ${(b / 1024).toFixed(1)} KB` : `${(b / 1024).toFixed(1)} KB`;
    console.log(`  ✓ ${from.padEnd(26)} → ${to.padEnd(26)} ${size}`);
  }

  console.log('');
  console.log(`  完成，耗时 ${Date.now() - started} ms`);
  console.log('');
}

// 直接运行才执行 main；被服务端 import 时只导出 buildIfStale
if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  await main();
}
