const DB_NAME = "fs_local";
const PRODUCTS_ID = "products";
const SETTINGS_ID = "settings";
const DEFAULT_SETTINGS = {
  companyName: "\u6211\u7684\u5BB6\u5C45",
  tagline: "",
  logo: null,
  contact: "",
  currency: "CNY",
  priceNote: "\u542B\u7A0E",
  validityDays: 30
};
let db = null;
let inflight = null;
async function open() {
  if (db) return db;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      db = new PouchDB(DB_NAME, { auto_compaction: true });
      await db.info();
      return db;
    } catch (err) {
      inflight = null;
      throw new Error(
        `\u65E0\u6CD5\u6253\u5F00\u672C\u5730\u5B58\u50A8\uFF1A${err.message}
\u5E38\u89C1\u539F\u56E0\uFF1A\u6D4F\u89C8\u5668\u5904\u4E8E\u65E0\u75D5/\u9690\u79C1\u6A21\u5F0F\uFF0C\u6216\u7981\u7528\u4E86\u672C\u5730\u5B58\u50A8\u3002\u8BF7\u6539\u7528\u666E\u901A\u6A21\u5F0F\uFF0C\u6216\u5141\u8BB8\u672C\u7AD9\u5B58\u50A8\u6570\u636E\u3002`
      );
    }
  })();
  return inflight;
}
async function getDoc(id) {
  const d = await open();
  try {
    return await d.get(id);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}
async function putDoc(id, value) {
  const d = await open();
  const cur = await getDoc(id);
  const doc = { _id: id, ...value };
  if (cur) doc._rev = cur._rev;
  return d.put(doc);
}
async function listProducts() {
  var _a;
  const doc = await getDoc(PRODUCTS_ID);
  return (_a = doc == null ? void 0 : doc.products) != null ? _a : [];
}
async function saveProducts(products) {
  await putDoc(PRODUCTS_ID, { products, updated_at: (/* @__PURE__ */ new Date()).toISOString() });
  return products;
}
async function getProduct(id) {
  var _a;
  return (_a = (await listProducts()).find((p) => p.id === id)) != null ? _a : null;
}
async function upsertProduct(input) {
  const products = await listProducts();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  if (input.id) {
    const i = products.findIndex((p) => p.id === input.id);
    if (i === -1) throw Object.assign(new Error("\u4EA7\u54C1\u4E0D\u5B58\u5728"), { status: 404 });
    products[i] = {
      ...products[i],
      ...input,
      id: products[i].id,
      // id 不可改
      created_at: products[i].created_at,
      updated_at: now
    };
    await saveProducts(products);
    return products[i];
  }
  const id = `p_${Math.random().toString(16).slice(2, 14)}`;
  const created = {
    ...input,
    id,
    created_at: now,
    updated_at: now,
    images: Array.isArray(input.images) ? input.images : []
  };
  products.push(created);
  await saveProducts(products);
  return created;
}
async function deleteProduct(id) {
  var _a;
  const products = await listProducts();
  const target = products.find((p) => p.id === id);
  if (!target) throw Object.assign(new Error("\u4EA7\u54C1\u4E0D\u5B58\u5728"), { status: 404 });
  const d = await open();
  for (const img of (_a = target.images) != null ? _a : []) {
    try {
      const doc = await d.get(img);
      if (doc._attachments) {
        const names = Object.keys(doc._attachments);
        for (const n of names) {
          const att = await d.getAttachment(img, n);
          void att;
        }
      }
      await d.remove(doc);
    } catch {
    }
  }
  await saveProducts(products.filter((p) => p.id !== id));
  return { ok: true };
}
async function replaceAllProducts(products) {
  await saveProducts(products);
  return products;
}
async function getSettings() {
  var _a;
  const doc = await getDoc(SETTINGS_ID);
  return { ...DEFAULT_SETTINGS, ...(_a = doc == null ? void 0 : doc.value) != null ? _a : {} };
}
async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await putDoc(SETTINGS_ID, { value: next, updated_at: (/* @__PURE__ */ new Date()).toISOString() });
  return next;
}
async function saveImage(blob, name = "photo.jpg") {
  const d = await open();
  const ext = (String(name).split(".").pop() || "jpg").toLowerCase();
  const id = `img_${Math.random().toString(16).slice(2, 14)}.${ext}`;
  await d.put({
    _id: id,
    kind: "photo",
    created_at: (/* @__PURE__ */ new Date()).toISOString(),
    _attachments: {
      [id]: {
        content_type: blob.type || "image/jpeg",
        data: blob
        // PouchDB 接受 Blob，自己会转 base64 存
      }
    }
  });
  return { id, name: id, sizeKB: Math.round((blob.size || 0) / 1024) };
}
async function getImageBlob(ref) {
  if (!ref) return null;
  const d = await open();
  try {
    const att = await d.getAttachment(ref, ref);
    return att instanceof Blob ? att : new Blob([att]);
  } catch {
    return null;
  }
}
async function imageToDataUri(ref) {
  const blob = await getImageBlob(ref);
  if (!blob) return null;
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("\u56FE\u7247\u8BFB\u53D6\u5931\u8D25"));
    fr.readAsDataURL(blob);
  });
}
async function exportAll() {
  var _a;
  const [products, settings] = await Promise.all([listProducts(), getSettings()]);
  const images = {};
  for (const p of products) {
    for (const ref of (_a = p.images) != null ? _a : []) {
      if (images[ref]) continue;
      try {
        images[ref] = await imageToDataUri(ref);
      } catch {
      }
    }
  }
  return {
    format: "furniture-sales-tool/local-backup",
    version: 1,
    exported_at: (/* @__PURE__ */ new Date()).toISOString(),
    settings,
    products,
    images
  };
}
async function importAll(backup, { replace = false } = {}) {
  var _a, _b;
  if (!backup || backup.format !== "furniture-sales-tool/local-backup") {
    throw new Error("\u8FD9\u4E0D\u662F\u672C\u5DE5\u5177\u5BFC\u51FA\u7684\u5907\u4EFD\u6587\u4EF6");
  }
  const d = await open();
  let imgCount = 0;
  for (const [ref, dataUri] of Object.entries((_a = backup.images) != null ? _a : {})) {
    try {
      const blob = await (await fetch(dataUri)).blob();
      const ext = (ref.split(".").pop() || "jpg").toLowerCase();
      await d.put({
        _id: ref,
        kind: "photo",
        _attachments: {
          [ref]: { content_type: blob.type || "image/jpeg", data: blob }
        }
      });
      imgCount++;
    } catch {
    }
  }
  const incoming = (_b = backup.products) != null ? _b : [];
  const products = replace ? incoming : mergeProducts(await listProducts(), incoming);
  await saveProducts(products);
  if (backup.settings) {
    await saveSettings(replace ? backup.settings : { ...backup.settings, ...await getSettings() });
  }
  return { products: products.length, images: imgCount, replaced: replace };
}
function mergeProducts(local, incoming) {
  const map = new Map(local.map((p) => [p.id, p]));
  for (const p of incoming) map.set(p.id, p);
  return [...map.values()];
}
async function usage() {
  var _a, _b;
  const d = await open();
  const info = await d.info();
  let bytes = 0;
  try {
    if ((_a = navigator.storage) == null ? void 0 : _a.estimate) {
      const est = await navigator.storage.estimate();
      bytes = (_b = est.usage) != null ? _b : 0;
    }
  } catch {
  }
  return { docs: info.doc_count, bytes, mb: Math.round(bytes / 1024 / 1024 * 10) / 10 };
}
export {
  deleteProduct,
  exportAll,
  getImageBlob,
  getProduct,
  getSettings,
  imageToDataUri,
  importAll,
  listProducts,
  open,
  replaceAllProducts,
  saveImage,
  saveProducts,
  saveSettings,
  upsertProduct,
  usage
};
