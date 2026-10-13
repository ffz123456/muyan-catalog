/**
 * 前端逻辑 —— ES 模块，只依赖 PouchDB（本地离线库）
 *
 * 交互原则（主文档 §14）：大按钮、少输入框、能选就不打字。
 *
 * 数据流（主文档 §2b.3 红线：服务端是权威副本）：
 *   订单列表读**本地库**（离线可用）
 *   出单先落本地，再立即同步一次；同步失败也保留在本地并显示"未同步"
 *   删除走**软删除**（硬删除会让服务端过滤丢弃该变更，其它设备残留幽灵单）
 */
import * as sync from './syncdb.mjs';
import * as backend from './backend.mjs';
import { renderCatalogHtml } from './../shared/catalog.mjs';

/* ------------------------------ 工具 ------------------------------ */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const api = {
  async get(path) {
    const r = await fetch(path);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `请求失败（${r.status}）`);
    return d;
  },
  async send(path, method, body) {
    const r = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(d.error || `请求失败（${r.status}）`);
      e.payload = d;
      throw e;
    }
    return d;
  },
};

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('is-error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 5000 : 2600);
}

const money = (v) => '¥' + Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 手机原图常 5-10MB，直接传会让人以为卡死。压到长边 1600 / 质量 0.82。 */
function compressImage(file, { maxEdge = 1600, quality = 0.82 } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('这张图片无法识别'));
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff';          // 透明 PNG 转 JPEG 会变黑块，先铺白底
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ------------------------------ 状态 ------------------------------ */

const state = {
  products: [],
  orders: [],
  settings: {},
  sales: [],
  viewer: null,
  signedIn: false,
  scope: 'own',
  selected: new Set(),        // 画册里勾选的产品
  picking: new Set(),         // 选产品弹层里勾选的（尚未加入订单）
  editingProduct: null,
  pendingPhoto: null,
  editingOrder: null,      // { id?, items:[], ... }
  syncInfo: sync.snapshot(),
  /** 服务端能力探测结果（例如有没有浏览器能出 PDF）。见 applyServerPdfCapability */
  capabilities: null,
  /** 单人模式：连不上服务端，本机就是全部。见 backend.mjs 与 loadSolo() */
  solo: false,
};

/* ------------------------------ 同步状态 ------------------------------ */

function renderSyncChip() {
  const info = state.syncInfo;
  const dot = $('#syncDot');
  const text = $('#syncText');
  let label; let cls;

  if (!state.signedIn) { label = '未登录'; cls = 'is-off'; }
  else if (info.syncing) { label = '同步中…'; cls = 'is-busy'; }
  else if (info.pending > 0) { label = `未同步 ${info.pending}`; cls = 'is-warn'; }
  else if (info.lastError) { label = '同步异常'; cls = 'is-err'; }
  else if (!info.online) { label = '离线'; cls = 'is-warn'; }
  else { label = '已同步'; cls = 'is-ok'; }

  text.textContent = label;
  dot.className = `sync-dot ${cls}`;
  $('#syncChip').title = [
    label,
    info.lastSyncAt ? `上次同步 ${fmtDate(info.lastSyncAt.toISOString())}` : '尚未同步',
    info.lastError ? `错误：${info.lastError}` : null,
    '点一下立即同步',
  ].filter(Boolean).join('\n');
}

/** 出单时的金额计算。写入本地库，所以要在客户端算。 */
function computeTotals(items) {
  let listTotal = 0; let total = 0; let count = 0;
  for (const it of items) {
    const p = state.products.find((x) => x.id === it.product_id);
    const lp = p ? Number(p.price) || 0 : 0;
    const ap = it.actual_price === '' || it.actual_price === null || it.actual_price === undefined
      ? lp : Number(it.actual_price);
    const q = Number(it.qty) || 0;
    listTotal += lp * q;
    total += ap * q;
    count += q;
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    list_total: r2(listTotal),
    total: r2(total),
    discount: r2(Math.max(0, listTotal - total)),
    item_count: count,
  };
}

/* ------------------------------ 销售身份 ------------------------------ */

function renderViewer() {
  const v = state.viewer;
  $('#whoName').textContent = v ? (v.display || v.name) : '未登录';

  // 账号下拉（登录用）。只列账号名，不提供"点一下就变成他"。
  const opts = state.sales
    .map((s) => `<option value="${esc(s.name)}">${esc(s.display || s.name)}（${esc(s.name)}）</option>`)
    .join('');
  const sel = $('#loginUser');
  if (sel) {
    const keep = sel.value;
    sel.innerHTML = opts;
    if (keep && state.sales.some((s) => s.name === keep)) sel.value = keep;
  }

  // 已登录时，弹层里只做"退出登录"，不做身份切换
  $('#whoList').innerHTML = v
    ? `<div class="item" id="whoSignOut">
         <div class="item-main">
           <div class="item-name">退出登录</div>
           <div class="item-sub">当前：${esc(v.display || v.name)}（${esc(v.name)}）</div>
         </div>
       </div>
       <div class="item" id="whoChangePw">
         <div class="item-main">
           <div class="item-name">修改密码</div>
           <div class="item-sub">换一个只有你知道的密码</div>
         </div>
       </div>`
    : '<p class="hint" style="padding:8px 0">尚未登录</p>';

  const so = $('#whoSignOut');
  if (so) so.addEventListener('click', signOut);
  const cp = $('#whoChangePw');
  if (cp) cp.addEventListener('click', () => {
    $('#whoSheet').hidden = true;
    $('#pwSheet').hidden = false;
    $('#pwMsg').hidden = true;
    $('#pwForm').reset();
  });

  const note = $('#scopeNote');
  if (state.scope === 'all') {
    note.innerHTML = '👀 你是管理者，<strong>可以看到全部销售的订单</strong>。';
    note.hidden = false;
  } else {
    note.innerHTML = '🔒 你只能看到<strong>自己出的单</strong>。别人的单不会显示。';
    note.hidden = false;
  }
}

/** 登录（需要密码）。 */
async function signIn(name, password) {
  const r = await api.send('/api/session', 'POST', { name, password });
  state.signedIn = true;
  $('#loginGate').hidden = true;
  $('#whoSheet').hidden = true;
  await loadAll();
  await sync.resync();            // 换人后立刻按新身份同步一次
  await refreshOrdersFromLocal();

  // 首次登录（或管理员重置后）强制改密
  if (r.sales?.must_change_password) {
    $('#pwSheet').hidden = false;
    $('#pwMsg').hidden = false;
    $('#pwMsg').textContent = '这是初始密码，请改成只有你知道的密码。';
    $('#pwForm').reset();
  }
  return r;
}

