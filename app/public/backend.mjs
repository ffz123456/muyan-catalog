/**
 * 后端抽象：**同一套界面，两种运行形态**
 *
 *   团队模式（连得上服务端）  产品/设置/图片在服务端，订单按销售隔离并同步
 *   单人模式（连不上服务端）  全部存在这台设备本地，不需要任何服务器
 *
 * 为什么要有这一层：
 *   界面代码不该到处写 `if (有服务器) … else …`——那样迟早漏一处，
 *   表现就是"某个功能在单机模式下莫名其妙不工作"。
 *   所以把差异**收在这一个文件里**，界面只调 backend.xxx()。
 *
 * 模式是**自动判断**的，不让用户选：
 *   打开页面时探测一次服务端；连得上就是团队，连不上就是单人。
 *   让用户选等于让他理解一个他不需要理解的概念。
 *
 * ⚠️ 两种模式的数据结构**完全一致**（产品、设置、订单的字段名与含义相同）。
 *    所以将来从单人升到团队时，订单能直接同步上去，不需要迁移数据。
 */
import * as local from './localdb.mjs';

const PROBE_TIMEOUT_MS = 4000;

let mode = null;          // 'team' | 'solo' | null（未知）
let probeResult = null;

/** 探测服务端是否可用。只探一次，结果缓存。 */
export async function probe() {
  if (probeResult) return probeResult;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(new URL('/api/capabilities', location.origin), {
      signal: ctl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    probeResult = { online: true, capabilities: body };
    mode = 'team';
  } catch {
    /**
     * 连不上就当单人模式。
     *
     * 这里刻意**不报错**：单人模式是完全正常的使用方式，
     * 不是"出错了的降级"。用户看到"服务器连接失败"会以为坏了。
     */
    probeResult = { online: false, capabilities: null };
    mode = 'solo';
  } finally {
    clearTimeout(timer);
  }
  return probeResult;
}

export const currentMode = () => mode;
export const isSolo = () => mode === 'solo';
export const isOnline = () => !!probeResult?.online;
export const capabilities = () => probeResult?.capabilities ?? null;

/** 强制重新探测（例如用户点了"重试连接"）。 */
export function resetProbe() {
  probeResult = null;
  mode = null;
}

/* ------------------------------------------------------------------ *
 * 统一接口
 *
 * 两个分支的**入参和返回形状必须一致**，这样界面无感。
 * 凡是两边行为必须一样的地方，都要在这里对齐。
 * ------------------------------------------------------------------ */

/* ---- 产品 ---- */

export async function listProducts() {
  if (mode === 'team') {
    const r = await http('/api/products');
    return r.products ?? [];
  }
  return local.listProducts();
}

export async function getProduct(id) {
  if (mode === 'team') {
    const all = await listProducts();
    return all.find((p) => p.id === id) ?? null;
  }
  return local.getProduct(id);
}

export async function saveProduct(input) {
  if (mode === 'team') {
    const r = await http('/api/products', 'POST', input);
    return r.product ?? r;
  }
  return local.upsertProduct(input);
}

export async function deleteProduct(id) {
  if (mode === 'team') return http(`/api/products/${encodeURIComponent(id)}`, 'DELETE');
  return local.deleteProduct(id);
}

/* ---- 设置 ---- */

export async function getSettings() {
  if (mode === 'team') return http('/api/settings');
  return local.getSettings();
}

export async function saveSettings(patch) {
  if (mode === 'team') return http('/api/settings', 'POST', patch);
  return local.saveSettings(patch);
}

/* ---- 图片 ---- */

/**
 * 存图片。
 *
 * 团队模式走服务端（存到服务器磁盘）；单人模式存本地附件。
 * 参数统一用 Blob，由这里各自适配——
 * 服务端接口要 dataUrl，所以团队分支在内部转。
 */
export async function saveImage(blob, name) {
  if (mode === 'team') {
    const dataUrl = await blobToDataUrl(blob);
    const r = await http('/api/images', 'POST', { dataUrl });
    return { id: r.id ?? r.name, name: r.name ?? r.id, sizeKB: r.sizeKB };
  }
  return local.saveImage(blob, name);
}

/**
 * 把图片引用解析成 data URI。
 *
 * 两条路都要能给出 data URI，因为画册必须自包含
 * （发给客户后不能依赖服务器、也不能依赖这台手机）。
 */
export async function imageToDataUri(ref) {
  if (!ref) return null;
  if (mode === 'team') {
    // 团队模式图片在服务端，直接抓过来转 data URI
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

/* ---- 备份 ---- */

/**
 * 导出全部数据。
 *
 * 单人模式必须能导出：数据只在浏览器里，清缓存或换手机就没了。
 * 团队模式的数据在服务端，导出只是"方便带走一份"。
 */
export async function exportAll() {
  if (mode === 'team') {
    const [products, settings] = await Promise.all([listProducts(), getSettings()]);
    const images = {};
    for (const p of products) {
      for (const ref of p.images ?? []) {
        if (images[ref]) continue;
        const uri = await imageToDataUri(ref);
        if (uri) images[ref] = uri;
      }
    }
    return {
      format: 'furniture-sales-tool/local-backup',
      version: 1,
      exported_at: new Date().toISOString(),
      from: 'team',
      settings, products, images,
    };
  }
  const b = await local.exportAll();
  return { ...b, from: 'solo' };
}

export async function importAll(backup, opts) {
  if (mode === 'team') {
    throw new Error('团队模式下请让管理员在服务端导入，或先断开服务器再导入到本机。');
  }
  return local.importAll(backup, opts);
}

export async function usage() {
  if (mode === 'team') return null;
  return local.usage();
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 带 JSON 与错误处理的 fetch。错误信息取服务端返回的 error 字段。 */
async function http(path, method = 'GET', body) {
  const res = await fetch(new URL(path, location.origin), {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const text = await res.text();
  let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const err = new Error(parsed?.error ?? `请求失败（HTTP ${res.status}）`);
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
    fr.onerror = () => reject(new Error('图片读取失败'));
    fr.readAsDataURL(blob);
  });
}
