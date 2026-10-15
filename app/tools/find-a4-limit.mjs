/**
 * 找出画册在**真实文本长度**下的临界点
 *
 * 背景：check-a4-detects-overflow 用的是极端值（名称重复 6 遍、24 个卖点），
 * 那只能证明断言是活的。但它回答不了实际关心的问题：
 * **"我的产品名写到多长、规格写到多长，画册才会破？"**
 *
 * 这个脚本递进地加长名称/规格/卖点，量出每一档的实际高度，
 * 给出"安全线"在哪。
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
const base = JSON.parse(raw).products;
const settings = { companyName: '林氏家居', tagline: '临界点测试', contact: '138', validityDays: 30 };

/** 用一份产品做 8 款，保证每页 4 个、共 2 行 */
function makeSet({ nameLen, specLen, tags }) {
  return Array.from({ length: 8 }, (_, i) => ({
    id: `t${i}`,
    name: '沙发'.repeat(Math.ceil(nameLen / 2)).slice(0, nameLen) + (nameLen > 2 ? '' : ''),
    category: '客厅 · 沙发',
    specs: '尺寸 2200×950×820mm '.repeat(20).slice(0, specLen),
    highlights: Array.from({ length: tags }, (_, k) => `卖点${k + 1}`).join('/'),
    price: 4380,
    stockStatus: '现货',
    images: base[i % base.length].images ?? [],
  }));
}

async function measure(label, opts) {
  const prods = makeSet(opts);
  const html = await renderCatalogHtml({ products: prods, settings, groupByCategory: false });
  const r = await assertLayout(html, puppeteer, { launchOptions });
  const tallest = r.pages.reduce((a, b) => (b.heightPx > a.heightPx ? b : a), r.pages[0]);
  const margin = A4.H_PX - tallest.heightPx;
  console.log(`  ${r.ok ? '✓' : '✗'} ${label.padEnd(44)} ${String(tallest.heightPx).padStart(5)}px  余量 ${String(margin).padStart(5)}px`);
  return { ok: r.ok, margin };
}

console.log('');
console.log(`  A4 = ${A4.H_PX}px，每页 4 个产品（2 行）`);
console.log('  ────────────────────────────────────────');

console.log('\n  【名称长度】规格 40 字，无卖点');
for (const n of [12, 20, 30, 40, 60, 80, 120]) {
  await measure(`名称 ${n} 字`, { nameLen: n, specLen: 40, tags: 0 });
}

console.log('\n  【规格长度】名称 12 字，无卖点');
for (const s of [40, 80, 120, 180, 260, 400]) {
  await measure(`规格 ${s} 字`, { nameLen: 12, specLen: s, tags: 0 });
}

console.log('\n  【卖点个数】名称 12 字，规格 40 字');
for (const t of [0, 3, 5, 8, 12, 18, 26]) {
  await measure(`${t} 个卖点`, { nameLen: 12, specLen: 40, tags: t });
}

console.log('\n  【组合】真实的"详细录入"会是什么样');
await measure('名称 20 字 + 规格 60 字 + 5 卖点', { nameLen: 20, specLen: 60, tags: 5 });
await measure('名称 30 字 + 规格 120 字 + 8 卖点', { nameLen: 30, specLen: 120, tags: 8 });
await measure('名称 40 字 + 规格 200 字 + 12 卖点', { nameLen: 40, specLen: 200, tags: 12 });
console.log('');
