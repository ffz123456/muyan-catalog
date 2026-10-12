/**
 * 画册生成（Puppeteer / Chromium 路线）
 *
 * 产出：
 *   out/catalog.puppeteer.pdf   —— 交付给客户的画册
 *   out/preview/*.png           —— 供目视检查的页面截图
 *   out/layout-report.json      —— 每页实测高度与溢出判定
 *
 * 为什么用 Chromium 而不是 @react-pdf/renderer：
 *   后者基于 pdfkit，默认字体 Helvetica 无 CJK 字形，中文整段落无法渲染。
 *   Chromium 直接使用系统 CJK 字体，且 HTML/CSS 排版能力远强于其模板系统。
 *
 * 分页为什么必须显式做：
 *   `.page` 用 min-height 撑开时，内容超长会静默把页撑高，
 *   打印/截图只取 A4 高度，超出部分直接丢失。故此处先分块再实测断言。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const PREVIEW = path.join(OUT, 'preview');
fs.rmSync(PREVIEW, { recursive: true, force: true });
fs.mkdirSync(PREVIEW, { recursive: true });

const sample = JSON.parse(fs.readFileSync(path.join(HERE, 'data', 'products.sample.json'), 'utf-8'));
const tpl = fs.readFileSync(path.join(HERE, 'templates', 'catalog.html'), 'utf-8');

const CONTACT = '电话 138-0000-0000 · 微信 linshi-jiaju';
const PER_PAGE = 4;              // 每页产品数；改动后必须通过溢出断言
const A4_W = 794, A4_H = 1123;   // A4 @96dpi

function dataUri(rel) {
  const abs = path.join(HERE, rel);
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).slice(1).toLowerCase().replace('jpg', 'jpeg');
  return `data:image/${ext};base64,${buf.toString('base64')}`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function card(p) {
  const isCustom = p.stockStatus.includes('定制');
  return `
    <article class="card">
      <div class="card-img"><img src="${dataUri(p.image)}" alt="${esc(p.name)}"></div>
      <div class="card-body">
        <div class="card-cat">${esc(p.category)} · ${esc(p.id)}</div>
        <h2 class="card-name">${esc(p.name)}</h2>
        <p class="card-spec">${esc(p.specs)}</p>
        <div class="card-highlights">
          ${p.highlights.split(' / ').map((h) => `<span class="tag">${esc(h)}</span>`).join('')}
        </div>
        <div class="card-foot">
          <div class="price">¥${p.price.toLocaleString('zh-CN')}<small>含税</small></div>
          <div class="stock${isCustom ? ' is-custom' : ''}">${esc(p.stockStatus)}</div>
        </div>
      </div>
    </article>`;
}

/** 按 PER_PAGE 分块，生成每页一个 section（显式分页，不依赖自动分页）。 */
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const cover = `
  <section class="page cover">
    <div class="cover-badge">2026 春季</div>
    <div class="cover-rule"></div>
    <h1 class="cover-company">${esc(sample.meta.companyName)}</h1>
    <p class="cover-tagline">${esc(sample.meta.tagline)}</p>
    <div class="cover-meta">
      <strong>产品目录</strong> · 共 ${sample.products.length} 款 · 报价有效期 30 天<br>
      ${esc(CONTACT)}
    </div>
  </section>`;

const pages = chunk(sample.products, PER_PAGE);
const pageCount = pages.length + 1;

const catalogPages = pages.map((group, i) => `
  <section class="page">
    <div class="head">
      <h1>产品目录</h1>
      <div class="head-note">共 ${sample.products.length} 款 · 价格含税 · 有效期 30 天</div>
    </div>
    <div class="grid">
      ${group.map(card).join('\n')}
    </div>
    <div class="foot">
      <span>${esc(sample.meta.companyName)}</span>
      <span>第 ${i + 2} / ${pageCount} 页 · ${esc(CONTACT)}</span>
    </div>
  </section>`).join('\n');

