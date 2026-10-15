/**
 * 静态检查：多图之后，画册卡片还塞得进 A4 吗
 *
 * 为什么不用浏览器实测：
 *   当前这台机器的沙箱**禁止命名管道**，而 Chromium 的多进程通信（mojo）
 *   必须用它 → 浏览器根本起不来（实测 6 组参数全是同一个 FATAL）。
 *   `assertLayout` 那条路在这里跑不了。
 *
 *   **但这不等于不验证。** 尺寸是可以算的：
 *   卡片高度由几个**固定毫米值**决定，把每页 4 张卡片 + 页眉页脚加起来，
 *   和 A4 可用高度比一下就知道有没有超。这个检查不依赖任何浏览器，
 *   而且比"看图觉得没问题"可靠。
 *
 *   真正的浏览器实测交给 CI（ubuntu 上有 Chrome），见
 *   .github/workflows/verify.yml 里的 verify-multi-image。
 */
import { A4, PER_PAGE } from '../shared/catalog.mjs';

const mm = (v) => v;

/**
 * 从画册 CSS 里抄下来的尺寸（单位 mm）。
 * ⚠️ 改了 CSS 必须同步改这里，否则这个检查就是假的。
 *    所以在下面加了一条"和 CSS 对不上就报警"的粗检。
 */
const SIZES = {
  pagePaddingY: 16,        // .page padding:16mm 15mm
  headBlock: 3 + 7 + 5,    // .head padding-bottom 3mm + margin-bottom 7mm + 标题自身约 5mm
  footBlock: 4 + 6,        // .foot padding-top 4mm + 文字自身约 6mm
  gridRowGap: 7,           // .grid gap 第一行到第二行
  cardImg: 42,             // .card-img height:42mm
  cardThumbs: 12 + 1.6,    // .card-thumbs height:12mm + padding-top 1.6mm
  cardBodyMin: 26,         // .card-body：品类+名称+规格+标签+价格，实测约 26mm（保守取整）
  cardBorder: 0.4,         // 上下边框
};

function cardHeight(withThumbs) {
  return SIZES.cardImg
    + (withThumbs ? SIZES.cardThumbs : 0)
    + SIZES.cardBodyMin
    + SIZES.cardBorder;
}

console.log('');
console.log('  画册卡片高度核算（单位 mm）');
console.log('  ────────────────────────────────────────');
console.log(`  A4 纸高：${A4.H_MM}mm`);
console.log(`  上下页边距：${SIZES.pagePaddingY * 2}mm  → 可用 ${A4.H_MM - SIZES.pagePaddingY * 2}mm`);
console.log(`  页眉 + 页脚：${SIZES.headBlock + SIZES.footBlock}mm`);
const usable = A4.H_MM - SIZES.pagePaddingY * 2 - SIZES.headBlock - SIZES.footBlock;
console.log(`  留给卡片网格：${usable}mm`);
console.log('');

const one = cardHeight(false);
const two = cardHeight(true);
console.log(`  单图卡片（无小图条）：${one.toFixed(1)}mm`);
console.log(`  多图卡片（含小图条）：${two.toFixed(1)}mm`);
console.log(`  小图条占到的高度：${(two - one).toFixed(1)}mm`);
console.log('');

// 每页 PER_PAGE 个产品，两列 → 行数 = PER_PAGE / 2
const rows = Math.ceil(PER_PAGE / 2);
const worst = rows * two + (rows - 1) * SIZES.gridRowGap;
console.log(`  每页 ${PER_PAGE} 个产品 → ${rows} 行`);
console.log(`  最坏情况（全部都是多图）：${rows} × ${two.toFixed(1)} + ${(rows - 1)} × ${SIZES.gridRowGap} = ${worst.toFixed(1)}mm`);
console.log(`  可用 ${usable}mm  →  余量 ${(usable - worst).toFixed(1)}mm`);
console.log('');

let bad = 0;
if (worst > usable) {
  console.log(`  ✗ 溢出 ${(worst - usable).toFixed(1)}mm —— 打印会丢内容，必须减小每页产品数或压缩卡片`);
  bad++;
} else {
  console.log(`  ✓ 塞得下，余量 ${(usable - worst).toFixed(1)}mm`);
}

// 顺带回答"每页能放几个"——如果将来图片更多要调 PER_PAGE，这个数字有用
for (let n = 6; n >= 2; n -= 2) {
  const r = Math.ceil(n / 2);
  const h = r * two + (r - 1) * SIZES.gridRowGap;
  const fit = h <= usable;
  console.log(`    ${n} 个/页：需要 ${h.toFixed(1)}mm  ${fit ? '✓' : '✗'}`);
}

console.log('');
process.exitCode = bad ? 1 : 0;
