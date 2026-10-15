/**
 * 验证 A4 溢出检查**真的能测出溢出**
 *
 * 背景：`assertLayout` 长期报"每页 1123px、余量 0px、全部通过"。
 *   而 297mm 在 96dpi 下正好 = 1122.5px，所以这个数字**可能**是页面被
 *   `min-height` 撑到的下限，也可能是被视口卡住的假象。
 *
 *   "看起来一直通过"的检查最危险——它不报错，但也没在检查。
 *   所以必须做**反向测试**：故意塞进远超 A4 的内容，
 *   看它会不会报溢出。会报才说明这个断言是活的。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderCatalogHtml, assertLayout, A4 } from '../server/render-catalog.mjs';
import { findBrowserExecutable } from '../server/browser.mjs';
import { DATA_DIR } from '../server/datadir.mjs';

const exe = findBrowserExecutable();
const puppeteer = (await import('puppeteer-core')).default;
const launchOptions = { headless: true, executablePath: exe, args: ['--no-sandbox', '--disable-dev-shm-usage'] };

const raw = await fs.readFile(path.join(DATA_DIR, 'products.json'), 'utf-8');
const products = JSON.parse(raw).products;
const settings = { companyName: '林氏家居', tagline: '测试', contact: '138', validityDays: 30 };

/** 量一次，返回 {ok, pages} */
async function measure(label, prods) {
  const html = await renderCatalogHtml({ products: prods, settings, groupByCategory: false });
  const r = await assertLayout(html, puppeteer, { launchOptions });
  const tallest = r.pages.reduce((a, b) => (b.heightPx > a.heightPx ? b : a), r.pages[0]);
  console.log(`  ${r.ok ? '✓' : '✗'} ${label}`);
  console.log(`      ${r.pages.length} 页，最高 ${tallest.heightPx}px / A4 ${A4.H_PX}px，余量 ${A4.H_PX - tallest.heightPx}px`);
  return r;
}

console.log('');
console.log(`  A4 基准：${A4.H_MM}mm = ${A4.H_PX}px，每页 ${(await import('../shared/catalog.mjs')).PER_PAGE} 个产品`);
console.log('  ────────────────────────────────────────');

/* ---------- 1. 正常数据 ---------- */
console.log('\n  【对照】正常数据');
const normal = await measure(`正常：${products.length} 款产品`, products);

/* ---------- 2. 故意塞爆：超长规格 + 超长名称 ---------- */
console.log('\n  【反向测试】故意塞进远超 A4 的内容（应该报溢出）');
const bloated = products.map((p) => ({
  ...p,
  name: '超长产品名称'.repeat(6),
  specs: '尺寸 2000×900×800mm，材质说明'.repeat(12),
  highlights: Array.from({ length: 24 }, (_, i) => `卖点${i}`).join('/'),
}));
const over = await measure('塞爆：超长名称+规格+24 个卖点', bloated);

/* ---------- 3. 结论 ---------- */
console.log('');
console.log('  ────────────────────────────────────────');
if (!over.ok) {
  console.log('  ✓ 反向测试通过：塞爆时确实报了溢出 —— 这个断言是「活」的，有检测能力');
} else {
  console.log('  ✗ 反向测试失败：塞爆了还报通过 —— 这个断言是「死」的，测不出问题');
  console.log('    说明高度测量仍然被什么东西卡住了，必须继续查');
  process.exitCode = 1;
}

console.log('');
console.log(`  正常数据的真实结论：${normal.ok ? '3 页都在 A4 内' : '有页溢出，需要调整排版'}`);
console.log('');
