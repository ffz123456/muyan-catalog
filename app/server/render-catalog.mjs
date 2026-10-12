/**
 * 画册渲染器 —— HTML 生成 + 分页断言 + PDF
 *
 * 为什么是 HTML/CSS 而不是 PDF 库：
 *   @react-pdf/renderer / pdfkit 默认字体无 CJK 字形，中文会整段退化为乱码且不报错。
 *   Chromium 直接用系统 CJK 字体，排版能力也强得多。
 *   实测对照见 catalog/docs/画册链路验证结论.md。
 *
 * 关键防线：**分页溢出断言**
 *   `.page` 用 min-height 时内容超长会静默撑高，打印只取 A4 高度、超出部分直接丢失。
 *   所以每页产品数固定，并实测每页高度，超过 A4 即判失败。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const A4 = { W_PX: 794, H_PX: 1123, W_MM: 210, H_MM: 297 };
export const PER_PAGE = 4;

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
};

/** 本地图片 -> data URI。画册必须自包含：发给客户后不依赖网络与服务器存活。 */
async function toDataUri(absPath) {
  const buf = await fs.readFile(absPath);
  const ext = path.extname(absPath).slice(1).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`不支持的图片格式：.${ext}（${path.basename(absPath)}）`);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function fmtPrice(v, currency) {
  const unit = currency === 'CNY' ? '¥' : `${currency} `;
  return unit + Number(v || 0).toLocaleString('zh-CN');
}

function fmtDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日`;
}

function cardHtml(p, images) {
  const img = images.get(p.id);
  const isCustom = String(p.stockStatus ?? '').includes('定制');
  const tags = String(p.highlights ?? '').split(/[/、,，]/).map((s) => s.trim()).filter(Boolean);
  const imgHtml = img
    ? `<img src="${img}" alt="${esc(p.name)}">`
    : `<div class="no-img">暂无图片</div>`;

  return `
    <article class="card">
      <div class="card-img">${imgHtml}</div>
      <div class="card-body">
        <div class="card-cat">${esc(p.category)}${p.supplier ? ' · ' + esc(p.supplier) : ''}</div>
        <h2 class="card-name">${esc(p.name)}</h2>
        ${p.specs ? `<p class="card-spec">${esc(p.specs)}</p>` : ''}
        ${tags.length ? `<div class="card-highlights">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
        <div class="card-foot">
          <div class="price">${fmtPrice(p.price, 'CNY')}<small>含税</small></div>
          <div class="stock${isCustom ? ' is-custom' : ''}">${esc(p.stockStatus)}</div>
        </div>
      </div>
    </article>`;
}

/**
 * 生成画册 HTML。
 * @param {object} opts
 * @param {Array}  opts.products  产品数组
 * @param {object} opts.settings  公司信息（companyName/tagline/logo/contact/…）
 * @param {string} opts.assetDir  本地图片所在目录（用于解析相对路径）
 * @param {boolean} opts.groupByCategory 是否按品类分节
 * @returns {Promise<string>} 完整 HTML
 */
export async function renderCatalogHtml({ products, settings, assetDir, groupByCategory = false }) {
  if (!products?.length) throw new Error('没有产品，无法生成画册');

  // 预先把所有图片读成 data URI（并发但有上限，避免一次打开太多文件）
  const images = new Map();
  for (const p of products) {
    const rel = Array.isArray(p.images) ? p.images[0] : p.images;
    if (!rel) continue;
    const abs = path.isAbsolute(rel) ? rel : path.join(assetDir, rel);
    try {
      images.set(p.id, await toDataUri(abs));
    } catch (err) {
      // 缺图不应中断整本画册，但要让人知道是哪张
      console.warn(`  ⚠ 跳过图片（${p.name}）：${err.message}`);
    }
  }

  const logo = settings.logo
    ? await toDataUri(path.isAbsolute(settings.logo) ? settings.logo : path.join(assetDir, settings.logo)).catch(() => null)
    : null;

  // 排序与分节
  const sorted = [...products].sort((a, b) => {
    if (groupByCategory && a.category !== b.category) {
      return String(a.category).localeCompare(String(b.category), 'zh-CN');
    }
    return String(a.name).localeCompare(String(b.name), 'zh-CN');
  });

  const groups = groupByCategory
    ? [...sorted.reduce((m, p) => {
      const k = p.category || '未分类';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(p);
      return m;
    }, new Map())]
    : [['', sorted]];

  // 分页：每页 PER_PAGE 个（品类分节时每节单独起页，避免跨节混排）
  const pages = [];
  for (const [catName, items] of groups) {
    const chunks = chunk(items, PER_PAGE);
    chunks.forEach((group, i) => pages.push({ catName: i === 0 ? catName : `${catName}（续）`, items: group }));
  }

  const validUntil = settings.validityDays
    ? new Date(Date.now() + settings.validityDays * 86400000)
    : null;

  const cover = `
  <section class="page cover">
    ${logo ? `<img class="cover-logo" src="${logo}" alt="logo">` : ''}
    <div class="cover-rule"></div>
    <h1 class="cover-company">${esc(settings.companyName)}</h1>
    <p class="cover-tagline">${esc(settings.tagline)}</p>
    <div class="cover-meta">
      <strong>产品画册</strong> · 共 ${products.length} 款
      ${validUntil ? ` · 报价有效期至 ${fmtDate(validUntil)}` : ''}<br>
      ${esc(settings.contact)}
    </div>
  </section>`;

  const catalogPages = pages.map((pg, i) => `
  <section class="page">
    <div class="head">
      <h1>${pg.catName ? esc(pg.catName) : '产品目录'}</h1>
      <div class="head-note">共 ${products.length} 款 · 价格含税 · 生成于 ${fmtDate(new Date())}</div>
    </div>
    <div class="grid">
      ${pg.items.map((p) => cardHtml(p, images)).join('\n')}
    </div>
    <div class="foot">
      <span>${esc(settings.companyName)}</span>
      <span>第 ${i + 2} / ${pages.length + 1} 页${settings.contact ? ' · ' + esc(settings.contact) : ''}</span>
    </div>
  </section>`).join('\n');

  return HTML_SHELL
    .replace('<!--__COVER__-->', cover + '\n' + catalogPages)
    .replace('/*__PER_PAGE_HINT__*/', `/* 每页 ${PER_PAGE} 个产品 */`);
}

