/**
 * 本机实测：画册每页高度是否超过 A4（打印会不会丢内容）
 *
 * 之前做不了，因为受限沙箱禁止命名管道，Chromium 的 mojo 起不来
 * （报 platform_channel.cc:112 拒绝访问）。权限放开后应该能跑。
 *
 * 这个检查比"看图觉得没问题"可靠：它真的开浏览器、真的逐页量高度。
 */
import { renderCatalogHtml } from '../server/render-catalog.mjs';
import { findBrowserExecutable } from '../server/browser.mjs';
import { DATA_DIR } from '../server/datadir.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const exe = findBrowserExecutable();
console.log(`  浏览器：${exe ?? '(没找到)'}`);

const raw = await fs.readFile(path.join(DATA_DIR, 'products.json'), 'utf-8');
const products = JSON.parse(raw).products;
console.log(`  产品：${products.length} 款，图片数 ${products.map((p) => (p.images ?? []).length).join('/')}`);

const html = await renderCatalogHtml({
  products,
  settings: { companyName: '林氏家居', tagline: 'A4 高度实测', contact: '138-0000-0000', validityDays: 30 },
  groupByCategory: false,
});
console.log(`  画册 HTML：${(html.length / 1024).toFixed(0)} KB`);

const { assertLayout, A4 } = await import('../server/render-catalog.mjs');

let puppeteer;
try {
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.log('  ✗ 没有 puppeteer-core：npm install --no-save puppeteer-core');
  process.exit(1);
}

console.log(`  A4 高度基准：${A4.H_MM}mm = ${A4.H_PX}px\n`);

try {
  const layout = await assertLayout(html, puppeteer, {
    launchOptions: {
      headless: true,
      executablePath: exe,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
  });

  console.log('  逐页实测：');
  for (const p of layout.pages) {
    const over = p.overflowing ? `  ← 溢出 ${p.overflowPx}px` : `  余量 ${A4.H_PX - p.heightPx}px`;
    console.log(`    第 ${String(p.page).padStart(2)} 页  ${String(p.heightPx).padStart(5)}px${over}`);
  }

  const tallest = layout.pages.reduce((a, b) => (b.heightPx > a.heightPx ? b : a), layout.pages[0]);
  console.log('');
  if (layout.ok) {
    console.log(`  ✓ 全部 ${layout.pages.length} 页都在 A4 内`);
    console.log(`    最紧的一页：第 ${tallest.page} 页，余量 ${A4.H_PX - tallest.heightPx}px`);
  } else {
    console.log(`  ✗ 有 ${layout.pages.filter((p) => p.overflowing).length} 页溢出 A4 —— 打印会丢内容`);
    process.exitCode = 1;
  }
} catch (e) {
  console.log(`  ✗ 实测失败：${e.message.split('\n')[0]}`);
  process.exitCode = 1;
}
