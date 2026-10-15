/**
 * 画册渲染（环境无关）—— 服务端与浏览器**共用同一份**
 *
 * 为什么要抽出来：
 *   这个项目有两种运行形态：
 *     · 团队模式：服务端（Node + Puppeteer）出 PDF
 *     · 单人模式：手机浏览器里直接打印
 *   如果两套各写一份画册排版，迟早会走样——同一批货在两台手机上
 *   印出来的画册不一样，客户会觉得不专业。
 *
 * 所以这里只放**纯逻辑**：拼 HTML、算分页、格式化。
 * 读文件、开浏览器这些环境相关的事，由调用方通过参数传进来
 * （见 resolveImage）。
 *
 * 关键防线：**分页溢出断言**（在 server/render-catalog.mjs 里）
 *   `.page` 用 min-height 时内容超长会静默撑高，打印只取 A4 高度、
 *   超出部分直接丢失。所以每页产品数固定，并实测每页高度。
 *   浏览器打印那条路靠固定 PER_PAGE 保证不溢出。
 */

export const A4 = { W_PX: 794, H_PX: 1123, W_MM: 210, H_MM: 297 };
export const PER_PAGE = 4;

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

/**
 * 一张产品卡片。
 *
 * 多图的处理方式：**主图 + 下面一排小图**，卡片总高不变。
 *
 * 为什么这么选（不是随手定的，是两条硬约束逼出来的）：
 *   1. `.page` 用的是 `min-height`——内容超长会**静默撑高**，
 *      打印只取 A4 高度、超出部分直接丢失。所以卡片高度必须可控。
 *   2. 画册是 A4、每页固定 4 款。给每张图单独排一页会让页数爆炸
 *      （50 款 × 3 张图 = 150+ 页），用户打印成本直接翻几倍。
 *
 * 小图条只占 12mm，塞得进现有卡片；再多就横向排下去，卡片本身不会变高。
 */