/**
 * 用 Puppeteer 实测每页高度，断言无溢出。
 * 返回 { ok, pages:[{page,heightPx,overflowPx,overflowing}] }
 *
 * `launchOptions` 由调用方传入（见 server/browser.mjs）：
 *   便携版需要显式指定浏览器路径，不能靠 puppeteer 自己找。
 */
export async function assertLayout(html, puppeteer, { writeDebugHtml, launchOptions = {} } = {}) {
  const USER_DATA = path.join(import.meta.dirname, '..', 'data', '.chrome-profile');
  await fs.rm(USER_DATA, { recursive: true, force: true });

  let htmlPath = writeDebugHtml;
  if (!htmlPath) {
    htmlPath = path.join(import.meta.dirname, '..', 'data', '.catalog-preview.html');
  }
  await fs.mkdir(path.dirname(htmlPath), { recursive: true });
  await fs.writeFile(htmlPath, html, 'utf-8');

  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: USER_DATA,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    ...launchOptions,
  });
  try {
    const page = await browser.newPage();
    await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => Promise.all(
      Array.from(document.images)
        .filter((im) => !im.complete)
        .map((im) => new Promise((r) => { im.onload = im.onerror = r; }))
    ));
    await page.setViewport({ width: A4.W_PX, height: A4.H_PX, deviceScaleFactor: 1 });

    const pages = await page.evaluate((h) => Array.from(document.querySelectorAll('section.page')).map((el, i) => {
      const r = el.getBoundingClientRect();
      return {
        page: i + 1,
        heightPx: Math.round(r.height),
        a4Px: h,
        overflowPx: Math.round(r.height - h),
        overflowing: r.height > h + 1,
      };
    }), A4.H_PX);

    return { ok: pages.every((p) => !p.overflowing), pages, htmlPath };
  } finally {
    await browser.close();
  }
}

/**
 * 生成 PDF。
 * ⚠️ 必须走 CDP Page.printToPDF 直写：page.pdf() 的流式回传在当前环境会
 *    报 Protocol error (IO.read)，实测不可用。
 */
export async function renderCatalogPdf(html, puppeteer, outPath, { previewDir, launchOptions = {} } = {}) {
  const USER_DATA = path.join(import.meta.dirname, '..', 'data', '.chrome-profile');
  await fs.rm(USER_DATA, { recursive: true, force: true });

  const htmlPath = path.join(import.meta.dirname, '..', 'data', '.catalog-preview.html');
  await fs.mkdir(path.dirname(htmlPath), { recursive: true });
  await fs.writeFile(htmlPath, html, 'utf-8');

  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: USER_DATA,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    ...launchOptions,
  });
  try {
    const page = await browser.newPage();
    await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => Promise.all(
      Array.from(document.images)
        .filter((im) => !im.complete)
        .map((im) => new Promise((r) => { im.onload = im.onerror = r; }))
    ));
    await page.setViewport({ width: A4.W_PX, height: A4.H_PX, deviceScaleFactor: 2 });

    const client = await page.createCDPSession();
    const res = await client.send('Page.printToPDF', {
      printBackground: true,
      paperWidth: A4.W_MM / 25.4,
      paperHeight: A4.H_MM / 25.4,
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
      transferMode: 'ReturnAsBase64',
    });
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, Buffer.from(res.data, 'base64'));

    const shots = [];
    if (previewDir) {
      await fs.mkdir(previewDir, { recursive: true });
      const sections = await page.$$('section.page');
      for (let i = 0; i < sections.length; i++) {
        const f = path.join(previewDir, `page-${i + 1}.png`);
        await sections[i].screenshot({ path: f });
        shots.push(f);
      }
    }
    return { pdfPath: outPath, sizeKB: Math.round((await fs.stat(outPath)).size / 1024), previews: shots };
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------------ *
 * 模板：中文优先字体栈 + 固定 A4 尺寸
 * ------------------------------------------------------------------ */