async function signOut() {
  try { await api.send('/api/session', 'DELETE'); } catch { /* 忽略 */ }
  state.signedIn = false;
  state.viewer = null;
  state.orders = [];
  state.orderStats = null;
  // 换人后必须清掉本地残留，否则下一位会看到上一位的订单。
  // 登出时直接销毁本地库最彻底（数据在服务端，重登会重新拉回）。
  try { await sync.wipeLocal(); } catch { /* 忽略 */ }
  $('#whoSheet').hidden = true;
  $('#loginGate').hidden = false;
  renderViewer();
  renderOrders();
  renderSyncChip();
  toast('已退出登录');
}

/** 从本地库重新读订单并刷新列表与概览。 */
async function refreshOrdersFromLocal() {
  if (!state.signedIn) { state.orders = []; state.orderStats = null; renderOrders(); return; }
  try {
    state.orders = await sync.listOrders();
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthOrders = state.orders.filter((o) => String(o.created_at).startsWith(ym));
    state.orderStats = {
      total: state.orders.length,
      thisMonth: monthOrders.length,
      thisMonthAmount: Math.round(monthOrders.reduce((s, o) => s + (o.total || 0), 0) * 100) / 100,
    };
  } catch (err) {
    state.orders = [];
    state.orderStats = null;
    toast(`读取本地订单失败：${err.message}`, true);
  }
  renderOrders();
}

/* ------------------------------ 订单列表 ------------------------------ */

function renderOrders() {
  const s = state.orders;
  const st = state.orderStats ?? { total: 0, thisMonth: 0, thisMonthAmount: 0 };
  $('#orderStats').innerHTML = `
    <div class="stat"><div class="stat-num">${st.thisMonth ?? 0}</div><div class="stat-label">本月单数</div></div>
    <div class="stat"><div class="stat-num">${money(st.thisMonthAmount ?? 0)}</div><div class="stat-label">本月金额</div></div>
    <div class="stat"><div class="stat-num">${st.total ?? 0}</div><div class="stat-label">累计单数</div></div>`;

  $('#orderCount').textContent = s.length ? `共 ${s.length} 张单` : '';
  const list = $('#orderList');
  const empty = $('#orderEmpty');

  if (!s.length) { list.innerHTML = ''; empty.hidden = false; return; }
  empty.hidden = true;

  list.innerHTML = s.map((o) => `
    <div class="item" data-id="${esc(o.id)}">
      <div class="item-main">
        <div class="item-name">${esc(o.customer_name || '（未填客户）')}</div>
        <div class="item-sub">
          ${fmtDate(o.created_at)} · ${o.item_count} 件
          ${state.scope === 'all' ? ' · ' + esc(o.sales_id) : ''}
          ${o.discount > 0 ? ' · 让利 ' + money(o.discount) : ''}
        </div>
      </div>
      <div class="item-right">
        <div class="item-price">${money(o.total)}</div>
        ${o._unsynced ? '<div class="unsynced-badge">未同步</div>' : ''}
      </div>
    </div>`).join('');

  $$('#orderList .item').forEach((el) => {
    el.addEventListener('click', () => openOrderSheet(el.dataset.id));
  });
}

/* ------------------------------ 开单弹层 ------------------------------ */

function newDraftItem() {
  return { product_id: '', qty: 1, actual_price: '' };
}

function renderOrderItems() {
  const box = $('#orderItems');
  const items = state.editingOrder?.items ?? [];

  if (!items.length) {
    box.innerHTML = `<p class="hint" style="padding:8px 0">还没有选货。点下面的按钮加一个产品。</p>`;
  } else {
    box.innerHTML = items.map((it, i) => {
      const p = state.products.find((x) => x.id === it.product_id);
      const listPrice = p ? Number(p.price) || 0 : 0;
      const actual = it.actual_price === '' || it.actual_price === null || it.actual_price === undefined
        ? listPrice : Number(it.actual_price);
      const qty = Number(it.qty) || 0;
      const sub = qty * actual;
      const cut = actual < listPrice;
      const img = p?.images?.[0];

      // 图片优先：销售要靠图确认选对货，纯文字容易拿错款。
      // 结构是「图 + 名称」在上一行，「数量 + 价格」占满下一行 ——
      // 这样图片能放大到 88px 而不把控件挤成竖排（试过并排两列，很散）。
      return `
        <div class="oitem" data-i="${i}">
          <div class="oitem-thumb">
            ${img
    ? `<img src="/assets/${esc(img)}" alt="${esc(p?.name ?? '')}" loading="lazy">`
    : '<span class="no-img-sm">无图</span>'}
          </div>
          <div class="oitem-head">
            <div class="oitem-titles">
              <div class="oitem-name">${esc(p?.name ?? '（未选产品）')}</div>
              <div class="oitem-meta">
                ${p?.category ? `<span class="oitem-cat">${esc(p.category)}</span>` : ''}
                <span class="oitem-list">目录价 ${money(listPrice)}</span>
              </div>
            </div>
            <button type="button" class="oitem-remove" data-remove="${i}" aria-label="移除">✕</button>
          </div>
          <div class="oitem-controls">
            <div class="qty">
              <button type="button" data-minus="${i}" aria-label="减少">−</button>
              <input type="number" min="1" step="1" inputmode="numeric" value="${qty}" data-qty="${i}">
              <button type="button" data-plus="${i}" aria-label="增加">＋</button>
            </div>
            <div class="oitem-price">
              <span class="price-label">成交价</span>
              <input type="number" min="0" step="1" inputmode="decimal"
                     value="${it.actual_price === '' ? listPrice : it.actual_price}" data-price="${i}">
            </div>
          </div>
          <div class="oitem-sub ${cut ? 'is-cut' : ''}">
            ${cut
    ? `已让利 ${money((listPrice - actual) * qty)} · 小计 ${money(sub)}`
    : `小计 ${money(sub)}`}
          </div>
        </div>`;
    }).join('');
  }
  recomputeTotals();
}

