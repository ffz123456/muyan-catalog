/**
 * 画册分页检查：不同产品数量下，末页会不会多出空白行
 *
 * 为什么专门查这个：
 *   `.grid` 的行高是**固定的**（113mm，见 shared/catalog.mjs 里的推导）。
 *   固定行高的副作用是：如果一页只有 1 个产品，网格可能仍然占掉 2 行的高度，
 *   看起来就是"末页下面一大片空白"。
 *
 *   这在偶数个产品时看不出来（每页都是满的），
 *   只有**奇数个**（比如 5 款、7 款）才会暴露 —— 所以要专门用这些数量测。
 *
 * 判据：末页高度应该仍然等于 A4（页面本身是 min-height:297mm），
 *       但**网格的实际高度**应该只占它需要的那几行。
 */
import { renderCatalogHtml, A4, PER_PAGE } from '../server/render-catalog.mjs';
import { findBrowserExecutable } from '../server/browser.mjs';

const puppeteer = (await import('puppeteer-core')).default;
const launchOptions = {
  headless: true,
  executablePath: findBrowserExecutable(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
};

const settings = { companyName: '分页测试', tagline: 'x', contact: '138-0000-0000', validityDays: 30 };

/** 造 N 款产品（不带图，免得图片影响高度判断）。 */
const make = (n) => Array.from({ length: n }, (_, i) => ({
  id: `pg${i}`,
  name: `测试产品 ${i + 1} 号`,
  category: '客厅 · 沙发',
  specs: '尺寸 2200×950×820mm',
  highlights: '现货/质保',
  price: 4380,
  stockStatus: '现货',
  images: [],
}));

const browser = await puppeteer.launch(launchOptions);
console.log('');
console.log(`  A4 = ${A4.H_PX}px，每页 ${PER_PAGE} 个产品`);
console.log('  ────────────────────────────────────────');
console.log('  产品数   页数   末页网格高度   末页卡片数   说明');

let bad = 0;
for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13]) {
  const html = await renderCatalogHtml({ products: make(n), settings, groupByCategory: false });

  const page = await browser.newPage();
  await page.setViewport({ width: A4.W_PX, height: 6000 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  const r = await page.evaluate(() => {
    // 只看产品页（有 .grid 的）
    const pages = Array.from(document.querySelectorAll('section.page')).filter((el) => el.querySelector('.grid'));
    const last = pages[pages.length - 1];
    const grid = last.querySelector('.grid');
    const cards = last.querySelectorAll('.card');
    const gcs = getComputedStyle(grid);
    return {
      pageCount: pages.length,
      gridH: Math.round(grid.getBoundingClientRect().height),
      cardCount: cards.length,
      rows: gcs.gridTemplateRows.split(' ').length,
    };
  });
  await page.close();

  const expectRows = Math.ceil(r.cardCount / 2);
  const rowH = 113 / 25.4 * 96;
  const expectH = expectRows * rowH + (expectRows - 1) * (7 / 25.4 * 96);
  const extra = r.gridH - expectH;
  const ok = extra < 2;            // 允许 1px 的舍入误差

  console.log(`  ${String(n).padStart(4)}   ${String(r.pageCount).padStart(4)}   `
    + `${String(r.gridH).padStart(8)}px   ${String(r.cardCount).padStart(6)}      `
    + `${ok ? '✓' : '✗ 多占 ' + Math.round(extra) + 'px 空白'}`);
  if (!ok) bad++;
}

await browser.close();

console.log('');
console.log('  ────────────────────────────────────────');
if (bad) {
  console.log(`  ✗ ${bad} 种产品数量下末页有多余空白行`);
  console.log('    原因多半是 grid-auto-rows 固定后，空网格仍然占位。');
  console.log('    修法：末页网格用 grid-auto-rows:auto，或按实际行数设高度。');
  process.exitCode = 1;
} else {
  console.log('  ✓ 各种产品数量下末页都没有多余空白行');
}
console.log('');