const HTML_SHELL = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>产品画册</title>
<style>
  @page { size: A4; margin: 0; }
  :root {
    --ink:#2b2320; --ink-soft:#6d625b; --ink-mute:#9a908a;
    --line:#e3dcd3; --paper:#fff; --accent:#8a5a3b; --accent-bg:#f7f2ec;
  }
  * { box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  html,body { margin:0; padding:0; background:#fff; }
  body {
    font-family:"Microsoft YaHei","PingFang SC","Hiragino Sans GB",
                "Source Han Sans SC","Noto Sans CJK SC","SimSun",sans-serif;
    color:var(--ink); font-size:10.5pt; line-height:1.55;
  }
  .page {
    width:210mm; min-height:297mm; padding:16mm 15mm; background:var(--paper);
    position:relative; page-break-after:always;
    display:flex; flex-direction:column;
  }
  .page:last-child { page-break-after:auto; }

  /* 封面 */
  .cover { justify-content:center; align-items:flex-start; padding:0 22mm; }
  .cover-logo { max-height:22mm; max-width:70mm; object-fit:contain; margin-bottom:12mm; }
  .cover-rule { width:54mm; height:2.6pt; background:var(--accent); margin-bottom:9mm; }
  .cover-company { font-size:30pt; font-weight:700; letter-spacing:2.5pt; line-height:1.25; margin:0 0 6mm; }
  .cover-tagline { font-size:12.5pt; color:var(--ink-soft); letter-spacing:1.2pt; margin:0 0 14mm; }
  .cover-meta {
    border-top:.6pt solid var(--line); padding-top:5mm; width:100%;
    font-size:9.5pt; color:var(--ink-mute); letter-spacing:.6pt;
  }
  .cover-meta strong { color:var(--ink-soft); font-weight:500; }

  /* 页眉页脚 */
  .head {
    display:flex; align-items:baseline; justify-content:space-between;
    border-bottom:1.4pt solid var(--ink); padding-bottom:3mm; margin-bottom:7mm;
  }
  .head h1 { font-size:15pt; margin:0; font-weight:700; letter-spacing:1pt; }
  .head-note { font-size:8.5pt; color:var(--ink-mute); letter-spacing:.5pt; }
  .foot {
    margin-top:auto; padding-top:4mm; border-top:.6pt solid var(--line);
    display:flex; justify-content:space-between;
    font-size:8pt; color:var(--ink-mute); letter-spacing:.4pt;
  }

  /* 产品网格 */
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:7mm 6mm; }
  .card {
    border:.6pt solid var(--line); border-radius:2.5pt; overflow:hidden;
    display:flex; flex-direction:column; page-break-inside:avoid;
  }
  .card-img {
    width:100%; height:42mm; background:var(--accent-bg);
    display:flex; align-items:center; justify-content:center; overflow:hidden;
  }
  .card-img img { max-width:100%; max-height:100%; object-fit:contain; display:block; }
  .no-img { font-size:8pt; color:var(--ink-mute); }
  .card-body { padding:3.4mm 3.8mm 3.8mm; display:flex; flex-direction:column; flex:1; }
  .card-cat { font-size:7.5pt; color:var(--accent); letter-spacing:.8pt; margin-bottom:1.4mm; }
  .card-name { font-size:11.5pt; font-weight:700; line-height:1.35; margin:0 0 2.2mm; }
  .card-spec { font-size:8.6pt; color:var(--ink-soft); line-height:1.62; margin:0 0 2.4mm; flex:1; }
  .card-highlights { margin:0 0 2.8mm; }
  .tag {
    display:inline-block; font-size:7.6pt; color:var(--ink-soft);
    background:var(--accent-bg); border-radius:1.6pt;
    padding:.7mm 1.8mm; margin:0 1.4mm 1.2mm 0;
  }
  .card-foot {
    display:flex; align-items:flex-end; justify-content:space-between;
    border-top:.6pt solid var(--line); padding-top:2.4mm; margin-top:auto;
  }
  .price { font-size:14pt; font-weight:700; color:var(--accent); line-height:1; }
  .price small { font-size:8.5pt; font-weight:400; color:var(--ink-mute); margin-left:.8mm; }
  .stock { font-size:8pt; color:var(--ink-soft); }
  .stock::before {
    content:""; display:inline-block; width:1.6mm; height:1.6mm;
    border-radius:50%; background:#6f9e6a; margin-right:1.2mm;
  }
  .stock.is-custom::before { background:#d0a24c; }
  /*__PER_PAGE_HINT__*/
</style>
</head>
<body>
<!--
  封面与目录页由 server/render-catalog.mjs 按批次生成后注入此处。
  目录页必须显式分页（每页固定 PER_PAGE 个产品），并由 assertLayout() 实测断言
  不超 A4 高度 —— 否则内容会被静默裁掉。此处不写死任何产品网格。
-->
<!--__COVER__-->
</body>
</html>`;
