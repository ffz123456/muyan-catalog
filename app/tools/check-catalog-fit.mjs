/**
 * 静态核算：画册卡片塞得进 A4 吗（**不开浏览器**）
 *
 * 为什么保留这个"不算真"的检查：
 *   它是毫秒级的，改 PER_PAGE / 页边距 / 卡片结构时能**立刻**发现
 *   "卡片比 A4 还高"这种硬伤，不用等开浏览器。
 *   真正的实测在 verify-multi-image（逐页量高度）和
 *   check-catalog-truncation（验证截断与成交信息保护）。
 *
 * ── 这个脚本踩过两次坑，都记在这里 ──
 *
 * ① **不要自己抄一份尺寸**。第一版把 CSS 里的 mm 值手抄进常量表，
 *    还写了句"改了 CSS 必须同步改这里"——那等于给自己埋了个雷：
 *    后来卡片行高改成固定值、页眉页脚也变了，这里还在按旧数字算，
 *    得出的结论和实际完全对不上。现在**直接从 catalog.mjs 的 CSS 里读**。
 *
 * ② **别按纸面 mm 推算**。第一版按"每行 (240−7)/2 = 116.5mm"算，
 *    实测每行只能放 113.7mm —— 字体的实际行高、边框、margin 塌陷
 *    都和纸面计算不一样，差出 7px 就够让整页溢出了。
 *    所以这里只做**粗筛**（数量级对不对），精确结论一律以实测为准。
 */
import { A4, PER_PAGE } from '../shared/catalog.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const CSS_SRC = path.join(import.meta.dirname, '..', 'shared', 'catalog.mjs');
const css = await fs.readFile(CSS_SRC, 'utf-8');

/** 从 CSS 文本里取某个选择器的某个属性的 mm 值。 */
function mmOf(selector, prop) {
  const block = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css);
  if (!block) return null;
  const m = new RegExp(`${prop}\\s*:\\s*([\\d.]+)mm`).exec(block[1]);
  return m ? Number(m[1]) : null;
}

const S = {
  pagePadY: mmOf('.page', 'padding'),           // "16mm 15mm" 取不到，下面单独处理
  gridRowGap: mmOf('.grid', 'gap'),
  rowHeight: mmOf('.grid', 'grid-auto-rows'),
  cardImg: mmOf('.card-img', 'height'),
  thumbs: mmOf('.card-thumbs', 'height'),
};

// .page 的 padding 是 "16mm 15mm" 两值写法，粗暴取第一个 mm 数字
const pagePad = /\.page\s*\{[^}]*padding:\s*([\d.]+)mm/.exec(css);
S.pagePadY = pagePad ? Number(pagePad[1]) : null;

console.log('');
console.log('  画册版面核算（值直接读自 shared/catalog.mjs 的 CSS）');
console.log('  ────────────────────────────────────────');

const missing = Object.entries(S).filter(([, v]) => v == null).map(([k]) => k);
if (missing.length) {
  console.log(`  ✗ 从 CSS 里读不到这些值：${missing.join('、')}`);
  console.log('    说明 CSS 的选择器或写法变了，这个脚本要跟着改——');
  console.log('    **不要改成手抄常量**，那会变成两份互相矛盾的真相。');
  process.exit(1);
}

console.log(`  A4：${A4.W_MM} × ${A4.H_MM}mm`);
console.log(`  .page 上下页边距：${S.pagePadY}mm × 2 = ${S.pagePadY * 2}mm`);
console.log(`  .grid 行高：${S.rowHeight}mm    行间距：${S.gridRowGap}mm`);
console.log(`  .card-img 高：${S.cardImg}mm    小图条高：${S.thumbs}mm`);
console.log('');

const rows = Math.ceil(PER_PAGE / 2);
const gridNeed = rows * S.rowHeight + (rows - 1) * S.gridRowGap;

/**
 * 网格可用高度（mm）。
 *
 * ⚠️ **不要在这里叠加"页边距 + 页眉 + 页脚"来推算。**
 *    我试过三次，每次都算错，而且错法还不一样：
 *      · 第一版按纸面估页眉页脚 25mm → 实际 62.7mm
 *      · 第二版改成实测 62.7mm，但没注意那 62.7 里**已经含了页边距**
 *        （页边距 60+60px 就占 31.75mm），于是页边距被算了两遍，
 *        推算出"负余量"的假警报 —— 而同一份 CSS 在浏览器里实测是好的。
 *
 *    结论：这个数**也是一个实测值**，由 tools/measure-page-parts.mjs 给出
 *    （它会打印"留给 .grid 的 XXXpx"）。改了页面结构就重跑那个工具，
 *    把这里更新掉 —— 别自己推。
 *
 *    当前 234.4mm 对应的实测：A4 1123px − 固定占用 237px = 886px。
 */
const GRID_BUDGET_MM = 234.4;

console.log(`  每页 ${PER_PAGE} 个产品 → ${rows} 行`);
console.log(`  网格需要：${rows} × ${S.rowHeight} + ${rows - 1} × ${S.gridRowGap} = ${gridNeed.toFixed(1)}mm`);
console.log(`  网格可用：${GRID_BUDGET_MM}mm（A4 ${A4.H_MM}mm 去掉页边距与页眉页脚，由 measure-page-parts 实测）`);
console.log('');

let bad = 0;
if (gridNeed > GRID_BUDGET_MM) {
  console.log(`  ✗ 网格需要 ${gridNeed.toFixed(1)}mm > 可用 ${GRID_BUDGET_MM}mm —— 会被撑破`);
  console.log('    调整方向：减小 grid-auto-rows，或减少 PER_PAGE');
  console.log('    改完重新量：node tools/measure-page-parts.mjs');
  bad++;
} else {
  console.log(`  ✓ 网格需要 ${gridNeed.toFixed(1)}mm ≤ 可用 ${GRID_BUDGET_MM}mm（余量 ${(GRID_BUDGET_MM - gridNeed).toFixed(1)}mm）`);
}

console.log('');
console.log('  单张卡片内容高度（供参考）：');
console.log(`    单图：${S.cardImg}mm（图）  多图：${S.cardImg} + ${S.thumbs}mm（图+小图条）`);
const fits = S.cardImg + S.thumbs <= S.rowHeight;
console.log(`    ${fits ? '✓' : '✗'} 图和（含小图条）不超过行高 ${S.rowHeight}mm`
  + (fits ? `，文字还有 ${(S.rowHeight - S.cardImg - S.thumbs).toFixed(1)}mm` : ''));
if (!fits) bad++;

console.log('');
console.log('  ⚠️ 这个脚本只做粗筛。**精确结论以实测为准**：');
console.log('     node tools/verify-multi-image.mjs      逐页量高度');
console.log('     node tools/measure-page-parts.mjs      量每部分实际占多高');
console.log('     node tools/find-a4-limit.mjs           找出文本长度的临界点');
console.log('');

process.exitCode = bad ? 1 : 0;
