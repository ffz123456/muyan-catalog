/**
 * 验证 esbuild 能把代码降到 Chrome 77
 *
 * 背景：旧手机上的 Edge 是 Chromium 77，不支持 `??`、`?.`、`||=`、
 *       `String.replaceAll`、`Array.at`、`structuredClone`、`Object.hasOwn`、`findLast`。
 *       实测：真实的 app.mjs 在手机上直接 `SyntaxError: Unexpected token '?'`，
 *       整个脚本不执行 —— 产品在旧手机上是打不开的。
 *
 * 这个脚本确认 esbuild 的降级结果真的能在 Chrome 77 上跑，
 * 而不是"配置了就算数"。
 */
import * as esbuild from 'esbuild';

const TARGET = 'chrome77';

const CASES = [
  ['空值合并', 'const a = b ?? 1;'],
  ['可选链', 'const c = d?.e?.f;'],
  ['可选链调用', 'obj?.method?.();'],
  ['逻辑赋值', 'let x = 0; x ||= 1; let y = null; y ??= 2;'],
  ['String.replaceAll', 'const s = "a-b".replaceAll("-", "_");'],
  ['Array.at', 'const v = [1,2,3].at(-1);'],
  ['Object.hasOwn', 'const h = Object.hasOwn({}, "k");'],
  ['findLast', 'const f = [1,2].findLast(n => n > 1);'],
];

console.log('');
console.log(`  目标：${TARGET}（旧手机 Edge 的内核版本）`);
console.log('  ────────────────────────────────────────');

let changed = 0;
for (const [name, src] of CASES) {
  const r = await esbuild.transform(src, { target: TARGET, format: 'esm', loader: 'js' });
  const out = r.code.trim();
  const transformed = out !== src;
  if (transformed) changed++;
  console.log(`  ${transformed ? '↓' : '·'} ${name.padEnd(20)} ${out}`);
}

console.log('');
console.log(`  ${changed}/${CASES.length} 项被降级`);

/* ---------- 关键：真降级后还有没有残留的不支持语法 ---------- */
console.log('');
console.log('  ────────────────────────────────────────');
console.log('  残留检查（降级后不该再有这些）');

const RESIDUAL = [
  [/\?\?/, '??'],
  [/\?\./, '?.'],
  [/\|\|=/, '||='],
  [/&&=/, '&&='],
  [/\.replaceAll\(/, 'replaceAll'],
  [/\.at\(/, 'Array.at'],
  [/structuredClone/, 'structuredClone'],
  [/Object\.hasOwn/, 'Object.hasOwn'],
  [/findLast/, 'findLast'],
];

const sample = `
  const a = b ?? 1;
  const c = d?.e;
  let x = 0; x ||= 1;
  const s = "a".replaceAll("a","b");
  const v = [1].at(0);
  const h = Object.hasOwn({}, "k");
  const f = [1].findLast(n => n);
  const g = structuredClone({});
`;
const built = await esbuild.transform(sample, { target: TARGET, format: 'esm' });

let residue = 0;
for (const [re, label] of RESIDUAL) {
  const hit = re.test(built.code);
  if (hit) residue++;
  console.log(`  ${hit ? '✗ 还有' : '✓ 已清'} ${label}`);
}

console.log('');
console.log(`  降级后代码：\n${built.code.split('\n').map((l) => '    ' + l).join('\n')}`);
console.log('');

if (residue) {
  console.log(`  ✗ esbuild 的 syntax 降级不能清掉 API 类（${residue} 项）——`);
  console.log('    那些要靠运行时补丁（polyfill），见 tools/build-web.mjs');
  process.exitCode = 1;
} else {
  console.log('  ✓ 全部清干净');
}