function recomputeTotals() {
  const items = state.editingOrder?.items ?? [];
  let listTotal = 0; let total = 0;
  for (const it of items) {
    const p = state.products.find((x) => x.id === it.product_id);
    const lp = p ? Number(p.price) || 0 : 0;
    const ap = it.actual_price === '' || it.actual_price === null || it.actual_price === undefined
      ? lp : Number(it.actual_price);
    const q = Number(it.qty) || 0;
    listTotal += lp * q;
    total += ap * q;
  }
  $('#sumList').textContent = money(listTotal);
  $('#sumDiscount').textContent = money(Math.max(0, listTotal - total));
  $('#sumTotal').textContent = money(total);
}

function openOrderSheet(id) {
  const o = id ? state.orders.find((x) => x.id === id) : null;
  state.editingOrder = o
    ? { id: o.id, items: o.items.map((it) => ({ ...it })), customer_name: o.customer_name, customer_phone: o.customer_phone, remark: o.remark }
    : { id: null, items: [], customer_name: '', customer_phone: '', remark: '' };

  $('#orderSheetTitle').textContent = o ? '改单' : '新开一单';
  $('#btnDeleteOrder').hidden = !o;
  const f = $('#orderForm');
  f.elements.id.value = o?.id ?? '';
  f.elements.customer_name.value = o?.customer_name ?? '';
  f.elements.customer_phone.value = o?.customer_phone ?? '';
  f.elements.remark.value = o?.remark ?? '';

  renderOrderItems();
  $('#orderSheet').hidden = false;
}

function closeOrderSheet() {
  $('#orderSheet').hidden = true;
  state.editingOrder = null;
}

/* ------------------------------ 选产品弹层 ------------------------------ */

/**
 * 选产品：图片优先的网格 + 多选 + 一次加入。
 *
 * 为什么改成网格而不是列表：
 *   销售认货主要靠图，不靠型号文字。竖排列表一屏只能看四五款，
 *   图片也小得看不清细节；网格一屏能扫到十几款，选错款的概率明显更低。
 *   这是参照同类小程序（家具行业常用形态）的做法。
 *
 * 为什么改成多选：一次出单选三五款货很常见，每选一款就关弹层、
 *   再点一次"加一个产品"，等于每单多按好几次。现在选完点一次"加入订单"。
 */
function renderPickSource(keyword = '') {
  const kw = keyword.trim().toLowerCase();
  const src = state.products.filter((p) => !kw
    || String(p.name).toLowerCase().includes(kw)
    || String(p.category).toLowerCase().includes(kw));

  const pick = state.picking ?? new Set();

  $('#pickSource').innerHTML = src.length ? src.map((p) => {
    const img = p.images?.[0];
    const on = pick.has(p.id);
    return `
      <button type="button" class="pick-card ${on ? 'is-on' : ''}" data-id="${esc(p.id)}">
        <div class="pick-card-img">
          ${img
    ? `<img src="/assets/${esc(img)}" alt="${esc(p.name)}" loading="lazy">`
    : '<span class="no-img">暂无图片</span>'}
          ${on ? '<span class="pick-card-check">✓</span>' : ''}
        </div>
        <div class="pick-card-body">
          <div class="pick-card-name">${esc(p.name)}</div>
          <div class="pick-card-cat">${esc(p.category || '未分类')}</div>
          <div class="pick-card-price">${money(p.price)}</div>
        </div>
      </button>`;
  }).join('') : '<p class="hint" style="grid-column:1/-1;padding:16px 0">没有匹配的产品</p>';

  // 底部确认条的状态
  const bar = $('#pickBar');
  const n = pick.size;
  bar.hidden = n === 0;
  $('#pickBarCount').textContent = `已选 ${n} 款`;

  $$('#pickSource .pick-card').forEach((el) => {
    el.addEventListener('click', () => {
      const pid = el.dataset.id;
      if (pick.has(pid)) pick.delete(pid); else pick.add(pid);
      renderPickSource(keyword);      // 重绘以更新勾选态；搜索词保持不变
    });
  });
}

/** 把选中的货一次加入订单。已在单里的数量 +1。 */
function confirmPick() {
  const pick = state.picking ?? new Set();
  if (!pick.size) return;
  const items = state.editingOrder.items;
  let added = 0;
  for (const pid of pick) {
    const exist = items.find((x) => x.product_id === pid);
    if (exist) exist.qty = Number(exist.qty) + 1;
    else { items.push({ product_id: pid, qty: 1, actual_price: '' }); added++; }
  }
  pick.clear();
  $('#pickSheet').hidden = true;
  renderOrderItems();
  toast(added ? `已加入 ${added} 款货` : '已在单里，数量 +1');
}

/* ------------------------------ 产品 ------------------------------ */

function renderProducts() {
  const list = $('#productList');
  const empty = $('#productEmpty');
  $('#productCount').textContent = `共 ${state.products.length} 款产品`;
  if (!state.products.length) { list.innerHTML = ''; empty.hidden = false; return; }
  empty.hidden = true;

  list.innerHTML = state.products.map((p) => `
    <div class="item" data-id="${esc(p.id)}">
      <div class="item-thumb">${p.images?.[0] ? `<img src="/assets/${esc(p.images[0])}" alt="">` : '无图'}</div>
      <div class="item-main">
        <div class="item-name">${esc(p.name)}</div>
        <div class="item-sub">${esc(p.category || '未分类')}</div>
        ${p.specs ? `<div class="item-specs">${esc(p.specs)}</div>` : ''}
      </div>
      <div class="item-price">${money(p.price)}</div>
    </div>`).join('');

  $$('#productList .item').forEach((el) => {
    el.addEventListener('click', () => openProductSheet(el.dataset.id));
  });
}

function setPhotoPreview(src) {
  const img = $('#photoPreview');
  if (src) { img.src = src; img.hidden = false; $('#btnPhotoClear').hidden = false; }
  else { img.removeAttribute('src'); img.hidden = true; $('#btnPhotoClear').hidden = true; }
}

