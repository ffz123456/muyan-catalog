import * as sync from "./syncdb.js";
import * as backend from "./backend.js";
import { renderCatalogHtml } from "./shared/catalog.js";
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const api = {
  async get(path) {
    const r = await fetch(path);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `\u8BF7\u6C42\u5931\u8D25\uFF08${r.status}\uFF09`);
    return d;
  },
  async send(path, method, body) {
    const r = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === void 0 ? void 0 : JSON.stringify(body)
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(d.error || `\u8BF7\u6C42\u5931\u8D25\uFF08${r.status}\uFF09`);
      e.payload = d;
      throw e;
    }
    return d;
  }
};
let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("is-error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, isError ? 5e3 : 2600);
}
const money = (v) => "\xA5" + Number(v || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const esc = (s) => String(s != null ? s : "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function compressImage(file, { maxEdge = 1600, quality = 0.82 } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("\u8BFB\u53D6\u56FE\u7247\u5931\u8D25"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("\u8FD9\u5F20\u56FE\u7247\u65E0\u6CD5\u8BC6\u522B"));
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const cv = document.createElement("canvas");
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
const state = {
  products: [],
  orders: [],
  settings: {},
  sales: [],
  viewer: null,
  signedIn: false,
  scope: "own",
  selected: /* @__PURE__ */ new Set(),
  // 画册里勾选的产品
  picking: /* @__PURE__ */ new Set(),
  // 选产品弹层里勾选的（尚未加入订单）
  editingProduct: null,
  /**
   * 正在编辑的产品图片，**数量不设上限**。
   * 每项：{ id: 图片引用, preview: 给 <img src> 用的地址 }
   * 第一项就是画册主图。
   */
  pendingImages: [],
  editingOrder: null,
  // { id?, items:[], ... }
  syncInfo: sync.snapshot(),
  /** 服务端能力探测结果（例如有没有浏览器能出 PDF）。见 applyServerPdfCapability */
  capabilities: null,
  /** 单人模式：连不上服务端，本机就是全部。见 backend.mjs 与 loadSolo() */
  solo: false
};
function renderSyncChip() {
  const info = state.syncInfo;
  const dot = $("#syncDot");
  const text = $("#syncText");
  let label;
  let cls;
  if (!state.signedIn) {
    label = "\u672A\u767B\u5F55";
    cls = "is-off";
  } else if (info.syncing) {
    label = "\u540C\u6B65\u4E2D\u2026";
    cls = "is-busy";
  } else if (info.pending > 0) {
    label = `\u672A\u540C\u6B65 ${info.pending}`;
    cls = "is-warn";
  } else if (info.lastError) {
    label = "\u540C\u6B65\u5F02\u5E38";
    cls = "is-err";
  } else if (!info.online) {
    label = "\u79BB\u7EBF";
    cls = "is-warn";
  } else {
    label = "\u5DF2\u540C\u6B65";
    cls = "is-ok";
  }
  text.textContent = label;
  dot.className = `sync-dot ${cls}`;
  $("#syncChip").title = [
    label,
    info.lastSyncAt ? `\u4E0A\u6B21\u540C\u6B65 ${fmtDate(info.lastSyncAt.toISOString())}` : "\u5C1A\u672A\u540C\u6B65",
    info.lastError ? `\u9519\u8BEF\uFF1A${info.lastError}` : null,
    "\u70B9\u4E00\u4E0B\u7ACB\u5373\u540C\u6B65"
  ].filter(Boolean).join("\n");
}
function computeTotals(items) {
  let listTotal = 0;
  let total = 0;
  let count = 0;
  for (const it of items) {
    const p = state.products.find((x) => x.id === it.product_id);
    const lp = p ? Number(p.price) || 0 : 0;
    const ap = it.actual_price === "" || it.actual_price === null || it.actual_price === void 0 ? lp : Number(it.actual_price);
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
    item_count: count
  };
}
function renderViewer() {
  const v = state.viewer;
  $("#whoName").textContent = v ? v.display || v.name : "\u672A\u767B\u5F55";
  const opts = state.sales.map((s) => `<option value="${esc(s.name)}">${esc(s.display || s.name)}\uFF08${esc(s.name)}\uFF09</option>`).join("");
  const sel = $("#loginUser");
  if (sel) {
    const keep = sel.value;
    sel.innerHTML = opts;
    if (keep && state.sales.some((s) => s.name === keep)) sel.value = keep;
  }
  $("#whoList").innerHTML = v ? `<div class="item" id="whoSignOut">
         <div class="item-main">
           <div class="item-name">\u9000\u51FA\u767B\u5F55</div>
           <div class="item-sub">\u5F53\u524D\uFF1A${esc(v.display || v.name)}\uFF08${esc(v.name)}\uFF09</div>
         </div>
       </div>
       <div class="item" id="whoChangePw">
         <div class="item-main">
           <div class="item-name">\u4FEE\u6539\u5BC6\u7801</div>
           <div class="item-sub">\u6362\u4E00\u4E2A\u53EA\u6709\u4F60\u77E5\u9053\u7684\u5BC6\u7801</div>
         </div>
       </div>` : '<p class="hint" style="padding:8px 0">\u5C1A\u672A\u767B\u5F55</p>';
  const so = $("#whoSignOut");
  if (so) so.addEventListener("click", signOut);
  const cp = $("#whoChangePw");
  if (cp) cp.addEventListener("click", () => {
    $("#whoSheet").hidden = true;
    $("#pwSheet").hidden = false;
    $("#pwMsg").hidden = true;
    $("#pwForm").reset();
  });
  const note = $("#scopeNote");
  if (state.solo) {
    note.innerHTML = "\u{1F4F1} \u8FD9\u4E2A\u6587\u4EF6\u5C31\u662F\u4F60\u7684\u5168\u90E8\u5DE5\u5177\uFF0C<strong>\u6570\u636E\u53EA\u5B58\u5728\u8FD9\u53F0\u8BBE\u5907\u4E0A</strong>\uFF0C\u4E0D\u4F1A\u4E0A\u4F20\u5230\u4EFB\u4F55\u5730\u65B9\u3002";
    note.hidden = false;
  } else if (state.scope === "all") {
    note.innerHTML = "\u{1F440} \u4F60\u662F\u7BA1\u7406\u8005\uFF0C<strong>\u53EF\u4EE5\u770B\u5230\u5168\u90E8\u9500\u552E\u7684\u8BA2\u5355</strong>\u3002";
    note.hidden = false;
  } else {
    note.innerHTML = "\u{1F512} \u4F60\u53EA\u80FD\u770B\u5230<strong>\u81EA\u5DF1\u51FA\u7684\u5355</strong>\u3002\u522B\u4EBA\u7684\u5355\u4E0D\u4F1A\u663E\u793A\u3002";
    note.hidden = false;
  }
}
async function signIn(name, password) {
  var _a;
  const r = await api.send("/api/session", "POST", { name, password });
  state.signedIn = true;
  $("#loginGate").hidden = true;
  $("#whoSheet").hidden = true;
  await loadAll();
  await sync.resync();
  await refreshOrdersFromLocal();
  if ((_a = r.sales) == null ? void 0 : _a.must_change_password) {
    $("#pwSheet").hidden = false;
    $("#pwMsg").hidden = false;
    $("#pwMsg").textContent = "\u8FD9\u662F\u521D\u59CB\u5BC6\u7801\uFF0C\u8BF7\u6539\u6210\u53EA\u6709\u4F60\u77E5\u9053\u7684\u5BC6\u7801\u3002";
    $("#pwForm").reset();
  }
  return r;
}
async function signOut() {
  try {
    await api.send("/api/session", "DELETE");
  } catch {
  }
  state.signedIn = false;
  state.viewer = null;
  state.orders = [];
  state.orderStats = null;
  try {
    await sync.wipeLocal();
  } catch {
  }
  $("#whoSheet").hidden = true;
  $("#loginGate").hidden = false;
  renderViewer();
  renderOrders();
  renderSyncChip();
  toast("\u5DF2\u9000\u51FA\u767B\u5F55");
}
async function refreshOrdersFromLocal() {
  if (!state.signedIn) {
    state.orders = [];
    state.orderStats = null;
    renderOrders();
    return;
  }
  try {
    state.orders = await sync.listOrders();
    const now = /* @__PURE__ */ new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const monthOrders = state.orders.filter((o) => String(o.created_at).startsWith(ym));
    state.orderStats = {
      total: state.orders.length,
      thisMonth: monthOrders.length,
      thisMonthAmount: Math.round(monthOrders.reduce((s, o) => s + (o.total || 0), 0) * 100) / 100
    };
  } catch (err) {
    state.orders = [];
    state.orderStats = null;
    toast(`\u8BFB\u53D6\u672C\u5730\u8BA2\u5355\u5931\u8D25\uFF1A${err.message}`, true);
  }
  renderOrders();
}
function renderOrders() {
  var _a, _b, _c, _d;
  const s = state.orders;
  const st = (_a = state.orderStats) != null ? _a : { total: 0, thisMonth: 0, thisMonthAmount: 0 };
  $("#orderStats").innerHTML = `
    <div class="stat"><div class="stat-num">${(_b = st.thisMonth) != null ? _b : 0}</div><div class="stat-label">\u672C\u6708\u5355\u6570</div></div>
    <div class="stat"><div class="stat-num">${money((_c = st.thisMonthAmount) != null ? _c : 0)}</div><div class="stat-label">\u672C\u6708\u91D1\u989D</div></div>
    <div class="stat"><div class="stat-num">${(_d = st.total) != null ? _d : 0}</div><div class="stat-label">\u7D2F\u8BA1\u5355\u6570</div></div>`;
  $("#orderCount").textContent = s.length ? `\u5171 ${s.length} \u5F20\u5355` : "";
  const list = $("#orderList");
  const empty = $("#orderEmpty");
  if (!s.length) {
    list.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.innerHTML = s.map((o) => `
    <div class="item" data-id="${esc(o.id)}">
      <div class="item-main">
        <div class="item-name">${esc(o.customer_name || "\uFF08\u672A\u586B\u5BA2\u6237\uFF09")}</div>
        <div class="item-sub">
          ${fmtDate(o.created_at)} \xB7 ${o.item_count} \u4EF6
          ${state.scope === "all" ? " \xB7 " + esc(o.sales_id) : ""}
          ${o.discount > 0 ? " \xB7 \u8BA9\u5229 " + money(o.discount) : ""}
        </div>
      </div>
      <div class="item-right">
        <div class="item-price">${money(o.total)}</div>
        ${o._unsynced ? '<div class="unsynced-badge">\u672A\u540C\u6B65</div>' : ""}
      </div>
    </div>`).join("");
  $$("#orderList .item").forEach((el) => {
    el.addEventListener("click", () => openOrderSheet(el.dataset.id));
  });
}
function newDraftItem() {
  return { product_id: "", qty: 1, actual_price: "" };
}
function renderOrderItems() {
  var _a, _b;
  const box = $("#orderItems");
  const items = (_b = (_a = state.editingOrder) == null ? void 0 : _a.items) != null ? _b : [];
  if (!items.length) {
    box.innerHTML = `<p class="hint" style="padding:8px 0">\u8FD8\u6CA1\u6709\u9009\u8D27\u3002\u70B9\u4E0B\u9762\u7684\u6309\u94AE\u52A0\u4E00\u4E2A\u4EA7\u54C1\u3002</p>`;
  } else {
    box.innerHTML = items.map((it, i) => {
      var _a2, _b2, _c;
      const p = state.products.find((x) => x.id === it.product_id);
      const listPrice = p ? Number(p.price) || 0 : 0;
      const actual = it.actual_price === "" || it.actual_price === null || it.actual_price === void 0 ? listPrice : Number(it.actual_price);
      const qty = Number(it.qty) || 0;
      const sub = qty * actual;
      const cut = actual < listPrice;
      const img = (_a2 = p == null ? void 0 : p.images) == null ? void 0 : _a2[0];
      return `
        <div class="oitem" data-i="${i}">
          <div class="oitem-thumb">
            ${img ? `<img src="/assets/${esc(img)}" alt="${esc((_b2 = p == null ? void 0 : p.name) != null ? _b2 : "")}" loading="lazy">` : '<span class="no-img-sm">\u65E0\u56FE</span>'}
          </div>
          <div class="oitem-head">
            <div class="oitem-titles">
              <div class="oitem-name">${esc((_c = p == null ? void 0 : p.name) != null ? _c : "\uFF08\u672A\u9009\u4EA7\u54C1\uFF09")}</div>
              <div class="oitem-meta">
                ${(p == null ? void 0 : p.category) ? `<span class="oitem-cat">${esc(p.category)}</span>` : ""}
                <span class="oitem-list">\u76EE\u5F55\u4EF7 ${money(listPrice)}</span>
              </div>
            </div>
            <button type="button" class="oitem-remove" data-remove="${i}" aria-label="\u79FB\u9664">\u2715</button>
          </div>
          <div class="oitem-controls">
            <div class="qty">
              <button type="button" data-minus="${i}" aria-label="\u51CF\u5C11">\u2212</button>
              <input type="number" min="1" step="1" inputmode="numeric" value="${qty}" data-qty="${i}">
              <button type="button" data-plus="${i}" aria-label="\u589E\u52A0">\uFF0B</button>
            </div>
            <div class="oitem-price">
              <span class="price-label">\u6210\u4EA4\u4EF7</span>
              <input type="number" min="0" step="1" inputmode="decimal"
                     value="${it.actual_price === "" ? listPrice : it.actual_price}" data-price="${i}">
            </div>
          </div>
          <div class="oitem-sub ${cut ? "is-cut" : ""}">
            ${cut ? `\u5DF2\u8BA9\u5229 ${money((listPrice - actual) * qty)} \xB7 \u5C0F\u8BA1 ${money(sub)}` : `\u5C0F\u8BA1 ${money(sub)}`}
          </div>
        </div>`;
    }).join("");
  }
  recomputeTotals();
}
function recomputeTotals() {
  var _a, _b;
  const items = (_b = (_a = state.editingOrder) == null ? void 0 : _a.items) != null ? _b : [];
  let listTotal = 0;
  let total = 0;
  for (const it of items) {
    const p = state.products.find((x) => x.id === it.product_id);
    const lp = p ? Number(p.price) || 0 : 0;
    const ap = it.actual_price === "" || it.actual_price === null || it.actual_price === void 0 ? lp : Number(it.actual_price);
    const q = Number(it.qty) || 0;
    listTotal += lp * q;
    total += ap * q;
  }
  $("#sumList").textContent = money(listTotal);
  $("#sumDiscount").textContent = money(Math.max(0, listTotal - total));
  $("#sumTotal").textContent = money(total);
}
function openOrderSheet(id) {
  var _a, _b, _c, _d;
  const o = id ? state.orders.find((x) => x.id === id) : null;
  state.editingOrder = o ? { id: o.id, items: o.items.map((it) => ({ ...it })), customer_name: o.customer_name, customer_phone: o.customer_phone, remark: o.remark } : { id: null, items: [], customer_name: "", customer_phone: "", remark: "" };
  $("#orderSheetTitle").textContent = o ? "\u6539\u5355" : "\u65B0\u5F00\u4E00\u5355";
  $("#btnDeleteOrder").hidden = !o;
  const f = $("#orderForm");
  f.elements.id.value = (_a = o == null ? void 0 : o.id) != null ? _a : "";
  f.elements.customer_name.value = (_b = o == null ? void 0 : o.customer_name) != null ? _b : "";
  f.elements.customer_phone.value = (_c = o == null ? void 0 : o.customer_phone) != null ? _c : "";
  f.elements.remark.value = (_d = o == null ? void 0 : o.remark) != null ? _d : "";
  renderOrderItems();
  $("#orderSheet").hidden = false;
}
function closeOrderSheet() {
  $("#orderSheet").hidden = true;
  state.editingOrder = null;
}
function renderPickSource(keyword = "") {
  var _a;
  const kw = keyword.trim().toLowerCase();
  const src = state.products.filter((p) => !kw || String(p.name).toLowerCase().includes(kw) || String(p.category).toLowerCase().includes(kw));
  const pick = (_a = state.picking) != null ? _a : /* @__PURE__ */ new Set();
  $("#pickSource").innerHTML = src.length ? src.map((p) => {
    var _a2;
    const img = (_a2 = p.images) == null ? void 0 : _a2[0];
    const on = pick.has(p.id);
    return `
      <button type="button" class="pick-card ${on ? "is-on" : ""}" data-id="${esc(p.id)}">
        <div class="pick-card-img">
          ${img ? `<img src="/assets/${esc(img)}" alt="${esc(p.name)}" loading="lazy">` : '<span class="no-img">\u6682\u65E0\u56FE\u7247</span>'}
          ${on ? '<span class="pick-card-check">\u2713</span>' : ""}
        </div>
        <div class="pick-card-body">
          <div class="pick-card-name">${esc(p.name)}</div>
          <div class="pick-card-cat">${esc(p.category || "\u672A\u5206\u7C7B")}</div>
          <div class="pick-card-price">${money(p.price)}</div>
        </div>
      </button>`;
  }).join("") : '<p class="hint" style="grid-column:1/-1;padding:16px 0">\u6CA1\u6709\u5339\u914D\u7684\u4EA7\u54C1</p>';
  const bar = $("#pickBar");
  const n = pick.size;
  bar.hidden = n === 0;
  $("#pickBarCount").textContent = `\u5DF2\u9009 ${n} \u6B3E`;
  $$("#pickSource .pick-card").forEach((el) => {
    el.addEventListener("click", () => {
      const pid = el.dataset.id;
      if (pick.has(pid)) pick.delete(pid);
      else pick.add(pid);
      renderPickSource(keyword);
    });
  });
}
function confirmPick() {
  var _a;
  const pick = (_a = state.picking) != null ? _a : /* @__PURE__ */ new Set();
  if (!pick.size) return;
  const items = state.editingOrder.items;
  let added = 0;
  for (const pid of pick) {
    const exist = items.find((x) => x.product_id === pid);
    if (exist) exist.qty = Number(exist.qty) + 1;
    else {
      items.push({ product_id: pid, qty: 1, actual_price: "" });
      added++;
    }
  }
  pick.clear();
  $("#pickSheet").hidden = true;
  renderOrderItems();
  toast(added ? `\u5DF2\u52A0\u5165 ${added} \u6B3E\u8D27` : "\u5DF2\u5728\u5355\u91CC\uFF0C\u6570\u91CF +1");
}
function renderProducts() {
  const list = $("#productList");
  const empty = $("#productEmpty");
  $("#productCount").textContent = `\u5171 ${state.products.length} \u6B3E\u4EA7\u54C1`;
  if (!state.products.length) {
    list.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  list.innerHTML = state.products.map((p) => {
    var _a;
    return `
    <div class="item" data-id="${esc(p.id)}">
      <div class="item-thumb">${((_a = p.images) == null ? void 0 : _a[0]) ? `<img src="/assets/${esc(p.images[0])}" alt="">` : "\u65E0\u56FE"}</div>
      <div class="item-main">
        <div class="item-name">${esc(p.name)}</div>
        <div class="item-sub">${esc(p.category || "\u672A\u5206\u7C7B")}</div>
        ${p.specs ? `<div class="item-specs">${esc(p.specs)}</div>` : ""}
      </div>
      <div class="item-price">${money(p.price)}</div>
    </div>`;
  }).join("");
  $$("#productList .item").forEach((el) => {
    el.addEventListener("click", () => openProductSheet(el.dataset.id));
  });
}
function renderPhotoList() {
  const box = $("#photoList");
  const list = state.pendingImages;
  if (!box) return;
  if (!list.length) {
    box.innerHTML = '<div class="photo-empty">\u8FD8\u6CA1\u6709\u56FE\u7247\uFF0C\u70B9\u4E0B\u9762\u7684\u6309\u94AE\u62CD\u7167\u6216\u9009\u56FE</div>';
    $("#btnPhotoClear").hidden = true;
    return;
  }
  $("#btnPhotoClear").hidden = false;
  box.innerHTML = list.map((ref, i) => `
    <div class="photo-item" data-i="${i}">
      <img src="${esc(ref.preview)}" alt="">
      ${i === 0 ? '<span class="photo-badge">\u4E3B\u56FE</span>' : `<span class="photo-no">${i + 1}</span>`}
      <button type="button" class="photo-del" data-act="del" data-i="${i}" title="\u5220\u9664\u8FD9\u5F20">\xD7</button>
      <div class="photo-move">
        <button type="button" data-act="left" data-i="${i}" ${i === 0 ? "disabled" : ""} title="\u5F80\u524D\u632A">\u2039</button>
        <button type="button" data-act="right" data-i="${i}" ${i === list.length - 1 ? "disabled" : ""} title="\u5F80\u540E\u632A">\u203A</button>
      </div>
    </div>`).join("");
  box.querySelectorAll("button[data-act]").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const i = Number(b.dataset.i);
      const act = b.dataset.act;
      if (act === "del") state.pendingImages.splice(i, 1);
      if (act === "left" && i > 0) {
        [state.pendingImages[i - 1], state.pendingImages[i]] = [state.pendingImages[i], state.pendingImages[i - 1]];
      }
      if (act === "right" && i < state.pendingImages.length - 1) {
        [state.pendingImages[i + 1], state.pendingImages[i]] = [state.pendingImages[i], state.pendingImages[i + 1]];
      }
      renderPhotoList();
    });
  });
}
let soloPreviewGen = 0;
async function fillSoloPreviews() {
  var _a;
  const gen = ++soloPreviewGen;
  const refs = state.pendingImages.map((x) => x.id);
  for (let i = 0; i < refs.length; i++) {
    if (gen !== soloPreviewGen) return;
    try {
      const uri = await backend.imageToDataUri(refs[i]);
      if (gen !== soloPreviewGen) return;
      if (uri && ((_a = state.pendingImages[i]) == null ? void 0 : _a.id) === refs[i]) {
        state.pendingImages[i].preview = uri;
        renderPhotoList();
      }
    } catch {
    }
  }
}
function openProductSheet(id) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i;
  const p = id ? state.products.find((x) => x.id === id) : null;
  state.editingProduct = p != null ? p : null;
  state.pendingImages = ((_a = p == null ? void 0 : p.images) != null ? _a : []).map((ref) => ({ id: ref, preview: `/assets/${ref}` }));
  if (state.solo) fillSoloPreviews();
  $("#sheetTitle").textContent = p ? "\u7F16\u8F91\u4EA7\u54C1" : "\u6DFB\u52A0\u4EA7\u54C1";
  $("#btnDelete").hidden = !p;
  const f = $("#productForm");
  f.reset();
  f.elements.id.value = (_b = p == null ? void 0 : p.id) != null ? _b : "";
  f.elements.name.value = (_c = p == null ? void 0 : p.name) != null ? _c : "";
  f.elements.category.value = (_d = p == null ? void 0 : p.category) != null ? _d : "";
  f.elements.specs.value = (_e = p == null ? void 0 : p.specs) != null ? _e : "";
  f.elements.highlights.value = (_f = p == null ? void 0 : p.highlights) != null ? _f : "";
  f.elements.price.value = (_g = p == null ? void 0 : p.price) != null ? _g : "";
  f.elements.stockStatus.value = (_h = p == null ? void 0 : p.stockStatus) != null ? _h : "\u73B0\u8D27";
  f.elements.supplier.value = (_i = p == null ? void 0 : p.supplier) != null ? _i : "";
  renderPhotoList();
  const cats = [...new Set(state.products.map((x) => x.category).filter(Boolean))].sort();
  $("#catList").innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join("");
  $("#sheet").hidden = false;
  setTimeout(() => f.elements.name.focus(), 50);
}
function closeProductSheet() {
  $("#sheet").hidden = true;
  state.editingProduct = null;
  state.pendingImages = [];
}
function renderPickList() {
  $("#pickList").innerHTML = state.products.map((p) => {
    var _a;
    return `
    <div class="item ${state.selected.has(p.id) ? "is-on" : "is-off"}" data-id="${esc(p.id)}">
      <div class="pickbox">\u2713</div>
      <div class="item-thumb">${((_a = p.images) == null ? void 0 : _a[0]) ? `<img src="/assets/${esc(p.images[0])}" alt="">` : "\u65E0\u56FE"}</div>
      <div class="item-main">
        <div class="item-name">${esc(p.name)}</div>
        <div class="item-sub">${esc(p.category || "\u672A\u5206\u7C7B")}</div>
      </div>
      <div class="item-price">${money(p.price)}</div>
    </div>`;
  }).join("");
  $$("#pickList .item").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      renderPickList();
    });
  });
  $("#selCount").textContent = String(state.selected.size);
  applyServerPdfCapability();
}
const currentSelection = () => state.selected.size ? [...state.selected] : state.products.map((p) => p.id);
async function previewInBrowser() {
  const ids = currentSelection();
  if (!ids.length) return toast("\u8BF7\u5148\u6DFB\u52A0\u4EA7\u54C1", true);
  const win = window.open("", "_blank");
  if (!win) return toast("\u6D4F\u89C8\u5668\u62E6\u622A\u4E86\u65B0\u7A97\u53E3\uFF0C\u8BF7\u5141\u8BB8\u540E\u91CD\u8BD5", true);
  win.document.write('<p style="font-family:sans-serif;padding:24px">\u6B63\u5728\u751F\u6210\u753B\u518C\u2026</p>');
  try {
    const products = state.products.filter((p) => ids.includes(p.id));
    const html = state.solo || !backend.isOnline() ? await renderCatalogHtml({
      products,
      settings: state.settings,
      groupByCategory: $("#cbGroup").checked,
      resolveImage: (ref) => backend.imageToDataUri(ref)
    }) : (await api.send("/api/catalog/preview", {
      productIds: ids,
      groupByCategory: $("#cbGroup").checked
    })).html;
    win.document.open();
    win.document.write(html);
    win.document.close();
    setTimeout(() => {
      try {
        win.focus();
        win.print();
      } catch {
      }
    }, 900);
    toast("\u5DF2\u751F\u6210\uFF0C\u8BF7\u5728\u6253\u5370\u7A97\u53E3\u9009\u62E9\u300C\u53E6\u5B58\u4E3A PDF\u300D");
  } catch (err) {
    win.close();
    toast(err.message, true);
  }
}
async function serverPdf() {
  var _a;
  const btn = $("#btnServerPdf");
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "\u6B63\u5728\u751F\u6210\u2026";
  $("#catalogResult").innerHTML = "";
  try {
    const r = await api.send("/api/catalog/pdf", "POST", { groupByCategory: $("#cbGroup").checked });
    $("#catalogResult").innerHTML = `
      <div class="result">\u2705 \u5DF2\u751F\u6210 ${r.pages} \u9875\u753B\u518C\uFF08${r.sizeKB} KB\uFF09<br>
      <a href="${esc(r.downloadUrl)}" download>\u70B9\u51FB\u4E0B\u8F7D PDF</a></div>`;
    toast("\u753B\u518C\u5DF2\u751F\u6210");
  } catch (err) {
    const hint = ((_a = err.payload) == null ? void 0 : _a.hint) ? `<br><span class="hint">${esc(err.payload.hint)}</span>` : "";
    $("#catalogResult").innerHTML = `<div class="result" style="border-color:#e6c9c6">\u26A0 ${esc(err.message)}${hint}</div>`;
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
    applyServerPdfCapability();
  }
}
function applyServerPdfCapability() {
  var _a, _b;
  const cap = (_a = state.capabilities) == null ? void 0 : _a.serverPdf;
  const btn = $("#btnServerPdf");
  const prev = $("#btnPreview");
  const note = $("#serverPdfNote");
  if (!cap) return;
  if (cap.available) {
    btn.disabled = false;
    btn.textContent = "\u670D\u52A1\u7AEF\u751F\u6210";
    btn.title = `\u7528 ${cap.driver} \u751F\u6210`;
    btn.classList.remove("btn-primary");
    prev.classList.add("btn-primary");
    if (note) note.hidden = false;
    return;
  }
  btn.textContent = "\u670D\u52A1\u7AEF\u751F\u6210\uFF08\u672A\u5B89\u88C5\uFF09";
  btn.title = (_b = cap.reason) != null ? _b : "";
  btn.disabled = false;
  prev.classList.add("btn-primary");
  if (note) note.hidden = true;
}
function renderSettings() {
  var _a, _b, _c, _d;
  const f = $("#settingsForm");
  const s = state.settings;
  f.elements.companyName.value = (_a = s.companyName) != null ? _a : "";
  f.elements.tagline.value = (_b = s.tagline) != null ? _b : "";
  f.elements.contact.value = (_c = s.contact) != null ? _c : "";
  f.elements.validityDays.value = (_d = s.validityDays) != null ? _d : 30;
  const logo = $("#logoPreview");
  if (s.logo) {
    logo.src = `/assets/${s.logo}`;
    logo.hidden = false;
    $("#btnLogoClear").hidden = false;
  } else {
    logo.removeAttribute("src");
    logo.hidden = true;
    $("#btnLogoClear").hidden = true;
  }
  renderAccounts();
}
const isAdmin = () => {
  var _a;
  return !!((_a = state.viewer) == null ? void 0 : _a.admin);
};
function renderAccounts() {
  var _a;
  if (state.solo) {
    $("#btnAddAccount").hidden = true;
    $("#salesAdminHint").hidden = true;
    $("#salesHint").hidden = true;
    $("#salesList").hidden = true;
    const head = (_a = $("#salesList")) == null ? void 0 : _a.previousElementSibling;
    if (head) head.hidden = true;
    return;
  }
  const admin = isAdmin();
  $("#btnAddAccount").hidden = !admin;
  $("#salesAdminHint").hidden = !admin;
  $("#salesHint").hidden = admin;
  if (!state.sales.length) {
    $("#salesList").innerHTML = '<p class="hint">\u8FD8\u6CA1\u6709\u8D26\u53F7</p>';
    return;
  }
  $("#salesList").innerHTML = state.sales.map((x) => {
    var _a2;
    const off = x.active === false;
    const tags = [
      x.admin ? '<span class="tag tag-admin">\u7BA1\u7406\u5458</span>' : "",
      off ? '<span class="tag tag-off">\u5DF2\u505C\u7528</span>' : "",
      x.must_change_password ? '<span class="tag tag-warn">\u5F85\u6539\u5BC6</span>' : ""
    ].filter(Boolean).join("");
    const contact = x.email ? `\u90AE\u7BB1 ${x.email}` : "";
    const me = x.name === ((_a2 = state.viewer) == null ? void 0 : _a2.name);
    return `
      <div class="item ${off ? "is-off" : ""}" ${admin ? `data-acct="${esc(x.name)}"` : ""}>
        <div class="item-main">
          <div class="item-name">${esc(x.display || x.name)}${me ? ' <span class="tag">\u6211</span>' : ""}</div>
          <div class="item-sub">${esc(x.name)} ${tags}</div>
          ${admin && contact ? `<div class="item-specs">${esc(contact)}</div>` : ""}
        </div>
        ${admin ? '<div class="item-right"><span class="chev">\u203A</span></div>' : ""}
      </div>`;
  }).join("");
  if (admin) {
    $$("#salesList .item[data-acct]").forEach((el) => {
      el.addEventListener("click", () => openAcctSheet(el.dataset.acct));
    });
  }
}
function openAcctSheet(name) {
  var _a, _b;
  const f = $("#acctForm");
  f.reset();
  $("#onceBox").hidden = true;
  const acct = name ? state.sales.find((x) => x.name === name) : null;
  const isNew = !acct;
  $("#acctTitle").textContent = isNew ? "\u65B0\u5EFA\u8D26\u53F7" : `\u7F16\u8F91\uFF1A${acct.display || acct.name}`;
  $("#btnResetPw").hidden = isNew;
  $("#btnDelAcct").hidden = isNew;
  $("#acctFlags").hidden = false;
  if (acct) {
    f.elements.originalName.value = acct.name;
    f.elements.name.value = acct.name;
    f.elements.name.readOnly = true;
    f.elements.display.value = (_a = acct.display) != null ? _a : "";
    f.elements.email.value = (_b = acct.email) != null ? _b : "";
    f.elements.admin.checked = !!acct.admin;
    f.elements.active.checked = acct.active !== false;
  } else {
    f.elements.name.readOnly = false;
    f.elements.active.checked = true;
  }
  $("#acctSheet").hidden = false;
}
function showOncePassword(pw) {
  $("#oncePw").textContent = pw;
  $("#onceBox").hidden = false;
  $("#onceBox").scrollIntoView({ block: "nearest" });
}
async function loadSolo() {
  state.solo = true;
  state.products = await backend.listProducts();
  state.settings = await backend.getSettings();
  state.capabilities = { serverPdf: { available: false } };
  state.sales = [{ name: "local", display: "\u6211", admin: true, active: true }];
  state.viewer = state.sales[0];
  state.signedIn = true;
  state.scope = "all";
  state.selected = new Set(state.products.map((p) => p.id));
  $("#loginGate").hidden = true;
  applySoloChrome();
  renderViewer();
  renderProducts();
  renderPickList();
  renderSettings();
}
function applySoloChrome() {
  const note = $("#soloNote");
  if (note) note.hidden = false;
  document.body.classList.add("is-solo");
  const chip = $("#syncChip");
  if (chip) chip.hidden = true;
  for (const id of ["backupSep", "backupHead", "backupBox"]) {
    const el = document.getElementById(id);
    if (el) el.hidden = false;
  }
  refreshUsageText();
}
async function refreshUsageText() {
  const el = $("#usageText");
  if (!el) return;
  try {
    const u = await backend.usage();
    if (!u) {
      el.textContent = "";
      return;
    }
    el.textContent = `\u672C\u673A\u5DF2\u5B58 ${u.docs} \u6761\u8BB0\u5F55\uFF0C\u7EA6\u5360\u7528 ${u.mb} MB\u3002`;
  } catch {
    el.textContent = "";
  }
}
async function reloadData() {
  if (state.solo) await loadSolo();
  else await loadAll();
}
async function loadAll() {
  var _a, _b, _c, _d;
  const [prodRes, setRes, salesRes, sessionRes] = await Promise.all([
    api.get("/api/products"),
    api.get("/api/settings"),
    api.get("/api/sales"),
    api.get("/api/session")
  ]);
  state.products = prodRes.products;
  state.settings = setRes;
  state.sales = salesRes.sales;
  try {
    state.capabilities = await api.get("/api/capabilities");
    sync.setTransport((_b = (_a = state.capabilities) == null ? void 0 : _a.syncMode) != null ? _b : "couch");
  } catch {
  }
  state.viewer = (_c = sessionRes.sales) != null ? _c : null;
  state.signedIn = !!sessionRes.signedIn;
  state.scope = ((_d = state.viewer) == null ? void 0 : _d.admin) ? "all" : "own";
  state.selected = new Set(state.products.map((p) => p.id));
  $("#loginGate").hidden = state.signedIn;
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
  $$(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      $$(".tab").forEach((x) => x.classList.remove("is-active"));
      $$(".panel").forEach((x) => x.classList.remove("is-active"));
      t.classList.add("is-active");
      $(`#panel-${t.dataset.tab}`).classList.add("is-active");
    });
  });
  const sheetPairs = [
    ["#whoSheet", "#btnWho", "#btnCloseWho"],
    ["#orderSheet", "#btnNewOrder", "#btnCloseOrder"],
    ["#pickSheet", null, "#btnClosePick"],
    ["#sheet", null, "#btnCloseSheet"]
  ];
  for (const [sheet, openBtn, closeBtn] of sheetPairs) {
    if (openBtn) $(openBtn).addEventListener("click", () => {
      if (sheet === "#orderSheet") openOrderSheet(null);
      else $(sheet).hidden = false;
    });
    if (closeBtn) $(closeBtn).addEventListener("click", () => {
      if (sheet === "#orderSheet") closeOrderSheet();
      else if (sheet === "#sheet") closeProductSheet();
      else $(sheet).hidden = true;
    });
    $(sheet).addEventListener("click", (e) => {
      if (e.target.id !== sheet.slice(1)) return;
      if (sheet === "#orderSheet") closeOrderSheet();
      else if (sheet === "#sheet") closeProductSheet();
      else $(sheet).hidden = true;
    });
  }
  $("#btnNewOrder2").addEventListener("click", () => openOrderSheet(null));
  $("#btnAddItem").addEventListener("click", () => {
    if (!state.products.length) return toast("\u8FD8\u6CA1\u6709\u4EA7\u54C1\uFF0C\u5148\u53BB\u300C\u4EA7\u54C1\u300D\u91CC\u6DFB\u52A0", true);
    $("#pickSearch").value = "";
    state.picking.clear();
    renderPickSource();
    $("#pickSheet").hidden = false;
  });
  $("#pickSearch").addEventListener("input", (e) => renderPickSource(e.target.value));
  $("#btnPickConfirm").addEventListener("click", confirmPick);
  $("#orderItems").addEventListener("click", (e) => {
    var _a, _b;
    const items = (_b = (_a = state.editingOrder) == null ? void 0 : _a.items) != null ? _b : [];
    const rm = e.target.closest("[data-remove]");
    const mi = e.target.closest("[data-minus]");
    const pl = e.target.closest("[data-plus]");
    if (rm) {
      items.splice(Number(rm.dataset.remove), 1);
      renderOrderItems();
      return;
    }
    if (mi) {
      const i = Number(mi.dataset.minus);
      items[i].qty = Math.max(1, (Number(items[i].qty) || 1) - 1);
      renderOrderItems();
      return;
    }
    if (pl) {
      const i = Number(pl.dataset.plus);
      items[i].qty = (Number(items[i].qty) || 0) + 1;
      renderOrderItems();
    }
  });
  $("#orderItems").addEventListener("input", (e) => {
    var _a, _b;
    const items = (_b = (_a = state.editingOrder) == null ? void 0 : _a.items) != null ? _b : [];
    const q = e.target.closest("[data-qty]");
    const pr = e.target.closest("[data-price]");
    if (q) {
      items[Number(q.dataset.qty)].qty = Math.max(1, Number(q.value) || 1);
      recomputeTotals();
    }
    if (pr) {
      items[Number(pr.dataset.price)].actual_price = pr.value === "" ? "" : Number(pr.value);
      recomputeTotals();
    }
  });
  $("#orderItems").addEventListener("change", () => renderOrderItems());
  $("#orderForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const d = state.editingOrder;
    if (!d) return;
    if (!d.items.length) return toast("\u5148\u52A0\u4E00\u4E2A\u4EA7\u54C1", true);
    if (d.items.some((x) => !x.product_id)) return toast("\u6709\u6761\u76EE\u6CA1\u9009\u4EA7\u54C1", true);
    if (!state.viewer) return toast("\u8FD8\u6CA1\u9009\u4F7F\u7528\u4EBA", true);
    const items = d.items.map((x) => {
      var _a;
      const p = state.products.find((y) => y.id === x.product_id);
      const listPrice = p ? Number(p.price) || 0 : 0;
      const actual = x.actual_price === "" || x.actual_price === null || x.actual_price === void 0 ? listPrice : Number(x.actual_price);
      return {
        product_id: x.product_id,
        product_name: (_a = p == null ? void 0 : p.name) != null ? _a : "",
        qty: Number(x.qty) || 1,
        list_price: listPrice,
        actual_price: actual
      };
    });
    const totals = computeTotals(items);
    const meta = {
      customer_name: f.elements.customer_name.value.trim(),
      customer_phone: f.elements.customer_phone.value.trim(),
      remark: f.elements.remark.value.trim(),
      items,
      ...totals
    };
    const editingId = d.id;
    const btn = f.querySelector("button[type=submit]");
    btn.disabled = true;
    const oldLabel = btn.textContent;
    btn.textContent = "\u4FDD\u5B58\u4E2D\u2026";
    try {
      if (editingId) await sync.updateOrderDoc(editingId, meta);
      else await sync.newOrder(meta, state.viewer.name);
      closeOrderSheet();
      state.syncInfo = sync.snapshot();
      renderSyncChip();
      await refreshOrdersFromLocal();
      toast(state.syncInfo.pending > 0 ? "\u5DF2\u4FDD\u5B58\u5230\u672C\u673A\uFF0C\u6B63\u5728\u540C\u6B65\u2026" : "\u5DF2\u4FDD\u5B58\u5E76\u540C\u6B65");
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = oldLabel;
    }
  });
  $("#btnDeleteOrder").addEventListener("click", async () => {
    const id = $("#orderForm").elements.id.value;
    if (!id) return;
    if (!confirm("\u786E\u5B9A\u5220\u9664\u8FD9\u5F20\u5355\uFF1F\n\n\uFF08\u53EA\u4F1A\u6807\u8BB0\u4E3A\u5DF2\u5220\u9664\uFF0C\u4E0D\u4F1A\u771F\u7684\u62B9\u6389\u8BB0\u5F55\uFF09")) return;
    try {
      await sync.softDeleteOrder(id);
      closeOrderSheet();
      state.syncInfo = sync.snapshot();
      renderSyncChip();
      await refreshOrdersFromLocal();
      toast("\u5DF2\u5220\u9664");
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#btnAdd").addEventListener("click", () => openProductSheet(null));
  $("#btnAddEmpty").addEventListener("click", () => openProductSheet(null));
  $("#btnCamera").addEventListener("click", () => $("#photoInput").click());
  $("#photoInput").addEventListener("change", async (e) => {
    var _a;
    const files = [...(_a = e.target.files) != null ? _a : []];
    e.target.value = "";
    if (!files.length) return;
    let ok = 0;
    const fails = [];
    for (const file of files) {
      try {
        const dataUrl = await compressImage(file);
        const blob = await (await fetch(dataUrl)).blob();
        const saved = await backend.saveImage(blob, file.name || "photo.jpg");
        state.pendingImages.push({
          id: saved.id,
          // 立刻用刚压好的 data URI 显示，不等服务端回读——省一次往返，也不会闪
          preview: dataUrl
        });
        renderPhotoList();
        ok++;
      } catch (err) {
        fails.push(`${file.name || "\u56FE\u7247"}\uFF1A${err.message}`);
      }
    }
    if (ok) toast(files.length > 1 ? `\u5DF2\u52A0\u5165 ${ok} \u5F20` : "\u56FE\u7247\u5DF2\u5C31\u7EEA");
    if (fails.length) {
      toast(`${fails.length} \u5F20\u5931\u8D25\uFF1A${fails[0]}`, true);
    }
  });
  $("#btnPhotoClear").addEventListener("click", () => {
    if (!state.pendingImages.length) return;
    if (!confirm(`\u79FB\u9664\u5168\u90E8 ${state.pendingImages.length} \u5F20\u56FE\u7247\uFF1F
\uFF08\u4FDD\u5B58\u524D\u90FD\u53EF\u4EE5\u53CD\u6094\uFF09`)) return;
    state.pendingImages = [];
    renderPhotoList();
  });
  $("#productForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
      id: f.elements.id.value || void 0,
      name: f.elements.name.value.trim(),
      category: f.elements.category.value.trim() || "\u672A\u5206\u7C7B",
      specs: f.elements.specs.value.trim(),
      highlights: f.elements.highlights.value.trim(),
      price: Number(f.elements.price.value) || 0,
      stockStatus: f.elements.stockStatus.value,
      supplier: f.elements.supplier.value.trim(),
      // 全部图片按当前顺序提交，第一张就是画册主图
      images: state.pendingImages.map((x) => x.id)
    };
    if (!body.name) return toast("\u8BF7\u586B\u5199\u4EA7\u54C1\u540D\u79F0", true);
    try {
      await backend.saveProduct(body);
      closeProductSheet();
      await reloadData();
      toast("\u5DF2\u4FDD\u5B58");
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#btnDelete").addEventListener("click", async () => {
    const id = $("#productForm").elements.id.value;
    if (!id) return;
    if (!confirm("\u786E\u5B9A\u5220\u9664\u8FD9\u4E2A\u4EA7\u54C1\uFF1F")) return;
    try {
      await backend.deleteProduct(id);
      closeProductSheet();
      await reloadData();
      toast("\u5DF2\u5220\u9664");
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#btnSelectAll").addEventListener("click", () => {
    state.selected = new Set(state.products.map((p) => p.id));
    renderPickList();
  });
  $("#btnSelectNone").addEventListener("click", () => {
    state.selected = /* @__PURE__ */ new Set();
    renderPickList();
  });
  $("#btnPreview").addEventListener("click", previewInBrowser);
  $("#btnServerPdf").addEventListener("click", serverPdf);
  $("#settingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      state.settings = await backend.saveSettings({
        companyName: f.elements.companyName.value.trim(),
        tagline: f.elements.tagline.value.trim(),
        contact: f.elements.contact.value.trim(),
        validityDays: Number(f.elements.validityDays.value) || 0
      });
      $("#saveMsg").hidden = false;
      setTimeout(() => {
        $("#saveMsg").hidden = true;
      }, 2e3);
      toast("\u5DF2\u4FDD\u5B58");
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#btnLogoPick").addEventListener("click", () => $("#logoInput").click());
  $("#logoInput").addEventListener("change", async (e) => {
    var _a;
    const file = (_a = e.target.files) == null ? void 0 : _a[0];
    e.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await compressImage(file, { maxEdge: 600, quality: 0.9 });
      const blob = await (await fetch(dataUrl)).blob();
      const saved = await backend.saveImage(blob, file.name || "logo.png");
      state.settings = await backend.saveSettings({ logo: saved.id });
      renderSettings();
      toast("Logo \u5DF2\u4FDD\u5B58");
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#btnLogoClear").addEventListener("click", async () => {
    state.settings = await backend.saveSettings({ logo: null });
    renderSettings();
  });
  $("#btnExport").addEventListener("click", async () => {
    const btn = $("#btnExport");
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = "\u6B63\u5728\u6253\u5305\u2026";
    try {
      const backup = await backend.exportAll();
      const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
      const d = /* @__PURE__ */ new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `\u5BB6\u5177\u5DE5\u5177\u5907\u4EFD-${stamp}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5e3);
      toast(`\u5DF2\u5BFC\u51FA\uFF08${backup.products.length} \u6B3E\u4EA7\u54C1\uFF09`);
    } catch (err) {
      toast(`\u5BFC\u51FA\u5931\u8D25\uFF1A${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });
  $("#btnImport").addEventListener("click", () => $("#importInput").click());
  $("#importInput").addEventListener("change", async (e) => {
    var _a, _b, _c;
    const file = (_a = e.target.files) == null ? void 0 : _a[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      const localCount = state.products.length;
      const incoming = (_c = (_b = backup.products) == null ? void 0 : _b.length) != null ? _c : 0;
      const msg = localCount ? `\u672C\u673A\u73B0\u6709 ${localCount} \u6B3E\u4EA7\u54C1\uFF0C\u5907\u4EFD\u91CC\u6709 ${incoming} \u6B3E\u3002

\u786E\u5B9A\u5408\u5E76\uFF1F
\uFF08\u540C\u4E00\u4E2A\u4EA7\u54C1\u7684\u4F1A\u4EE5\u5907\u4EFD\u91CC\u7684\u4E3A\u51C6\uFF0C\u672C\u673A\u72EC\u6709\u7684\u4F1A\u4FDD\u7559\uFF09` : `\u5907\u4EFD\u91CC\u6709 ${incoming} \u6B3E\u4EA7\u54C1\uFF0C\u5BFC\u5165\u5230\u8FD9\u53F0\u8BBE\u5907\uFF1F`;
      if (!confirm(msg)) return;
      const r = await backend.importAll(backup);
      await reloadData();
      toast(`\u5DF2\u6062\u590D ${r.products} \u6B3E\u4EA7\u54C1`);
    } catch (err) {
      toast(`\u6062\u590D\u5931\u8D25\uFF1A${err.message}`, true);
    }
  });
  $("#syncChip").addEventListener("click", async () => {
    if (!state.signedIn) {
      toast("\u8BF7\u5148\u767B\u5F55", true);
      return;
    }
    try {
      await sync.resync();
      state.syncInfo = sync.snapshot();
      renderSyncChip();
      await refreshOrdersFromLocal();
      toast(state.syncInfo.lastError ? `\u540C\u6B65\u6709\u95EE\u9898\uFF1A${state.syncInfo.lastError}` : "\u5DF2\u540C\u6B65");
    } catch (err) {
      state.syncInfo = sync.snapshot();
      renderSyncChip();
      toast(`\u540C\u6B65\u5931\u8D25\uFF1A${err.message}`, true);
    }
  });
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector("button[type=submit]");
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = "\u767B\u5F55\u4E2D\u2026";
    try {
      const r = await signIn(f.elements.name.value, f.elements.password.value);
      f.reset();
      toast(`\u5DF2\u767B\u5F55\uFF1A${r.sales.display || r.sales.name}`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });
  $("#btnClosePw").addEventListener("click", () => {
    $("#pwSheet").hidden = true;
  });
  $("#pwSheet").addEventListener("click", (e) => {
    if (e.target.id === "pwSheet") $("#pwSheet").hidden = true;
  });
  $("#pwForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.elements.newPassword.value !== f.elements.confirmPassword.value) {
      return toast("\u4E24\u6B21\u8F93\u5165\u7684\u65B0\u5BC6\u7801\u4E0D\u4E00\u81F4", true);
    }
    try {
      await api.send("/api/password", "POST", {
        oldPassword: f.elements.oldPassword.value,
        newPassword: f.elements.newPassword.value
      });
      $("#pwSheet").hidden = true;
      f.reset();
      await loadAll();
      toast("\u5BC6\u7801\u5DF2\u4FEE\u6539");
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#btnAddAccount").addEventListener("click", () => openAcctSheet(null));
  $("#btnCloseAcct").addEventListener("click", () => {
    $("#acctSheet").hidden = true;
  });
  $("#acctSheet").addEventListener("click", (e) => {
    if (e.target.id === "acctSheet") $("#acctSheet").hidden = true;
  });
  $("#btnOnceDone").addEventListener("click", () => {
    $("#onceBox").hidden = true;
    $("#acctSheet").hidden = true;
  });
  $("#acctForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const original = f.elements.originalName.value;
    const body = {
      name: f.elements.name.value.trim().toLowerCase(),
      display: f.elements.display.value.trim(),
      email: f.elements.email.value.trim()
    };
    try {
      if (original) {
        Object.assign(body, {
          admin: f.elements.admin.checked,
          active: f.elements.active.checked
        });
        delete body.name;
        await api.send(`/api/sales/${encodeURIComponent(original)}`, "POST", body);
        toast("\u8D26\u53F7\u5DF2\u66F4\u65B0");
      } else {
        const r = await api.send("/api/sales", "POST", { ...body, admin: f.elements.admin.checked });
        showOncePassword(r.initialPassword);
        toast("\u8D26\u53F7\u5DF2\u521B\u5EFA");
      }
      await loadAll();
      if (!original) {
        $("#acctTitle").textContent = "\u8D26\u53F7\u5DF2\u521B\u5EFA";
        $("#btnResetPw").hidden = true;
        $("#btnDelAcct").hidden = true;
      }
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#btnResetPw").addEventListener("click", async () => {
    const name = $("#acctForm").elements.originalName.value;
    if (!name) return;
    if (!confirm(`\u786E\u5B9A\u91CD\u7F6E\u300C${name}\u300D\u7684\u5BC6\u7801\uFF1F

\u4ED6\u7684\u65E7\u5BC6\u7801\u4F1A\u7ACB\u5373\u5931\u6548\uFF0C\u767B\u5F55\u540E\u9700\u8981\u8BBE\u7F6E\u65B0\u5BC6\u7801\u3002`)) return;
    try {
      const r = await api.send(`/api/sales/${encodeURIComponent(name)}/reset-password`, "POST");
      showOncePassword(r.temporaryPassword);
      await loadAll();
      toast("\u5BC6\u7801\u5DF2\u91CD\u7F6E");
    } catch (err) {
      toast(err.message, true);
    }
  });
  $("#btnDelAcct").addEventListener("click", async () => {
    const name = $("#acctForm").elements.originalName.value;
    if (!name) return;
    if (!confirm(
      `\u786E\u5B9A\u5220\u9664\u8D26\u53F7\u300C${name}\u300D\uFF1F

\u6CE8\u610F\uFF1A\u4ED6\u540D\u4E0B\u5DF2\u6709\u7684\u8BA2\u5355\u4E0D\u4F1A\u88AB\u5220\u9664\uFF0C\u4ECD\u4FDD\u7559\u5728\u7CFB\u7EDF\u91CC\uFF08\u8BA2\u5355\u662F\u7ECF\u8425\u51ED\u8BC1\uFF09\u3002
\u5982\u679C\u53EA\u662F\u4EBA\u79BB\u804C\u4E86\uFF0C\u5EFA\u8BAE\u6539\u7528\u300C\u505C\u7528\u300D\u800C\u4E0D\u662F\u5220\u9664\u3002`
    )) return;
    try {
      await api.send(`/api/sales/${encodeURIComponent(name)}`, "DELETE");
      $("#acctSheet").hidden = true;
      await loadAll();
      toast("\u8D26\u53F7\u5DF2\u5220\u9664\uFF08\u8BA2\u5355\u4FDD\u7559\uFF09");
    } catch (err) {
      toast(err.message, true);
    }
  });
}
async function boot() {
  var _a, _b;
  try {
    sync.onCreate((info) => {
      state.syncInfo = info;
      renderSyncChip();
      if (!info.syncing && state.signedIn && !state.solo) {
        refreshOrdersFromLocal().catch(() => {
        });
      }
    });
    await sync.init();
  } catch (err) {
    toast(`\u672C\u5730\u5E93\u521D\u59CB\u5316\u5931\u8D25\uFF1A${err.message}`, true);
  }
  bind();
  $("#loginGate").hidden = false;
  await backend.probe();
  if (backend.isSolo()) {
    await loadSolo();
    await refreshOrdersFromLocal();
  } else {
    sync.setTransport((_b = (_a = backend.capabilities()) == null ? void 0 : _a.syncMode) != null ? _b : "couch");
    await loadAll();
    setInterval(() => {
      if (state.signedIn) sync.sync().catch(() => {
      });
    }, 3e4);
  }
}
boot().catch((e) => toast(`\u52A0\u8F7D\u5931\u8D25\uFF1A${e.message}`, true));
