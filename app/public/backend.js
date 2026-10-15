import * as local from "./localdb.js";
const PROBE_TIMEOUT_MS = 4e3;
let mode = null;
let probeResult = null;
async function probe() {
  if (probeResult) return probeResult;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(new URL("/api/capabilities", location.origin), {
      signal: ctl.signal,
      headers: { Accept: "application/json" }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    probeResult = { online: true, capabilities: body };
    mode = "team";
  } catch {
    probeResult = { online: false, capabilities: null };
    mode = "solo";
  } finally {
    clearTimeout(timer);
  }
  return probeResult;
}
const currentMode = () => mode;
const isSolo = () => mode === "solo";
const isOnline = () => !!(probeResult == null ? void 0 : probeResult.online);
const capabilities = () => {
  var _a;
  return (_a = probeResult == null ? void 0 : probeResult.capabilities) != null ? _a : null;
};
function resetProbe() {
  probeResult = null;
  mode = null;
}
async function listProducts() {
  var _a;
  if (mode === "team") {
    const r = await http("/api/products");
    return (_a = r.products) != null ? _a : [];
  }
  return local.listProducts();
}
async function getProduct(id) {
  var _a;
  if (mode === "team") {
    const all = await listProducts();
    return (_a = all.find((p) => p.id === id)) != null ? _a : null;
  }
  return local.getProduct(id);
}
async function saveProduct(input) {
  var _a;
  if (mode === "team") {
    const r = await http("/api/products", "POST", input);
    return (_a = r.product) != null ? _a : r;
  }
  return local.upsertProduct(input);
}
async function deleteProduct(id) {
  if (mode === "team") return http(`/api/products/${encodeURIComponent(id)}`, "DELETE");
  return local.deleteProduct(id);
}
async function getSettings() {
  if (mode === "team") return http("/api/settings");
  return local.getSettings();
}
async function saveSettings(patch) {
  if (mode === "team") return http("/api/settings", "POST", patch);
  return local.saveSettings(patch);
}
async function saveImage(blob, name) {
  var _a, _b;
  if (mode === "team") {
    const dataUrl = await blobToDataUrl(blob);
    const r = await http("/api/images", "POST", { dataUrl });
    return { id: (_a = r.id) != null ? _a : r.name, name: (_b = r.name) != null ? _b : r.id, sizeKB: r.sizeKB };
  }
  return local.saveImage(blob, name);
}
async function imageToDataUri(ref) {
  if (!ref) return null;
  if (mode === "team") {
    try {
      const res = await fetch(new URL(`/assets/${ref}`, location.origin));
      if (!res.ok) return null;
      return blobToDataUrl(await res.blob());
    } catch {
      return null;
    }
  }
  return local.imageToDataUri(ref);
}
async function exportAll() {
  var _a;
  if (mode === "team") {
    const [products, settings] = await Promise.all([listProducts(), getSettings()]);
    const images = {};
    for (const p of products) {
      for (const ref of (_a = p.images) != null ? _a : []) {
        if (images[ref]) continue;
        const uri = await imageToDataUri(ref);
        if (uri) images[ref] = uri;
      }
    }
    return {
      format: "furniture-sales-tool/local-backup",
      version: 1,
      exported_at: (/* @__PURE__ */ new Date()).toISOString(),
      from: "team",
      settings,
      products,
      images
    };
  }
  const b = await local.exportAll();
  return { ...b, from: "solo" };
}
async function importAll(backup, opts) {
  if (mode === "team") {
    throw new Error("\u56E2\u961F\u6A21\u5F0F\u4E0B\u8BF7\u8BA9\u7BA1\u7406\u5458\u5728\u670D\u52A1\u7AEF\u5BFC\u5165\uFF0C\u6216\u5148\u65AD\u5F00\u670D\u52A1\u5668\u518D\u5BFC\u5165\u5230\u672C\u673A\u3002");
  }
  return local.importAll(backup, opts);
}
async function usage() {
  if (mode === "team") return null;
  return local.usage();
}
async function http(path, method = "GET", body) {
  var _a;
  const res = await fetch(new URL(path, location.origin), {
    method,
    headers: body === void 0 ? {} : { "Content-Type": "application/json" },
    body: body === void 0 ? void 0 : JSON.stringify(body),
    credentials: "same-origin"
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const err = new Error((_a = parsed == null ? void 0 : parsed.error) != null ? _a : `\u8BF7\u6C42\u5931\u8D25\uFF08HTTP ${res.status}\uFF09`);
    err.status = res.status;
    err.payload = parsed;
    throw err;
  }
  return parsed;
}
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error("\u56FE\u7247\u8BFB\u53D6\u5931\u8D25"));
    fr.readAsDataURL(blob);
  });
}
export {
  capabilities,
  currentMode,
  deleteProduct,
  exportAll,
  getProduct,
  getSettings,
  imageToDataUri,
  importAll,
  isOnline,
  isSolo,
  listProducts,
  probe,
  resetProbe,
  saveImage,
  saveProduct,
  saveSettings,
  usage
};