const html = tpl
  .replace('<!--__COVER__-->', cover + '\n' + catalogPages);
  // 目录页由上方按批生成，模板中的 {{CARDS}} 段已不再使用

const htmlPath = path.join(OUT, 'catalog.html');
fs.writeFileSync(htmlPath, html, 'utf-8');

const USER_DATA_DIR = path.join(OUT, '.chrome-profile');
fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });

const browser = await puppeteer.launch({
  headless: true,
  userDataDir: USER_DATA_DIR,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
});

let failed = false;
try {
  const page = await browser.newPage();
  await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all(
    Array.from(document.images).filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; }))
  ));
  await page.setViewport({ width: A4_W, height: A4_H, deviceScaleFactor: 2 });

  // ---- 实测每页高度，断言无溢出（分页正确性的硬校验）----
  const layout = await page.evaluate((A4H) => {
    return Array.from(document.querySelectorAll('section.page')).map((el, i) => {
      const r = el.getBoundingClientRect();
      return {
        page: i + 1,
        heightPx: Math.round(r.height),
        a4Px: A4H,
        overflowPx: Math.round(r.height - A4H),
        overflowing: r.height > A4H + 1,
      };
    });
  }, A4_H);

  fs.writeFileSync(path.join(OUT, 'layout-report.json'), JSON.stringify(layout, null, 2), 'utf-8');
  const bad = layout.filter((l) => l.overflowing);
  for (const l of layout) {
    const tag = l.overflowing ? `✗ 溢出 ${l.overflowPx}px` : '✓';
    console.log(`  ${tag}  第 ${l.page} 页  实测 ${l.heightPx}px / A4 ${l.a4Px}px`);
  }
  if (bad.length) {
    console.error(`\n✗ 分页断言失败：${bad.length} 页超过 A4 高度，打印会丢失内容。`);
    console.error(`  请减少每页产品数（当前 PER_PAGE=${PER_PAGE}）或调整卡片尺寸。`);
    failed = true;
  }

  // ---- 截图（目视检查依据）----
  try {
    const sections = await page.$$('section.page');
    for (let i = 0; i < sections.length; i++) {
      const file = path.join(PREVIEW, `page-${i + 1}.png`);
      await sections[i].screenshot({ path: file });
    }
    console.log(`\n✓ 截图 ${sections.length} 页 -> ${path.relative(HERE, PREVIEW)}`);
  } catch (err) {
    console.error(`✗ 截图失败：${err.message}`);
  }

  // ---- PDF ----
  const pdfPath = path.join(OUT, 'catalog.puppeteer.pdf');
  let pdfOk = false;
  try {
    const buf = await page.pdf({
      format: 'A4', printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      tagged: false, outline: false,
    });
    fs.writeFileSync(pdfPath, buf);
    console.log(`✓ PDF   ${(buf.length / 1024).toFixed(0)} KB  -> ${path.relative(HERE, pdfPath)}`);
    pdfOk = true;
  } catch (err) {
    console.error(`✗ PDF 流式生成失败：${err.message}（改用 CDP 直写文件重试）`);
  }

  if (!pdfOk) {
    try {
      const client = await page.createCDPSession();
      const res = await client.send('Page.printToPDF', {
        printBackground: true,
        paperWidth: 8.27, paperHeight: 11.69,
        marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
        transferMode: 'ReturnAsBase64',
      });
      fs.writeFileSync(pdfPath, Buffer.from(res.data, 'base64'));
      console.log(`✓ PDF   ${(fs.statSync(pdfPath).size / 1024).toFixed(0)} KB  -> ${path.relative(HERE, pdfPath)}（CDP 直写）`);
      pdfOk = true;
    } catch (err) {
      console.error(`✗ PDF CDP 也失败：${err.message}`);
      failed = true;
    }
  }

  const fontStack = await page.evaluate(() => getComputedStyle(document.querySelector('.cover-company')).fontFamily);
  console.log(`  中文字体栈: ${fontStack}`);
} finally {
  await browser.close();
}

process.exitCode = failed ? 1 : 0;
