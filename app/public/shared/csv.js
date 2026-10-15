const BOM = "\uFEFF";
function cell(v) {
  const s = v === null || v === void 0 ? "" : String(v);
  const needsQuote = /^[=+\-@\t\r]/.test(s);
  const guarded = needsQuote ? `'${s}` : s;
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}
function toCsv(rows, { withBom = true } = {}) {
  const body = rows.map((r) => r.map(cell).join(",")).join("\r\n");
  return (withBom ? BOM : "") + body + "\r\n";
}
const dt = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
function shortId(id) {
  const s = String(id != null ? id : "");
  if (!s) return "";
  const body = s.replace(/^order:/, "");
  return body.slice(-12).toUpperCase();
}
const STATUS = { active: "\u6709\u6548", deleted: "\u5DF2\u5220\u9664" };
function ordersToItemsCsv(orders, { withDeleted = false } = {}) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i;
  const rows = [[
    "\u8BA2\u5355\u53F7",
    "\u5F00\u5355\u65F6\u95F4",
    "\u5BA2\u6237",
    "\u7535\u8BDD",
    "\u4EA7\u54C1",
    "\u6570\u91CF",
    "\u76EE\u5F55\u5355\u4EF7",
    "\u6210\u4EA4\u5355\u4EF7",
    "\u5C0F\u8BA1",
    "\u8BA2\u5355\u76EE\u5F55\u4EF7\u5408\u8BA1",
    "\u8BA2\u5355\u8BA9\u5229",
    "\u8BA2\u5355\u5E94\u6536",
    "\u51FA\u5355\u4EBA",
    "\u5907\u6CE8",
    "\u72B6\u6001"
  ]];
  for (const o of orders) {
    if (!withDeleted && o.status === "deleted") continue;
    const owner = o.sales_display || o.sales_id || "";
    const common = [
      shortId(o.id),
      dt(o.created_at),
      (_a = o.customer_name) != null ? _a : "",
      (_b = o.customer_phone) != null ? _b : ""
    ];
    const tail = [
      (_c = o.list_total) != null ? _c : 0,
      (_d = o.discount) != null ? _d : 0,
      (_e = o.total) != null ? _e : 0,
      owner,
      (_f = o.remark) != null ? _f : "",
      (_h = (_g = STATUS[o.status]) != null ? _g : o.status) != null ? _h : ""
    ];
    const items = Array.isArray(o.items) ? o.items : [];
    if (!items.length) {
      rows.push([...common, "\uFF08\u65E0\u660E\u7EC6\uFF09", "", "", "", "", ...tail]);
      continue;
    }
    for (const it of items) {
      const qty = Number(it.qty) || 0;
      const actual = Number(it.actual_price) || 0;
      rows.push([
        ...common,
        (_i = it.product_name) != null ? _i : "",
        qty,
        Number(it.list_price) || 0,
        actual,
        qty * actual,
        ...tail
      ]);
    }
  }
  return toCsv(rows);
}
function ordersToSummaryCsv(orders, { withDeleted = false } = {}) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i;
  const rows = [[
    "\u8BA2\u5355\u53F7",
    "\u5F00\u5355\u65F6\u95F4",
    "\u6700\u540E\u6539\u52A8",
    "\u5BA2\u6237",
    "\u7535\u8BDD",
    "\u4EF6\u6570",
    "\u54C1\u79CD\u6570",
    "\u76EE\u5F55\u4EF7\u5408\u8BA1",
    "\u8BA9\u5229",
    "\u5E94\u6536",
    "\u51FA\u5355\u4EBA",
    "\u5907\u6CE8",
    "\u72B6\u6001"
  ]];
  for (const o of orders) {
    if (!withDeleted && o.status === "deleted") continue;
    const items = Array.isArray(o.items) ? o.items : [];
    rows.push([
      shortId(o.id),
      dt(o.created_at),
      dt(o.updated_at),
      (_a = o.customer_name) != null ? _a : "",
      (_b = o.customer_phone) != null ? _b : "",
      (_c = o.item_count) != null ? _c : items.reduce((a, it) => a + (Number(it.qty) || 0), 0),
      items.length,
      (_d = o.list_total) != null ? _d : 0,
      (_e = o.discount) != null ? _e : 0,
      (_f = o.total) != null ? _f : 0,
      o.sales_display || o.sales_id || "",
      (_g = o.remark) != null ? _g : "",
      (_i = (_h = STATUS[o.status]) != null ? _h : o.status) != null ? _i : ""
    ]);
  }
  return toCsv(rows);
}
function exportFileName(kind, when = /* @__PURE__ */ new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}-${p(when.getHours())}${p(when.getMinutes())}`;
  return `\u6728\u8A00-${kind}-${stamp}.csv`;
}
export {
  BOM,
  exportFileName,
  ordersToItemsCsv,
  ordersToSummaryCsv,
  shortId,
  toCsv
};
