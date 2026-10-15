/**
 * 验证前端产物在**旧浏览器**上能跑
 *
 * ── 为什么必须有这个检查 ──
 *
 * 实测踩到的真事故：旧手机（OPPO A3，Android 10）上的 Edge 用的是
 * **自己打包的 Chromium 77**，不支持 `??`（空值合并，要 Chrome 80+）。
 * 结果 `app.mjs` 的**解析**就失败，一行都不执行。现象是：
 *   页面骨架在、账号下拉是空的、一个接口都不调、什么都点不动。
 *
 * 不报错、不白屏，只是"看起来正常但什么都没发生"——极难排查。
 * 所以必须由 CI 兜住，不能靠写代码时小心。
 *
 * 这个检查做三件事：
 *   1. 产物必须存在（构建跑过了）
 *   2. 产物里不能有旧内核不认的**语法**
 *   3. 产物里不能有旧内核没有的 **API**（除非补丁文件补上了）
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const APP = path.join(import.meta.dirname, '..');
const PUBLIC = path.join(APP, 'public');

let pass = 0;
const fails = [];
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${label}${detail ? '  ' + detail : ''}`); }
  else { fails.push(`${label}${detail ? '  — ' + detail : ''}`); console.log(`  ✗ ${label}${detail ? '  ' + detail : ''}`); }
}

console.log('');
console.log('  旧浏览器兼容性（目标 Chrome 77）');
console.log('  ────────────────────────────────────────');

/* ---------- 1. 产物存在 ---------- */
console.log('\n  【1】降级产物');
const OUT = ['app.js', 'backend.js', 'localdb.js', 'syncdb.js', 'polyfills.js', 'shared/catalog.js'];
for (const f of OUT) {
  let size = 0;
  try { size = (await fs.stat(path.join(PUBLIC, f))).size; } catch { /* 不存在 */ }
  check(f, size > 0, size ? `${(size / 1024).toFixed(1)} KB` : '缺失（跑 node tools/build-web.mjs）');
}

/* ---------- 2. 语法 ---------- */
console.log('\n  【2】产物里不能有旧内核不认的语法');
/**
 * 这些在 Chrome 77 上都是**语法错误**（不是"行为不同"，是整个文件解析失败）。
 *   ??  空值合并   Chrome 80+
 *   ?.  可选链     Chrome 80+
 *   ||= &&= ??=   逻辑赋值  Chrome 85+
 */
const SYNTAX = [
  [/\?\?(?![?=])/, '??  空值合并'],
  [/\?\./, '?.  可选链'],
  [/\|\|=/, '||= 逻辑赋值'],
  [/&&=/, '&&= 逻辑赋值'],
  [/\?\?=/, '??= 逻辑赋值'],
];

for (const f of OUT) {
  let code = '';
  try { code = await fs.readFile(path.join(PUBLIC, f), 'utf-8'); } catch { continue; }
  const hit = SYNTAX.filter(([re]) => re.test(code)).map(([, label]) => label);
  check(f, hit.length === 0, hit.length ? `还有 ${hit.join('、')}` : '干净');
}

/* ---------- 3. API ---------- */
console.log('\n  【3】旧内核没有的 API 必须被补丁覆盖');
/**
 * 注意：注释里提到这些方法名是允许的（esbuild 注释里就写了 'replaceAll'），
 * 所以检查的是**调用形式**（`xxx.replaceAll(` / `Array.at(` 等），不是裸字符串。
 */
const API = [
  [/\.replaceAll\s*\(/, 'String.replaceAll'],
  [/\.at\s*\(/, 'Array.at'],
  [/\bstructuredClone\s*\(/, 'structuredClone'],
  [/\bObject\.hasOwn\s*\(/, 'Object.hasOwn'],
  [/\.findLast\s*\(/, 'Array.findLast'],
];

let polyfills = '';
try { polyfills = await fs.readFile(path.join(PUBLIC, 'polyfills.js'), 'utf-8'); } catch { /* 缺了就下面报 */ }

for (const [re, label] of API) {
  const usedIn = [];
  for (const f of OUT) {
    if (f === 'polyfills.js') continue;
    let code = '';
    try { code = await fs.readFile(path.join(PUBLIC, f), 'utf-8'); } catch { continue; }
    // 去掉注释再判断，避免把说明文字当成真实调用
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (re.test(stripped)) usedIn.push(f);
  }
  if (!usedIn.length) {
    check(label, true, '产物里没用到');
  } else {
    // 用到了 → 补丁里必须有对应实现
    const covered = polyfills.includes(label.split('.')[0]) || polyfills.includes(label);
    check(label, covered, covered ? `补丁已覆盖（${usedIn.join('、')} 用到）` : `补丁缺失，${usedIn.join('、')} 用到`);
  }
}

/* ---------- 4. HTML 加载顺序 ---------- */
console.log('\n  【4】index.html 的加载顺序');
let html = '';
try { html = await fs.readFile(path.join(PUBLIC, 'index.html'), 'utf-8'); } catch { /* ignore */ }

const iPoly = html.indexOf('/polyfills.js');
const iPouch = html.indexOf('pouchdb.min.js');
const iApp = html.indexOf('/app.js');
const iMjs = html.indexOf('/app.mjs');

check('加载的是降级产物 app.js（不是 app.mjs）', iApp >= 0 && iMjs < 0,
  iMjs >= 0 ? '页面还在加载未降级的 app.mjs' : '');
check('polyfills.js 最先加载', iPoly >= 0 && iPoly < iPouch && iPoly < iApp,
  iPoly < 0 ? '没引入' : `顺序 ${iPoly} < ${iPouch} < ${iApp}`);
check('登录闸门默认不隐藏（失败时要锁住，不能裸露界面）',
  !/id="loginGate"[^>]*\shidden/.test(html),
  /id="loginGate"[^>]*\shidden/.test(html) ? 'loginGate 带 hidden，JS 一失败界面就裸露' : '');

/* ---------- 汇总 ---------- */
console.log('');
console.log('  ────────────────────────────────────────');
if (fails.length) {
  console.log(`  ✗ ${fails.length} 项未通过：`);
  fails.forEach((f) => console.log(`      ${f}`));
  console.log('');
  console.log('  旧手机上会表现为「页面正常显示但什么都点不动」，请务必修掉。');
  process.exitCode = 1;
} else {
  console.log(`  ✓ 全部 ${pass} 项通过 —— 产物可以在 Chrome 77 上跑`);
  console.log('');
}
