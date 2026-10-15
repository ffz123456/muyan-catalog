const A4 = { W_PX: 794, H_PX: 1123, W_MM: 210, H_MM: 297 };
const PER_PAGE = 4;
const esc = (s) => String(s != null ? s : "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
function fmtPrice(v, currency) {
  const unit = currency === "CNY" ? "\xA5" : `${currency} `;
  return unit + Number(v || 0).toLocaleString("zh-CN");
}
function fmtDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getFullYear()}\u5E74${dt.getMonth() + 1}\u6708${dt.getDate()}\u65E5`;
}
function cardHtml(p, images) {
  var _a, _b, _c;
  const uris = (_a = images.get(p.id)) != null ? _a : [];
  const main = uris[0];
  const rest = uris.slice(1);
  const isCustom = String((_b = p.stockStatus) != null ? _b : "").includes("\u5B9A\u5236");
  const tags = String((_c = p.highlights) != null ? _c : "").split(/[/、,，]/).map((s) => s.trim()).filter(Boolean);
  const mainHtml = main ? `<img src="${main}" alt="${esc(p.name)}">` : '<div class="no-img">\u6682\u65E0\u56FE\u7247</div>';
  const thumbsHtml = rest.length ? `<div class="card-thumbs">${rest.slice(0, 4).map((u) => `<img src="${u}" alt="">`).join("")}${rest.length > 4 ? `<span class="thumbs-more">+${rest.length - 4}</span>` : ""}</div>` : "";
  return `
    <article class="card">
      <div class="card-img">${mainHtml}</div>
      ${thumbsHtml}
      <div class="card-body">
        <div class="card-cat">${esc(p.category)}${p.supplier ? " \xB7 " + esc(p.supplier) : ""}</div>
        <h2 class="card-name">${esc(p.name)}</h2>
        ${p.specs ? `<p class="card-spec">${esc(p.specs)}</p>` : ""}
        ${tags.length ? `<div class="card-highlights">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
        <div class="card-foot">
          <div class="price">${fmtPrice(p.price, "CNY")}<small>\u542B\u7A0E</small></div>
          <div class="stock${isCustom ? " is-custom" : ""}">${esc(p.stockStatus)}</div>
        </div>
      </div>
    </article>`;
}
async function renderCatalogHtml({ products, settings, groupByCategory = false, resolveImage }) {
  if (!(products == null ? void 0 : products.length)) throw new Error("\u6CA1\u6709\u4EA7\u54C1\uFF0C\u65E0\u6CD5\u751F\u6210\u753B\u518C");
  if (typeof resolveImage !== "function") {
    throw new Error("renderCatalogHtml \u9700\u8981 resolveImage \u53C2\u6570\uFF08\u56FE\u7247\u89E3\u6790\u51FD\u6570\uFF09");
  }
  const images = /* @__PURE__ */ new Map();
  for (const p of products) {
    const refs = Array.isArray(p.images) ? p.images : p.images ? [p.images] : [];
    if (!refs.length) continue;
    const uris = [];
    for (const rel of refs) {
      try {
        const uri = await resolveImage(rel);
        if (uri) uris.push(uri);
      } catch {
      }
    }
    if (uris.length) images.set(p.id, uris);
  }
  const logo = settings.logo ? await resolveImage(settings.logo).catch(() => null) : null;
  const sorted = [...products].sort((a, b) => {
    if (groupByCategory && a.category !== b.category) {
      return String(a.category).localeCompare(String(b.category), "zh-CN");
    }
    return String(a.name).localeCompare(String(b.name), "zh-CN");
  });
  const groups = groupByCategory ? [...sorted.reduce((m, p) => {
    const k = p.category || "\u672A\u5206\u7C7B";
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(p);
    return m;
  }, /* @__PURE__ */ new Map())] : [["", sorted]];
  const pages = [];
  for (const [catName, items] of groups) {
    const chunks = chunk(items, PER_PAGE);
    chunks.forEach((group, i) => pages.push({ catName: i === 0 ? catName : `${catName}\uFF08\u7EED\uFF09`, items: group }));
  }
  const validUntil = settings.validityDays ? new Date(Date.now() + settings.validityDays * 864e5) : null;
  const cover = `
  <section class="page cover">
    ${logo ? `<img class="cover-logo" src="${logo}" alt="logo">` : ""}
    <div class="cover-rule"></div>
    <h1 class="cover-company">${esc(settings.companyName)}</h1>
    <p class="cover-tagline">${esc(settings.tagline)}</p>
    <div class="cover-meta">
      <strong>\u4EA7\u54C1\u753B\u518C</strong> \xB7 \u5171 ${products.length} \u6B3E
      ${validUntil ? ` \xB7 \u62A5\u4EF7\u6709\u6548\u671F\u81F3 ${fmtDate(validUntil)}` : ""}<br>
      ${esc(settings.contact)}
    </div>
  </section>`;
  const catalogPages = pages.map((pg, i) => `
  <section class="page">
    <div class="head">
      <h1>${pg.catName ? esc(pg.catName) : "\u4EA7\u54C1\u76EE\u5F55"}</h1>
      <div class="head-note">\u5171 ${products.length} \u6B3E \xB7 \u4EF7\u683C\u542B\u7A0E \xB7 \u751F\u6210\u4E8E ${fmtDate(/* @__PURE__ */ new Date())}</div>
    </div>
    <div class="grid">
      ${pg.items.map((p) => cardHtml(p, images)).join("\n")}
    </div>
    <div class="foot">
      <span>${esc(settings.companyName)}</span>
      <span>\u7B2C ${i + 2} / ${pages.length + 1} \u9875${settings.contact ? " \xB7 " + esc(settings.contact) : ""}</span>
    </div>
  </section>`).join("\n");
  return HTML_SHELL.replace("<!--__COVER__-->", cover + "\n" + catalogPages).replace("/*__PER_PAGE_HINT__*/", `/* \u6BCF\u9875 ${PER_PAGE} \u4E2A\u4EA7\u54C1 */`);
}
const HTML_SHELL = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>\u4EA7\u54C1\u753B\u518C</title>
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

  /* \u5C01\u9762 */
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

  /* \u9875\u7709\u9875\u811A */
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

  /* \u4EA7\u54C1\u7F51\u683C */
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

  /*
    \u591A\u56FE\u65F6\u7684\u5C0F\u56FE\u6761\u3002
    \u9AD8\u5EA6\u56FA\u5B9A 12mm\u2014\u2014**\u8FD9\u662F\u5361\u7247\u603B\u9AD8\u4E0D\u53D8\u7684\u5173\u952E**\uFF1A
    \u5C0F\u56FE\u518D\u591A\u4E5F\u53EA\u662F\u6A2A\u5411\u6392\uFF08\u8D85\u51FA\u7684\u5DF2\u7ECF\u5728 cardHtml \u91CC\u780D\u6389\uFF09\uFF0C
    \u5361\u7247\u4E0D\u4F1A\u88AB\u6491\u9AD8\uFF0C\u5206\u9875\u5C31\u4E0D\u4F1A\u6EA2\u51FA\u3002
  */
  .card-thumbs {
    display:flex; gap:1.4mm; padding:1.6mm 3.8mm 0;
    height:12mm; box-sizing:content-box; align-items:flex-start;
  }
  .card-thumbs img {
    width:13mm; height:11mm; object-fit:contain; display:block;
    border:.4pt solid var(--line); border-radius:1.2pt; background:#fff;
  }
  .thumbs-more {
    align-self:center; font-size:7pt; color:var(--ink-mute);
    padding-left:.6mm;
  }
  .card-body { padding:2.6mm 3.8mm 3.0mm; display:flex; flex-direction:column; flex:1; }
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
  \u5C01\u9762\u4E0E\u76EE\u5F55\u9875\u7531 renderCatalogHtml() \u6309\u6279\u6B21\u751F\u6210\u540E\u6CE8\u5165\u6B64\u5904\u3002
  \u76EE\u5F55\u9875\u5FC5\u987B\u663E\u5F0F\u5206\u9875\uFF08\u6BCF\u9875\u56FA\u5B9A PER_PAGE \u4E2A\u4EA7\u54C1\uFF09\uFF1B\u670D\u52A1\u7AEF\u90A3\u6761\u8DEF\u8FD8\u4F1A\u7531
  assertLayout() \u5B9E\u6D4B\u65AD\u8A00\u4E0D\u8D85 A4 \u9AD8\u5EA6 \u2014\u2014 \u5426\u5219\u5185\u5BB9\u4F1A\u88AB\u9759\u9ED8\u88C1\u6389\u3002
  \u6B64\u5904\u4E0D\u5199\u6B7B\u4EFB\u4F55\u4EA7\u54C1\u7F51\u683C\u3002
-->
<!--__COVER__-->
</body>
</html>`;
export {
  A4,
  HTML_SHELL,
  PER_PAGE,
  renderCatalogHtml
};