function openProductSheet(id) {
  const p = id ? state.products.find((x) => x.id === id) : null;
  state.editingProduct = p ?? null;
  state.pendingPhoto = p?.images?.[0] ?? null;

  $('#sheetTitle').textContent = p ? '编辑产品' : '添加产品';
  $('#btnDelete').hidden = !p;
  const f = $('#productForm');
  f.reset();
  f.elements.id.value = p?.id ?? '';
  f.elements.name.value = p?.name ?? '';
  f.elements.category.value = p?.category ?? '';
  f.elements.specs.value = p?.specs ?? '';
  f.elements.highlights.value = p?.highlights ?? '';
  f.elements.price.value = p?.price ?? '';
  f.elements.stockStatus.value = p?.stockStatus ?? '现货';
  f.elements.supplier.value = p?.supplier ?? '';
  setPhotoPreview(state.pendingPhoto ? `/assets/${state.pendingPhoto}` : null);

  const cats = [...new Set(state.products.map((x) => x.category).filter(Boolean))].sort();
  $('#catList').innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join('');

  $('#sheet').hidden = false;
  setTimeout(() => f.elements.name.focus(), 50);
}

function closeProductSheet() {
  $('#sheet').hidden = true;
  state.editingProduct = null;
  state.pendingPhoto = null;
  setPhotoPreview(null);
}

/* ------------------------------ 画册 ------------------------------ */

function renderPickList() {
  $('#pickList').innerHTML = state.products.map((p) => `
    <div class="item ${state.selected.has(p.id) ? 'is-on' : 'is-off'}" data-id="${esc(p.id)}">
      <div class="pickbox">✓</div>
      <div class="item-thumb">${p.images?.[0] ? `<img src="/assets/${esc(p.images[0])}" alt="">` : '无图'}</div>
      <div class="item-main">
        <div class="item-name">${esc(p.name)}</div>
        <div class="item-sub">${esc(p.category || '未分类')}</div>
      </div>
      <div class="item-price">${money(p.price)}</div>
    </div>`).join('');

  $$('#pickList .item').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      renderPickList();
    });
  });
  $('#selCount').textContent = String(state.selected.size);
  applyServerPdfCapability();     // 每次渲染画册页都按服务端能力调整按钮
}

const currentSelection = () => (state.selected.size
  ? [...state.selected]
  : state.products.map((p) => p.id));

async function previewInBrowser() {
  const ids = currentSelection();
  if (!ids.length) return toast('请先添加产品', true);
  const win = window.open('', '_blank');
  if (!win) return toast('浏览器拦截了新窗口，请允许后重试', true);
  win.document.write('<p style="font-family:sans-serif;padding:24px">正在生成画册…</p>');
  try {
    /**
     * 单人模式下**在浏览器里直接排版**，不请求服务端。
     *
     * 用的是和团队模式同一份渲染器（app/shared/catalog.mjs），
     * 所以两边印出来的画册完全一致。
     * 图片通过 backend.imageToDataUri 取——本机附件或服务端图片，都行。
     *
     * 这条路**没有服务端生成 PDF 的那个汉字编码缺陷**：
     * 打印用的是用户自己设备上的浏览器与字体。
     */
    const products = state.products.filter((p) => ids.includes(p.id));
    const html = (state.solo || !backend.isOnline())
      ? await renderCatalogHtml({
        products,
        settings: state.settings,
        groupByCategory: $('#cbGroup').checked,
        resolveImage: (ref) => backend.imageToDataUri(ref),
      })
      : (await api.send('/api/catalog/preview', {
        productIds: ids, groupByCategory: $('#cbGroup').checked,
      })).html;

    win.document.open();
    win.document.write(html);
    win.document.close();
    setTimeout(() => { try { win.focus(); win.print(); } catch { /* 用户可手动打印 */ } }, 900);
    toast('已生成，请在打印窗口选择「另存为 PDF」');
  } catch (err) { win.close(); toast(err.message, true); }
}

async function serverPdf() {
  const btn = $('#btnServerPdf');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '正在生成…';
  $('#catalogResult').innerHTML = '';
  try {
    const r = await api.send('/api/catalog/pdf', 'POST', { groupByCategory: $('#cbGroup').checked });
    $('#catalogResult').innerHTML = `
      <div class="result">✅ 已生成 ${r.pages} 页画册（${r.sizeKB} KB）<br>
      <a href="${esc(r.downloadUrl)}" download>点击下载 PDF</a></div>`;
    toast('画册已生成');
  } catch (err) {
    const hint = err.payload?.hint ? `<br><span class="hint">${esc(err.payload.hint)}</span>` : '';
    $('#catalogResult').innerHTML = `<div class="result" style="border-color:#e6c9c6">⚠ ${esc(err.message)}${hint}</div>`;
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
    applyServerPdfCapability();
  }
}

/**
 * 按服务端能力调整「服务端生成」按钮。
 *
 * 为什么要在界面里体现：
 *   浏览器是可选组件（便携包带不带差 279 MB）。
 *   没有它时如果按钮看起来正常，用户点了才收到报错——
 *   对不懂技术的人是纯粹的困惑。不如**事先说清楚**，
 *   并把主按钮指向真正可用的那条路（打印为 PDF）。
 *
 * 另外：Linux 服务器上生成的 PDF 有已知缺陷（部分汉字被写成康熙部首，
 * 复制与搜索失效），所以「服务端生成」默认**不是**主按钮。
 */
function applyServerPdfCapability() {
  const cap = state.capabilities?.serverPdf;
  const btn = $('#btnServerPdf');
  const prev = $('#btnPreview');
  const note = $('#serverPdfNote');
  if (!cap) return;                       // 还没探测到，保持原样

  if (cap.available) {
    btn.disabled = false;
    btn.textContent = '服务端生成';
    btn.title = `用 ${cap.driver} 生成`;
    // 主按钮留给「打印为 PDF」——它没有编码缺陷
    btn.classList.remove('btn-primary');
    prev.classList.add('btn-primary');
    if (note) note.hidden = false;
    return;
  }

  // 不可用：把按钮变成"说明"而不是"报错入口"
  btn.textContent = '服务端生成（未安装）';
  btn.title = cap.reason ?? '';
  btn.disabled = false;                   // 仍可点，点了给出解释而不是静默
  prev.classList.add('btn-primary');
  if (note) note.hidden = true;           // 没装就没这个缺陷可言，别吓人
}

/* ------------------------------ 设置 ------------------------------ */

function renderSettings() {
  const f = $('#settingsForm');
  const s = state.settings;
  f.elements.companyName.value = s.companyName ?? '';
  f.elements.tagline.value = s.tagline ?? '';
  f.elements.contact.value = s.contact ?? '';
  f.elements.validityDays.value = s.validityDays ?? 30;

  const logo = $('#logoPreview');
  if (s.logo) { logo.src = `/assets/${s.logo}`; logo.hidden = false; $('#btnLogoClear').hidden = false; }
  else { logo.removeAttribute('src'); logo.hidden = true; $('#btnLogoClear').hidden = true; }

  renderAccounts();
}