function cardHtml(p, images) {
  // images: Map<产品id, string[]> —— 全部图的 data URI，第一张是主图
  const uris = images.get(p.id) ?? [];
  const main = uris[0];
  const rest = uris.slice(1);

  const isCustom = String(p.stockStatus ?? '').includes('定制');
  const tags = String(p.highlights ?? '').split(/[/、,，]/).map((s) => s.trim()).filter(Boolean);

  const mainHtml = main
    ? `<img src="${main}" alt="${esc(p.name)}">`
    : '<div class="no-img">暂无图片</div>';

  // 小图最多显示 4 张——再多在 A4 上就糊成一团，看不清反而更糟
  const thumbsHtml = rest.length
    ? `<div class="card-thumbs">${rest.slice(0, 4).map((u) => `<img src="${u}" alt="">`).join('')}${
      rest.length > 4 ? `<span class="thumbs-more">+${rest.length - 4}</span>` : ''
    }</div>`
    : '';

  return `
    <article class="card">
      <div class="card-img">${mainHtml}</div>
      ${thumbsHtml}
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
 *
 * @param {object} opts
 * @param {Array}  opts.products  产品数组
 * @param {object} opts.settings  公司信息（companyName/tagline/logo/contact/…）
 * @param {boolean} opts.groupByCategory 是否按品类分节
 * @param {(ref:string)=>Promise<string|null>} opts.resolveImage
 *        把"图片引用"解析成 data URI 的函数。**环境相关，必须由调用方提供**：
 *          · 服务端：读磁盘文件转 base64
 *          · 浏览器：从本地库取附件转 base64
 *        返回 null 表示这张图取不到（会显示"暂无图片"，不中断整本画册）。
 * @returns {Promise<string>} 完整 HTML
 */
export async function renderCatalogHtml({ products, settings, groupByCategory = false, resolveImage }) {
  if (!products?.length) throw new Error('没有产品，无法生成画册');
  if (typeof resolveImage !== 'function') {
    throw new Error('renderCatalogHtml 需要 resolveImage 参数（图片解析函数）');
  }

  /**
   * 预先把图片解析成 data URI。
   *
   * 画册必须**自包含**：发给客户后不能依赖网络、服务器，也不能依赖本机文件还在。
   * 所以图片一律内嵌。
   *
   * ⚠️ 内存代价（实测量过，别改大意了）：
   *    N 张图同时变成 base64 放在内存里，HTML 体积 ≈ 图片总大小 × 4/3。
   *    单机版是在**手机**上跑这一步的，图多了会吃紧。
   *    所以这里按产品**串行**解析、不并发——
   *    并发只会让峰值更高，不会更快（瓶颈是 base64 编码本身）。
   *
   * 图片数量**不设上限**：一款产品有多少张就解析多少张。
   * 画册里主图 + 最多 4 张小图（见 cardHtml），多出来的不进画册但保留在产品里。
   */
  const images = new Map();
  for (const p of products) {
    const refs = Array.isArray(p.images) ? p.images : (p.images ? [p.images] : []);
    if (!refs.length) continue;
    const uris = [];
    for (const rel of refs) {
      try {
        const uri = await resolveImage(rel);
        if (uri) uris.push(uri);
      } catch {
        // 单张缺图不该中断整本画册
      }
    }
    if (uris.length) images.set(p.id, uris);
  }

  const logo = settings.logo ? await resolveImage(settings.logo).catch(() => null) : null;

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

/* ------------------------------------------------------------------ *
 * 模板：中文优先字体栈 + 固定 A4 尺寸
 *
 * ⚠️ 字体栈里必须同时有 Windows / macOS / Linux 的中文字体名。
 *    少一个平台的名字，那个平台上就会退回没有中文字形的默认字体，
 *    结果是**整本画册中文变方块，而且不报错**。
 *    项目早期用 pdf-catalog-generator 就是这么翻车的。
 * ------------------------------------------------------------------ */
export const HTML_SHELL = `<!doctype html>
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

  /*
    产品网格。
    display:grid;
    grid-template-columns:1fr 1fr;

    ⚠️ **行高必须是固定的**，这是"不论录入多长都不会溢出"的根本保证。

    为什么：每页固定 PER_PAGE 个产品、排成 2 行。行高钉死之后，
    卡片再高也只能占那么多，**内容再多也不会把页撑破**。

    行高怎么来的（**实测，不是纸面换算**）：
        页边距 60+60 + 页眉 43+26 + 页脚 33+15 = 237px（62.7mm）
        A4 1123px − 237px = 886px 留给网格
        (886 − 行间距 26.5) / 2 = 429.8px  →  取 113mm，留一点余量

    ⚠️ 我第一版按纸面算成 116.5mm，实测每行多 10px、整页溢出 7px。
       **字体的实际行高、边框、margin 塌陷都和纸面计算不一样**，
       所以这个数必须量出来，不能推。改了 PER_PAGE 或页眉页脚就重量：
           node tools/measure-page-parts.mjs

    实测过的临界点（修之前，行高不固定）：
        名称 120 字          → 溢出 40px
        规格 260 字          → 溢出 14px
        18 个卖点            → 溢出 36px
        名称30+规格120+8卖点 → 溢出 40px   ← 这个是现实中会遇到的正常录入
    而 .page 用的是 min-height，超出的部分打印时**静默裁掉**，不报错。

    ⚠️ 这段 CSS 在**模板字符串**里，注释中**不能出现反引号**——
       一个反引号就会把字符串截断，报出 ".page is not a function" 这种
       完全看不出原因的错。我就这么踩过一次。
  */
  .grid {
    display:grid; grid-template-columns:1fr 1fr; gap:7mm 6mm;
    grid-auto-rows:113mm;            /* 见上面的实测推导，别按纸面算 */
  }
  .card {
    border:.6pt solid var(--line); border-radius:2.5pt; overflow:hidden;
    display:flex; flex-direction:column; page-break-inside:avoid;
    min-height:0;                    /* 允许在固定行高内收缩，否则内容会把行顶高 */
  }
  .card-img {
    width:100%; height:42mm; background:var(--accent-bg);
    display:flex; align-items:center; justify-content:center; overflow:hidden;
  }
  .card-img img { max-width:100%; max-height:100%; object-fit:contain; display:block; }
  .no-img { font-size:8pt; color:var(--ink-mute); }

  /*
    多图时的小图条。
    高度固定 12mm——**这是卡片总高不变的关键**：
    小图再多也只是横向排（超出的已经在 cardHtml 里砍掉），
    卡片不会被撑高，分页就不会溢出。
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
  .card-body { padding:2.6mm 3.8mm 3.0mm; display:flex; flex-direction:column; flex:1; min-height:0; }
  .card-cat { font-size:7.5pt; color:var(--accent); letter-spacing:.8pt; margin-bottom:1.4mm; }

  /*
    名称与规格做**行数截断**，超出的用省略号。
    固定行高已经保证了不溢出，截断是为了"溢出时看起来是有意截的"，
    而不是被卡片边缘生硬切掉半个字。

    为什么是 2 行 / 4 行：
      名称放 2 行（11.5pt × 1.35 ≈ 5.5mm/行）
      规格放 4 行（8.6pt × 1.62 ≈ 4.9mm/行）
      加上品类、卖点、价格，总高落在 116.5mm 内还留有余量。
    要放更长的内容就调这里，**并重新跑 tools/find-a4-limit.mjs 确认**。
  */
  .card-name {
    font-size:11.5pt; font-weight:700; line-height:1.35; margin:0 0 2.2mm;
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
  }
  .card-spec {
    font-size:8.6pt; color:var(--ink-soft); line-height:1.62; margin:0 0 2.4mm; flex:1;
    display:-webkit-box; -webkit-line-clamp:4; -webkit-box-orient:vertical; overflow:hidden;
    min-height:0;
  }
  /* 卖点行数也限一下：26 个卖点实测会溢出 91px */
  .card-highlights {
    margin:0 0 2.8mm; overflow:hidden;
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
  }
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
  封面与目录页由 renderCatalogHtml() 按批次生成后注入此处。
  目录页必须显式分页（每页固定 PER_PAGE 个产品）；服务端那条路还会由
  assertLayout() 实测断言不超 A4 高度 —— 否则内容会被静默裁掉。
  此处不写死任何产品网格。
-->
<!--__COVER__-->
</body>
</html>`;
