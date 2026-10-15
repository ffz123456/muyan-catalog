/**
 * 量一页画册里各部分实际占多高
 *
 * 用途：A4 溢出时报"余量 -7px"这种数字，得知道**是哪一块多占了**，
 * 才能改对地方。靠估算（我按 mm 手算过，算出来正好 240mm）会错，
 * 因为字体的实际行高、边框、margin 塌陷都和纸面计算不一样。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderCatalogHtml } from '../server/render-catalog.mjs';
import { A4, PER_PAGE } from '../shared/catalog.mjs';
import { findBrowserExecutable } from '../server/browser.mjs';
import { DATA_DIR } from '../server/datadir.mjs';

const puppeteer = (await import('puppeteer-core')).default;
const raw = await fs.readFile(path.join(DATA_DIR, 'products.json'), 'utf-8');
const products = JSON.parse(raw).products.slice(0, PER_PAGE);

const html = await renderCatalogHtml({
  products,
  settings: { companyName: '测量', tagline: 'x', contact: '1', validityDays: 30 },
  groupByCategory: false,
});

const browser = await puppeteer.launch({
  headless: true,
  executablePath: findBrowserExecutable(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: A4.W_PX, height: 6000 });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);

const m = await page.evaluate(() => {
  /**
   * ⚠️ 要测的是**产品页**，不是封面页。
   *    第一版直接取 `section.page` 的第一个，结果拿到封面（没有 .head/.grid），
   *    报出 "Cannot read properties of null"。封面和产品页的结构不一样。
   */
  const pg = Array.from(document.querySelectorAll('section.page')).find((el) => el.querySelector('.grid'));
  if (!pg) return { error: '没有找到带 .grid 的产品页' };
  const cs = getComputedStyle(pg);
  const box = (sel) => {
    const el = pg.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      h: Math.round(r.height),
      mt: Math.round(parseFloat(s.marginTop)),
      mb: Math.round(parseFloat(s.marginBottom)),
      pt: Math.round(parseFloat(s.paddingTop)),
      pb: Math.round(parseFloat(s.paddingBottom)),
    };
  };
  const grid = pg.querySelector('.grid');
  const gcs = grid ? getComputedStyle(grid) : null;
  return {
    pageH: Math.round(pg.getBoundingClientRect().height),
    padTop: Math.round(parseFloat(cs.paddingTop)),
    padBottom: Math.round(parseFloat(cs.paddingBottom)),
    head: box('.head'),
    grid: grid ? {
      h: Math.round(grid.getBoundingClientRect().height),
      rows: gcs.gridAutoRows,
      rowGap: gcs.rowGap,
      mb: Math.round(parseFloat(gcs.marginBottom)),
    } : null,
    cards: Array.from(pg.querySelectorAll('.card')).map((c) => Math.round(c.getBoundingClientRect().height)),
    foot: box('.foot'),
  };
});

await browser.close();

if (m.error) {
  console.log('  ✗ ' + m.error);
  process.exit(1);
}

const mm = (px) => (px / 96 * 25.4).toFixed(1);
console.log('');
console.log(`  A4 = ${A4.H_PX}px (${A4.H_MM}mm)   每页 ${PER_PAGE} 个产品`);
console.log('  ────────────────────────────────────────');
console.log(`  页面实际总高   ${String(m.pageH).padStart(5)}px   ${mm(m.pageH).padStart(6)}mm`);
console.log(`  padding 上下   ${String(m.padTop).padStart(5)} / ${m.padBottom}px`);
console.log(`  .head          ${String(m.head.h).padStart(5)}px   +marginBottom ${m.head.mb}px   (${mm(m.head.h + m.head.mb)}mm)`);
console.log(`  .grid          ${String(m.grid.h).padStart(5)}px   行高 ${m.grid.rows}  行间距 ${m.grid.rowGap}`);
console.log(`  卡片高度       ${m.cards.join(', ')}`);
console.log(`  .foot          ${String(m.foot.h).padStart(5)}px   +paddingTop ${m.foot.pt}px   (${mm(m.foot.h + m.foot.pt)}mm)`);
console.log('');
const fixed = m.padTop + m.padBottom + m.head.h + m.head.mb + m.foot.h + m.foot.pt;
const room = A4.H_PX - fixed;
const gapPx = 7 / 25.4 * 96;
const maxRow = (room - gapPx) / 2;
console.log(`  固定占用（页边距+页眉+页脚）  ${fixed}px   (${mm(fixed)}mm)`);
console.log(`  留给 .grid 的                 ${room}px   (${mm(room)}mm)`);
console.log(`  当前 .grid 实际占             ${m.grid.h}px   (${mm(m.grid.h)}mm)`);
console.log('');
console.log(`  → 两行卡片 + ${mm(gapPx)}mm 间距，每行最多可占 ${maxRow.toFixed(1)}px = ${mm(maxRow)}mm`);
console.log(`    CSS 里 grid-auto-rows 应设成 ≤ ${mm(maxRow)}mm（建议留 0.5mm 余量）`);
console.log('');

const current = 113 / 25.4 * 96;
if (m.grid.h > room) {
  console.log(`  ✗ 网格超高 ${m.grid.h - room}px —— 打印会丢内容`);
  process.exitCode = 1;
} else if (current > maxRow) {
  console.log(`  ✗ CSS 里设的 113mm (${current.toFixed(0)}px) 超过上限 ${maxRow.toFixed(0)}px`);
  process.exitCode = 1;
} else {
  console.log(`  ✓ 当前设置（113mm）在安全范围内，余量 ${(maxRow - current).toFixed(1)}px`);
}
console.log('');