/* ------------------------------ 账号管理（仅管理员） ------------------------------ */

const isAdmin = () => !!state.viewer?.admin;

/**
 * 渲染账号列表。
 *
 * 普通销售看到的只是"同事名单"（不含邮箱，服务端也不会下发）；
 * 管理员看到完整资料，并且每一项可以点开编辑。
 *
 * ⚠️ 刻意**不提供"点一下就变成他"**——那等于无需密码就能变成任何人，
 *    会让按 sales_id 的订单隔离失效。换身份一律走登录。
 */
function renderAccounts() {
  /**
   * 单人模式没有"账号"这件事——本机就是使用者本人。
   * 账号管理、同事名单、备份之外的设置都该藏起来。
   *
   * ⚠️ 这个判断必须在**这里**做，不能只在 applySoloChrome() 里做：
   *    renderAccounts() 会在每次数据加载后被调用，
   *    它会把按钮重新显示出来，覆盖掉之前的隐藏（实测踩到）。
   */
  if (state.solo) {
    $('#btnAddAccount').hidden = true;
    $('#salesAdminHint').hidden = true;
    $('#salesHint').hidden = true;
    $('#salesList').hidden = true;
    const head = $('#salesList')?.previousElementSibling;
    if (head) head.hidden = true;
    return;
  }

  const admin = isAdmin();
  $('#btnAddAccount').hidden = !admin;
  $('#salesAdminHint').hidden = !admin;
  $('#salesHint').hidden = admin;

  if (!state.sales.length) {
    $('#salesList').innerHTML = '<p class="hint">还没有账号</p>';
    return;
  }

  $('#salesList').innerHTML = state.sales.map((x) => {
    const off = x.active === false;
    const tags = [
      x.admin ? '<span class="tag tag-admin">管理员</span>' : '',
      off ? '<span class="tag tag-off">已停用</span>' : '',
      x.must_change_password ? '<span class="tag tag-warn">待改密</span>' : '',
    ].filter(Boolean).join('');
    const contact = x.email ? `邮箱 ${x.email}` : '';
    const me = x.name === state.viewer?.name;

    return `
      <div class="item ${off ? 'is-off' : ''}" ${admin ? `data-acct="${esc(x.name)}"` : ''}>
        <div class="item-main">
          <div class="item-name">${esc(x.display || x.name)}${me ? ' <span class="tag">我</span>' : ''}</div>
          <div class="item-sub">${esc(x.name)} ${tags}</div>
          ${admin && contact ? `<div class="item-specs">${esc(contact)}</div>` : ''}
        </div>
        ${admin ? '<div class="item-right"><span class="chev">›</span></div>' : ''}
      </div>`;
  }).join('');

  if (admin) {
    $$('#salesList .item[data-acct]').forEach((el) => {
      el.addEventListener('click', () => openAcctSheet(el.dataset.acct));
    });
  }
}

/** 打开账号编辑弹层。name 为空表示新建。 */
function openAcctSheet(name) {
  const f = $('#acctForm');
  f.reset();
  $('#onceBox').hidden = true;

  const acct = name ? state.sales.find((x) => x.name === name) : null;
  const isNew = !acct;

  $('#acctTitle').textContent = isNew ? '新建账号' : `编辑：${acct.display || acct.name}`;
  $('#btnResetPw').hidden = isNew;
  $('#btnDelAcct').hidden = isNew;
  $('#acctFlags').hidden = false;

  if (acct) {
    f.elements.originalName.value = acct.name;
    f.elements.name.value = acct.name;
    f.elements.name.readOnly = true;    // 登录名就是订单归属，改名会让历史订单对不上
    f.elements.display.value = acct.display ?? '';
    f.elements.email.value = acct.email ?? '';
    f.elements.admin.checked = !!acct.admin;
    f.elements.active.checked = acct.active !== false;
  } else {
    f.elements.name.readOnly = false;
    f.elements.active.checked = true;
  }

  $('#acctSheet').hidden = false;
}

/** 展示一次性密码。关掉就再也拿不回来，所以样式上要显眼。 */
function showOncePassword(pw) {
  $('#oncePw').textContent = pw;
  $('#onceBox').hidden = false;
  $('#onceBox').scrollIntoView({ block: 'nearest' });
}

/* ------------------------------ 加载与绑定 ------------------------------ */

/**
 * 单人模式：没有服务端，本机就是全部。
 *
 * 用一个固定的本机身份（登录名 local），这样订单的 sales_id
 * 语义和团队模式完全一致——将来同步到服务器时不用改数据。
 */
async function loadSolo() {
  state.solo = true;
  state.products = await backend.listProducts();
  state.settings = await backend.getSettings();
  state.capabilities = { serverPdf: { available: false } };

  state.sales = [{ name: 'local', display: '我', admin: true, active: true }];
  state.viewer = state.sales[0];
  state.signedIn = true;              // 单机模式不需要登录
  state.scope = 'all';
  state.selected = new Set(state.products.map((p) => p.id));

  $('#loginGate').hidden = true;
  applySoloChrome();

  renderViewer();
  renderProducts();
  renderPickList();
  renderSettings();
}

/**
 * 单人模式下调整界面文案与可见项。
 *
 * 要让用户一眼看出"这台手机自己就是全部"，而不是以为"连不上服务器、坏了"。
 * 措辞上避免"离线""失败"这类词——单机是正常用法，不是故障。
 */
function applySoloChrome() {
  const note = $('#soloNote');
  if (note) note.hidden = false;
  document.body.classList.add('is-solo');

  // 单人模式没有"同步"这件事，隐藏同步状态芯片
  const chip = $('#syncChip');
  if (chip) chip.hidden = true;

  // 账号相关的显示由 renderAccounts() 负责（它每次加载都会跑，
  // 在这里设会被覆盖掉）。这里只管备份入口。
  for (const id of ['backupSep', 'backupHead', 'backupBox']) {
    const el = document.getElementById(id);
    if (el) el.hidden = false;
  }
  refreshUsageText();
}

