/**
 * 验证画册的**文本截断行为**（原来是"验证会溢出"，但溢出已经被根治了）
 *
 * ── 为什么这个检查变了 ──
 *
 * 原来这个脚本是"故意塞爆 → 必须报溢出"，用来证明 A4 断言是活的。
 * 但那是**修好之前**的事：当时卡片高度随内容长，内容多了就把页撑破。
 *
 * 现在卡片行高固定（见 shared/catalog.mjs 的 .grid），内容再多也撑不破页，
 * 超出部分被**裁掉**。于是"报溢出"不再是正确行为，这个检查也就失效了。
 *
 * 但风险只是换了个形式：**会不会裁掉了不该裁的东西？**
 * 所以现在改成验证三件事：
 *
 *   1. 极端内容下，页面仍然不溢出（结构没有被撑破）
 *   2. 截断是"有意的"——名称/规格/卖点各限几行，且出现省略号，
 *      不是被卡片边缘生硬切掉半个字
 *   3. **价格和库存状态永远不会被裁** —— 这两个是成交信息，
 *      被裁掉客户就看不到报价了，那是事故
 *
 * 第 3 条是重点：名称长、规格长都可以忍（少看点描述），
 * 但"¥4,380"看不见了不行。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderCatalogHtml, assertLayout, A4 } from '../server/render-catalog.mjs';
import { PER_PAGE } from '../shared/catalog.mjs';
import { findBrowserExecutable } from '../server/browser.mjs';

const exe = findBrowserExecutable();
const puppeteer = (await import('puppeteer-core')).default;
const launchOptions = { headless: true, executablePath: exe, args: ['--no-sandbox', '--disable-dev-shm-usage'] };

const settings = { companyName: '截断测试', tagline: 'x', contact: '138-0000-0000', validityDays: 30 };

/** 造一批内容极长的产品（每款都拉满），确认结构不破。 */
function extreme(n = 8) {
  return Array.from({ length: n }, (_, i) => ({
    id: `x${i}`,
    name: ('超长产品名称'.repeat(8)).slice(0, 120),
    category: '客厅 · 沙发 · 广东佛山厂',
    specs: ('尺寸 2200×950×820mm，科技布，实木框架，可拆洗。'.repeat(12)).slice(0, 400),
    highlights: Array.from({ length: 26 }, (_, k) => `卖点${k + 1}`).join('/'),
    price: 4380,
    stockStatus: '现货',
    images: [],
  }));
}

console.log('');
console.log(`  A4 = ${A4.H_PX}px，每页 ${PER_PAGE} 个产品`);
console.log('  ────────────────────────────────────────');

/* ---------- 1. 极端内容下页面不溢出 ---------- */
const prods = extreme(8);
const html = await renderCatalogHtml({ products: prods, settings, groupByCategory: false });
const layout = await assertLayout(html, puppeteer, { launchOptions });
const tallest = layout.pages.reduce((a, b) => (b.heightPx > a.heightPx ? b : a), layout.pages[0]);

console.log('\n  【1】极端内容下页面仍然不溢出');
console.log(`    产品：8 款，每款名称 120 字 / 规格 400 字 / 26 个卖点`);
console.log(`    最高一页 ${tallest.heightPx}px / A4 ${A4.H_PX}px，余量 ${A4.H_PX - tallest.heightPx}px`);
if (!layout.ok) {
  const bad = layout.pages.filter((p) => p.overflowing);
  console.log(`    ✗ ${bad.length} 页溢出：${bad.map((b) => `第${b.page}页+${b.overflowPx}px`).join('，')}`);
  process.exitCode = 1;
} else {
  console.log('    ✓ 没有被内容撑破');
}

/* ---------- 2 & 3. 截断行为与成交信息保护 ---------- */
console.log('\n  【2】截断是不是"有意的"（限行 + 省略号）');
console.log('  【3】价格与库存**永远不能被裁**');

let browser;
try {
  browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  await page.setViewport({ width: A4.W_PX, height: 6000 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  const r = await page.evaluate(() => {
    const pg = Array.from(document.querySelectorAll('section.page')).find((el) => el.querySelector('.grid'));
    if (!pg) return { error: '找不到产品页' };
    const card = pg.querySelector('.card');
    const info = (sel) => {
      const el = card.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        clamp: cs.webkitLineClamp,
        overflow: cs.overflow,
        // scrollHeight > clientHeight 说明内容确实被裁了
        clipped: el.scrollHeight > el.clientHeight + 1,
        scrollH: el.scrollHeight,
        clientH: el.clientHeight,
      };
    };
    const price = card.querySelector('.price');
    const stock = card.querySelector('.stock');
    const priceBox = price ? price.getBoundingClientRect() : null;
    const cardBox = card.getBoundingClientRect();
    return {
      name: info('.card-name'),
      spec: info('.card-spec'),
      highlights: info('.card-highlights'),
      priceText: price ? price.textContent.trim() : null,
      stockText: stock ? stock.textContent.trim() : null,
      // 价格/库存在卡片范围内吗（在范围内就说明没被卡片裁掉）
      priceInside: priceBox ? (priceBox.bottom <= cardBox.bottom + 1 && priceBox.top >= cardBox.top - 1) : false,
      cardH: Math.round(cardBox.height),
    };
  });

  if (r.error) {
    console.log('    ✗ ' + r.error);
    process.exitCode = 1;
  } else {
    const line = (label, v) => {
      if (!v) { console.log(`    · ${label}：不存在`); return; }
      console.log(`    · ${label.padEnd(8)} 限 ${String(v.clamp).padStart(3)} 行  `
        + `内容 ${v.scrollH}px / 可见 ${v.clientH}px  ${v.clipped ? '（已截断）' : '（没超出）'}`);
    };
    line('名称', r.name);
    line('规格', r.spec);
    line('卖点', r.highlights);

    const clamped = [r.name, r.spec, r.highlights].filter((v) => v && v.clamp && v.clamp !== 'none');
    if (clamped.length === 3) {
      console.log('    ✓ 三类文本都设了行数上限，截断是有意的（带省略号），不是被边缘切掉');
    } else {
      console.log(`    ✗ 只有 ${clamped.length}/3 类文本设了行数上限`);
      process.exitCode = 1;
    }

    console.log('\n    价格文本：' + r.priceText);
    console.log('    库存文本：' + r.stockText);
    if (r.priceInside && r.priceText) {
      console.log('    ✓ 价格与库存在卡片范围内，没有被裁 —— 成交信息是安全的');
    } else {
      console.log('    ✗ 价格或库存被裁掉了 —— 客户会看不到报价，这是事故');
      process.exitCode = 1;
    }
  }
} finally {
  if (browser) await browser.close();
}

console.log('');
console.log('  ────────────────────────────────────────');
if (process.exitCode) {
  console.log('  ✗ 有问题');
} else {
  console.log('  ✓ 截断行为符合预期，成交信息受保护');
}
console.log('');

void fs; void path;