/** 显示本地占用了多少空间，让用户心里有数。 */
async function refreshUsageText() {
  const el = $('#usageText');
  if (!el) return;
  try {
    const u = await backend.usage();
    if (!u) { el.textContent = ''; return; }
    el.textContent = `本机已存 ${u.docs} 条记录，约占用 ${u.mb} MB。`;
  } catch { el.textContent = ''; }
}

/**
 * 按当前模式重新加载数据。
 *
 * 为什么要有它：界面里很多地方改完数据要刷新，但两种模式的刷新方式不同
 * （团队要重新拉服务端、单人是重读本地）。有一个统一入口，
 * 就不会出现"某个按钮在单机模式下没刷新"这种漏。
 */
async function reloadData() {
  if (state.solo) await loadSolo();
  else await loadAll();
}

async function loadAll() {
  // 团队模式：订单读**本地库**（离线可用），服务端提供身份、产品与设置
  const [prodRes, setRes, salesRes, sessionRes] = await Promise.all([
    api.get('/api/products'),
    api.get('/api/settings'),
    api.get('/api/sales'),
    api.get('/api/session'),
  ]);
  state.products = prodRes.products;
  state.settings = setRes;
  state.sales = salesRes.sales;

  // 能力探测失败不该影响主流程（比如离线时）——失败就保持 null，界面按原样
  try {
    state.capabilities = await api.get('/api/capabilities');
    /**
     * 按服务端能力选同步传输方式。
     *
     *   'hub'   中心自带存储，走 /api/hub/*
     *   'couch' 有 CouchDB，走复制协议代理 /api/sync/*
     *
     * 老版本服务端不返回 syncMode——那种情况按 'couch' 走（保持原行为）。
     */
    sync.setTransport(state.capabilities?.syncMode ?? 'couch');
  } catch { /* 忽略 */ }
  state.viewer = sessionRes.sales ?? null;
  state.signedIn = !!sessionRes.signedIn;
  state.scope = state.viewer?.admin ? 'all' : 'own';
  state.selected = new Set(state.products.map((p) => p.id));   // 默认全选，少一次操作

  // 没登录就挡住界面：没有身份就没有 sales_id，出的单无处归属
  $('#loginGate').hidden = state.signedIn;

  renderViewer();
  renderProducts();
  renderPickList();
  renderSettings();
  renderSyncChip();

  if (state.signedIn) {
    await refreshOrdersFromLocal();
  } else {
    state.orders = [];
    state.orderStats = null;
    renderOrders();
  }
}

function bind() {
  // 标签
  $$('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.remove('is-active'));
      $$('.panel').forEach((x) => x.classList.remove('is-active'));
      t.classList.add('is-active');
      $(`#panel-${t.dataset.tab}`).classList.add('is-active');
    });
  });

  const sheetPairs = [
    ['#whoSheet', '#btnWho', '#btnCloseWho'],
    ['#orderSheet', '#btnNewOrder', '#btnCloseOrder'],
    ['#pickSheet', null, '#btnClosePick'],
    ['#sheet', null, '#btnCloseSheet'],
  ];
  for (const [sheet, openBtn, closeBtn] of sheetPairs) {
    if (openBtn) $(openBtn).addEventListener('click', () => {
      if (sheet === '#orderSheet') openOrderSheet(null);
      else $(sheet).hidden = false;
    });
    if (closeBtn) $(closeBtn).addEventListener('click', () => {
      if (sheet === '#orderSheet') closeOrderSheet();
      else if (sheet === '#sheet') closeProductSheet();
      else $(sheet).hidden = true;
    });
    $(sheet).addEventListener('click', (e) => {
      if (e.target.id !== sheet.slice(1)) return;
      if (sheet === '#orderSheet') closeOrderSheet();
      else if (sheet === '#sheet') closeProductSheet();
      else $(sheet).hidden = true;
    });
  }

  $('#btnNewOrder2').addEventListener('click', () => openOrderSheet(null));

  /* ---- 开单：加产品 ---- */
  $('#btnAddItem').addEventListener('click', () => {
    if (!state.products.length) return toast('还没有产品，先去「产品」里添加', true);
    $('#pickSearch').value = '';
    state.picking.clear();          // 每次打开都是干净状态，不残留上次的勾选
    renderPickSource();
    $('#pickSheet').hidden = false;
  });
  $('#pickSearch').addEventListener('input', (e) => renderPickSource(e.target.value));
  $('#btnPickConfirm').addEventListener('click', confirmPick);

  /* ---- 开单：数量与价格（事件委托，因为项目会重绘）---- */
  $('#orderItems').addEventListener('click', (e) => {
    const items = state.editingOrder?.items ?? [];
    const rm = e.target.closest('[data-remove]');
    const mi = e.target.closest('[data-minus]');
    const pl = e.target.closest('[data-plus]');
    if (rm) { items.splice(Number(rm.dataset.remove), 1); renderOrderItems(); return; }
    if (mi) { const i = Number(mi.dataset.minus); items[i].qty = Math.max(1, (Number(items[i].qty) || 1) - 1); renderOrderItems(); return; }
    if (pl) { const i = Number(pl.dataset.plus); items[i].qty = (Number(items[i].qty) || 0) + 1; renderOrderItems(); }
  });
  $('#orderItems').addEventListener('input', (e) => {
    const items = state.editingOrder?.items ?? [];
    const q = e.target.closest('[data-qty]');
    const pr = e.target.closest('[data-price]');
    if (q) { items[Number(q.dataset.qty)].qty = Math.max(1, Number(q.value) || 1); recomputeTotals(); }
    if (pr) { items[Number(pr.dataset.price)].actual_price = pr.value === '' ? '' : Number(pr.value); recomputeTotals(); }
  });
  $('#orderItems').addEventListener('change', () => renderOrderItems());

  /* ---- 开单：保存（写入本地库，再立即同步）---- */
  $('#orderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const d = state.editingOrder;
    if (!d) return;
    if (!d.items.length) return toast('先加一个产品', true);
    if (d.items.some((x) => !x.product_id)) return toast('有条目没选产品', true);
    if (!state.viewer) return toast('还没选使用人', true);

    const items = d.items.map((x) => {
      const p = state.products.find((y) => y.id === x.product_id);
      const listPrice = p ? Number(p.price) || 0 : 0;
      const actual = x.actual_price === '' || x.actual_price === null || x.actual_price === undefined
        ? listPrice : Number(x.actual_price);
      return {
        product_id: x.product_id,
        product_name: p?.name ?? '',
        qty: Number(x.qty) || 1,
        list_price: listPrice,
        actual_price: actual,
      };
    });
    const totals = computeTotals(items);
    const meta = {
      customer_name: f.elements.customer_name.value.trim(),
      customer_phone: f.elements.customer_phone.value.trim(),
      remark: f.elements.remark.value.trim(),
      items,
      ...totals,
    };
    // 快照：closeOrderSheet 会把 state.editingOrder 置空
    const editingId = d.id;

    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    const oldLabel = btn.textContent;
    btn.textContent = '保存中…';
    try {
      if (editingId) await sync.updateOrderDoc(editingId, meta);
      else await sync.newOrder(meta, state.viewer.name);

      closeOrderSheet();
      state.syncInfo = sync.snapshot();
      renderSyncChip();
      await refreshOrdersFromLocal();
      toast(state.syncInfo.pending > 0
        ? '已保存到本机，正在同步…'
        : '已保存并同步');
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = oldLabel;
    }
  });

  /* ---- 开单：删除（软删除）---- */
  $('#btnDeleteOrder').addEventListener('click', async () => {
    const id = $('#orderForm').elements.id.value;
    if (!id) return;
    if (!confirm('确定删除这张单？\n\n（只会标记为已删除，不会真的抹掉记录）')) return;
    try {
      await sync.softDeleteOrder(id);
      closeOrderSheet();
      state.syncInfo = sync.snapshot();
      renderSyncChip();
      await refreshOrdersFromLocal();
      toast('已删除');
    } catch (err) { toast(err.message, true); }
  });

  /* ---- 产品 ---- */
  $('#btnAdd').addEventListener('click', () => openProductSheet(null));
  $('#btnAddEmpty').addEventListener('click', () => openProductSheet(null));

  $('#btnCamera').addEventListener('click', () => $('#photoInput').click());
  $('#photoInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await compressImage(file);
      // 走 backend：团队模式存服务端，单人模式存本机附件
      const blob = await (await fetch(dataUrl)).blob();
      const saved = await backend.saveImage(blob, file.name || 'photo.jpg');
      state.pendingPhoto = saved.id;
      setPhotoPreview(await backend.imageToDataUri(saved.id));
      toast(`图片已就绪（${saved.sizeKB} KB）`);
    } catch (err) { toast(err.message, true); }
  });
  $('#btnPhotoClear').addEventListener('click', () => {
    state.pendingPhoto = null;
    setPhotoPreview(null);
  });

  $('#productForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
      id: f.elements.id.value || undefined,
      name: f.elements.name.value.trim(),
      category: f.elements.category.value.trim() || '未分类',
      specs: f.elements.specs.value.trim(),
      highlights: f.elements.highlights.value.trim(),
      price: Number(f.elements.price.value) || 0,
      stockStatus: f.elements.stockStatus.value,
      supplier: f.elements.supplier.value.trim(),
      images: state.pendingPhoto ? [state.pendingPhoto] : [],
    };
    if (!body.name) return toast('请填写产品名称', true);
    try {
      await backend.saveProduct(body);
      closeProductSheet();
      await reloadData();
      toast('已保存');
    } catch (err) { toast(err.message, true); }
  });

  $('#btnDelete').addEventListener('click', async () => {
    const id = $('#productForm').elements.id.value;
    if (!id) return;
    if (!confirm('确定删除这个产品？')) return;
    try {
      await backend.deleteProduct(id);
      closeProductSheet();
      await reloadData();
      toast('已删除');
    } catch (err) { toast(err.message, true); }
  });

  /* ---- 画册 ---- */
  $('#btnSelectAll').addEventListener('click', () => {
    state.selected = new Set(state.products.map((p) => p.id));
    renderPickList();
  });
  $('#btnSelectNone').addEventListener('click', () => {
    state.selected = new Set();
    renderPickList();
  });
  $('#btnPreview').addEventListener('click', previewInBrowser);
  $('#btnServerPdf').addEventListener('click', serverPdf);

  /* ---- 设置 ---- */
  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      state.settings = await backend.saveSettings({
        companyName: f.elements.companyName.value.trim(),
        tagline: f.elements.tagline.value.trim(),
        contact: f.elements.contact.value.trim(),
        validityDays: Number(f.elements.validityDays.value) || 0,
      });
      $('#saveMsg').hidden = false;
      setTimeout(() => { $('#saveMsg').hidden = true; }, 2000);
      toast('已保存');
    } catch (err) { toast(err.message, true); }
  });
  $('#btnLogoPick').addEventListener('click', () => $('#logoInput').click());
  $('#logoInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await compressImage(file, { maxEdge: 600, quality: 0.9 });
      const blob = await (await fetch(dataUrl)).blob();
      const saved = await backend.saveImage(blob, file.name || 'logo.png');
      state.settings = await backend.saveSettings({ logo: saved.id });
      renderSettings();
      toast('Logo 已保存');
    } catch (err) { toast(err.message, true); }
  });
  $('#btnLogoClear').addEventListener('click', async () => {
    state.settings = await backend.saveSettings({ logo: null });
    renderSettings();
  });

  /* ---- 备份（单人模式下必需）----
   *
   * 数据只在浏览器里，清理浏览器数据 / 换手机 / 系统回收存储都会丢。
   * 没有导出这一条，这东西不能用来存真的生意。
   */
  $('#btnExport').addEventListener('click', async () => {
    const btn = $('#btnExport');
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '正在打包…';
    try {
      const backup = await backend.exportAll();
      const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `家具工具备份-${stamp}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast(`已导出（${backup.products.length} 款产品）`);
    } catch (err) {
      toast(`导出失败：${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  $('#btnImport').addEventListener('click', () => $('#importInput').click());
  $('#importInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      const localCount = state.products.length;
      const incoming = backup.products?.length ?? 0;

      /**
       * 合并而不是覆盖。
       *
       * 用户点"恢复"通常是"把这台手机补齐"，不是"把本机清空"。
       * 覆盖会静默丢掉本机新拍的产品——那是最难发现、最伤人的那种数据丢失。
       */
      const msg = localCount
        ? `本机现有 ${localCount} 款产品，备份里有 ${incoming} 款。\n\n`
          + '确定合并？\n（同一个产品的会以备份里的为准，本机独有的会保留）'
        : `备份里有 ${incoming} 款产品，导入到这台设备？`;
      if (!confirm(msg)) return;

      const r = await backend.importAll(backup);
      await reloadData();
      toast(`已恢复 ${r.products} 款产品`);
    } catch (err) {
      toast(`恢复失败：${err.message}`, true);
    }
  });
  /* ---- 同步状态：点一下立即同步 ---- */
  $('#syncChip').addEventListener('click', async () => {
    if (!state.signedIn) { toast('请先登录', true); return; }
    try {
      await sync.resync();
      state.syncInfo = sync.snapshot();
      renderSyncChip();
      await refreshOrdersFromLocal();
      toast(state.syncInfo.lastError ? `同步有问题：${state.syncInfo.lastError}` : '已同步');
    } catch (err) {
      state.syncInfo = sync.snapshot();
      renderSyncChip();
      toast(`同步失败：${err.message}`, true);
    }
  });

  /* ---- 登录（密码认证）---- */
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '登录中…';
    try {
      const r = await signIn(f.elements.name.value, f.elements.password.value);
      f.reset();
      toast(`已登录：${r.sales.display || r.sales.name}`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });

  /* ---- 修改密码 ---- */
  $('#btnClosePw').addEventListener('click', () => { $('#pwSheet').hidden = true; });
  $('#pwSheet').addEventListener('click', (e) => { if (e.target.id === 'pwSheet') $('#pwSheet').hidden = true; });
  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.elements.newPassword.value !== f.elements.confirmPassword.value) {
      return toast('两次输入的新密码不一致', true);
    }
    try {
      await api.send('/api/password', 'POST', {
        oldPassword: f.elements.oldPassword.value,
        newPassword: f.elements.newPassword.value,
      });
      $('#pwSheet').hidden = true;
      f.reset();
      await loadAll();
      toast('密码已修改');
    } catch (err) {
      toast(err.message, true);
    }
  });

  /* ---- 账号管理（仅管理员） ---- */
  $('#btnAddAccount').addEventListener('click', () => openAcctSheet(null));
  $('#btnCloseAcct').addEventListener('click', () => { $('#acctSheet').hidden = true; });
  $('#acctSheet').addEventListener('click', (e) => {
    if (e.target.id === 'acctSheet') $('#acctSheet').hidden = true;
  });
  /**
   * 点「我已记下」→ 藏掉一次性密码框，**并关掉整个弹层**。
   *
   * 关掉弹层是必要的：不关的话弹层仍盖在列表上方，
   * 管理员想接着看刚建好的账号（或再建一个）时点不动列表，
   * 会以为"界面卡住了"。实测就是这个问题。
   */
  $('#btnOnceDone').addEventListener('click', () => {
    $('#onceBox').hidden = true;
    $('#acctSheet').hidden = true;
  });

  $('#acctForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const original = f.elements.originalName.value;
    const body = {
      name: f.elements.name.value.trim().toLowerCase(),
      display: f.elements.display.value.trim(),
      email: f.elements.email.value.trim(),
    };
    try {
      if (original) {
        Object.assign(body, {
          admin: f.elements.admin.checked,
          active: f.elements.active.checked,
        });
        // 登录名不允许改（它就是订单归属），所以不传 name
        delete body.name;
        await api.send(`/api/sales/${encodeURIComponent(original)}`, 'POST', body);
        toast('账号已更新');
      } else {
        const r = await api.send('/api/sales', 'POST', { ...body, admin: f.elements.admin.checked });
        // 一次性密码必须当场展示——库里只存哈希，之后拿不回来
        showOncePassword(r.initialPassword);
        toast('账号已创建');
      }
      await loadAll();
      if (!original) {
        $('#acctTitle').textContent = '账号已创建';
        $('#btnResetPw').hidden = true;
        $('#btnDelAcct').hidden = true;
      }
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#btnResetPw').addEventListener('click', async () => {
    const name = $('#acctForm').elements.originalName.value;
    if (!name) return;
    if (!confirm(`确定重置「${name}」的密码？\n\n他的旧密码会立即失效，登录后需要设置新密码。`)) return;
    try {
      const r = await api.send(`/api/sales/${encodeURIComponent(name)}/reset-password`, 'POST');
      showOncePassword(r.temporaryPassword);
      await loadAll();
      toast('密码已重置');
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#btnDelAcct').addEventListener('click', async () => {
    const name = $('#acctForm').elements.originalName.value;
    if (!name) return;
    if (!confirm(
      `确定删除账号「${name}」？\n\n`
      + '注意：他名下已有的订单不会被删除，仍保留在系统里（订单是经营凭证）。\n'
      + '如果只是人离职了，建议改用「停用」而不是删除。',
    )) return;
    try {
      await api.send(`/api/sales/${encodeURIComponent(name)}`, 'DELETE');
      $('#acctSheet').hidden = true;
      await loadAll();
      toast('账号已删除（订单保留）');
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ------------------------------ 启动 ------------------------------ */

async function boot() {
  // 本地库先就绪：这样即使服务端暂时不可达，界面也能显示已有数据
  try {
    sync.onCreate((info) => {
      state.syncInfo = info;
      renderSyncChip();
      // 同步完成后刷新列表与未同步提示
      if (!info.syncing && state.signedIn && !state.solo) {
        refreshOrdersFromLocal().catch(() => {});
      }
    });
    await sync.init();
  } catch (err) {
    toast(`本地库初始化失败：${err.message}`, true);
  }

  bind();

  /**
   * 自动判断运行形态：连得上服务端就是团队，连不上就是单人。
   *
   * **不让用户选**——那等于让他理解一个他不需要理解的概念。
   * 而且单人模式是完全正常的用法，不是"降级"，
   * 所以界面上也不能出现"连接失败"这类字眼。
   */
  await backend.probe();
  if (backend.isSolo()) {
    await loadSolo();
    await refreshOrdersFromLocal();       // 订单本来就存在本地
  } else {
    // 单人模式没有服务端，也就没有传输层可言
    sync.setTransport(backend.capabilities()?.syncMode ?? 'couch');
    await loadAll();
    // 周期性兜底同步：销售不会手动点，得自己跑
    setInterval(() => {
      if (state.signedIn) sync.sync().catch(() => {});
    }, 30000);
  }
}

boot().catch((e) => toast(`加载失败：${e.message}`, true));
