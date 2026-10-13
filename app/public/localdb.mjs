/**
 * 单人模式：把产品、设置、图片存到**这台设备本地**
 *
 * 为什么需要它：
 *   一个人的时候不该需要服务器。销售就一台手机，
 *   打开就能管产品、出画册、开单。订单本来就存在本地了
 *   （见 syncdb.mjs），这里把剩下的产品与设置也补上。
 *
 * 和团队模式的关系：
 *   **同一套代码、同一个数据结构**。单人模式下的本地库，
 *   就是团队模式下的本地缓存。所以将来从单人升到团队时，
 *   数据能直接同步上去，不用迁移。
 *
 * 存储选择：PouchDB 而不是裸 IndexedDB
 *   1. 项目里已经有它（135 KB），不增加新依赖
 *   2. 它能存**附件**——产品照片直接存原始二进制，
 *      不用 base64（base64 会让体积涨 33% 且更占内存）
 *   3. 数据模型和团队模式一致，将来合并容易
 *
 * 注意：vendor/pouchdb.min.js 是 UMD 构建，挂在全局 `PouchDB` 上，
 * 不是 ES 模块。所以这里**不能** `import PouchDB from ...`，
 * 而是像 syncdb.mjs 一样直接用全局变量（由 index.html 里的 <script> 提供）。
 */
/* global PouchDB */

const DB_NAME = 'fs_local';

/** 固定 _id：产品与设置各占一条文档，不散落。 */
const PRODUCTS_ID = 'products';
const SETTINGS_ID = 'settings';

const DEFAULT_SETTINGS = {
  companyName: '我的家居',
  tagline: '',
  logo: null,
  contact: '',
  currency: 'CNY',
  priceNote: '含税',
  validityDays: 30,
};

let db = null;
let inflight = null;

/** 打开本地库。重复调用会复用同一个连接。 */
export async function open() {
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
        `无法打开本地存储：${err.message}\n`
        + '常见原因：浏览器处于无痕/隐私模式，或禁用了本地存储。'
        + '请改用普通模式，或允许本站存储数据。',
      );
    }
  })();
  return inflight;
}

/** 读一条文档，不存在返回 null。 */
async function getDoc(id) {
  const d = await open();
  try {
    return await d.get(id);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** 写一条文档（自动处理 rev 冲突）。 */
async function putDoc(id, value) {
  const d = await open();
  const cur = await getDoc(id);
  const doc = { _id: id, ...value };
  if (cur) doc._rev = cur._rev;
  return d.put(doc);
}

/* ------------------------------------------------------------------ *
 * 产品
 * ------------------------------------------------------------------ */

export async function listProducts() {
  const doc = await getDoc(PRODUCTS_ID);
  return doc?.products ?? [];
}

export async function saveProducts(products) {
  await putDoc(PRODUCTS_ID, { products, updated_at: new Date().toISOString() });
  return products;
}

export async function getProduct(id) {
  return (await listProducts()).find((p) => p.id === id) ?? null;
}

/**
 * 新增或更新产品。
 *
 * 与 server/store.mjs 保持同样的入参形状，这样界面代码两边都能用。
 */
export async function upsertProduct(input) {
  const products = await listProducts();
  const now = new Date().toISOString();

  if (input.id) {
    const i = products.findIndex((p) => p.id === input.id);
    if (i === -1) throw Object.assign(new Error('产品不存在'), { status: 404 });
    products[i] = {
      ...products[i],
      ...input,
      id: products[i].id,          // id 不可改
      created_at: products[i].created_at,
      updated_at: now,
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
    images: Array.isArray(input.images) ? input.images : [],
  };
  products.push(created);
  await saveProducts(products);
  return created;
}

export async function deleteProduct(id) {
  const products = await listProducts();
  const target = products.find((p) => p.id === id);
  if (!target) throw Object.assign(new Error('产品不存在'), { status: 404 });

  // 顺手把它的图片附件也删掉，否则本地库会越用越大
  const d = await open();
  for (const img of target.images ?? []) {
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
    } catch { /* 图片已不在，忽略 */ }
  }

  await saveProducts(products.filter((p) => p.id !== id));
  return { ok: true };
}

export async function replaceAllProducts(products) {
  await saveProducts(products);
  return products;
}

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

export async function getSettings() {
  const doc = await getDoc(SETTINGS_ID);
  return { ...DEFAULT_SETTINGS, ...(doc?.value ?? {}) };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await putDoc(SETTINGS_ID, { value: next, updated_at: new Date().toISOString() });
  return next;
}

/* ------------------------------------------------------------------ *
 * 图片（存成附件，不转 base64）
 * ------------------------------------------------------------------ */

/**
 * 存一张图片，返回图片 id（产品里就存这个 id）。
 *
 * @param {Blob} blob   图片二进制
 * @param {string} name 原文件名（只用于取扩展名）
 */
export async function saveImage(blob, name = 'photo.jpg') {
  const d = await open();
  const ext = (String(name).split('.').pop() || 'jpg').toLowerCase();
  const id = `img_${Math.random().toString(16).slice(2, 14)}.${ext}`;
  await d.put({
    _id: id,
    kind: 'photo',
    created_at: new Date().toISOString(),
    _attachments: {
      [id]: {
        content_type: blob.type || 'image/jpeg',
        data: blob,          // PouchDB 接受 Blob，自己会转 base64 存
      },
    },
  });
  return { id, name: id, sizeKB: Math.round((blob.size || 0) / 1024) };
}

/** 取图片二进制。找不到返回 null。 */
export async function getImageBlob(ref) {
  if (!ref) return null;
  const d = await open();
  try {
    const att = await d.getAttachment(ref, ref);
    // PouchDB 在浏览器里返回 Blob
    return att instanceof Blob ? att : new Blob([att]);
  } catch {
    return null;
  }
}

/**
 * 把图片引用解析成 data URI（画册要用）。
 *
 * 供 shared/catalog.mjs 的 resolveImage 回调使用。
 * 画册必须自包含：发给客户后不能依赖这台手机、也不能依赖网络。
 */
export async function imageToDataUri(ref) {
  const blob = await getImageBlob(ref);
  if (!blob) return null;
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(new Error('图片读取失败'));
    fr.readAsDataURL(blob);
  });
}

/* ------------------------------------------------------------------ *
 * 备份与恢复
 * ------------------------------------------------------------------ */

/**
 * 导出全部数据为一个对象（供下载成文件）。
 *
 * 为什么这是**必需**而不是可选：
 *   单人模式的数据存在浏览器里。用户清理浏览器数据、换手机、
 *   或者 iOS 长期不用回收了存储，数据就没了。
 *   没有导出备份，这东西不能用来存真的生意。
 */
export async function exportAll() {
  const [products, settings] = await Promise.all([listProducts(), getSettings()]);

  // 图片单独打包成 data URI
  const images = {};
  for (const p of products) {
    for (const ref of p.images ?? []) {
      if (images[ref]) continue;
      try {
        images[ref] = await imageToDataUri(ref);
      } catch { /* 取不到就跳过 */ }
    }
  }

  return {
    format: 'furniture-sales-tool/local-backup',
    version: 1,
    exported_at: new Date().toISOString(),
    settings,
    products,
    images,
  };
}

/**
 * 从备份恢复。
 *
 * 默认**合并**而不是覆盖：用户可能只是想把这台手机补齐，
 * 不想丢掉本机已有的东西。要覆盖请显式传 replace=true。
 */
export async function importAll(backup, { replace = false } = {}) {
  if (!backup || backup.format !== 'furniture-sales-tool/local-backup') {
    throw new Error('这不是本工具导出的备份文件');
  }

  const d = await open();

  // 先恢复图片（产品里要引用它们）
  let imgCount = 0;
  for (const [ref, dataUri] of Object.entries(backup.images ?? {})) {
    try {
      const blob = await (await fetch(dataUri)).blob();
      const ext = (ref.split('.').pop() || 'jpg').toLowerCase();
      await d.put({
        _id: ref,
        kind: 'photo',
        _attachments: {
          [ref]: { content_type: blob.type || 'image/jpeg', data: blob },
        },
      });
      imgCount++;
    } catch { /* 单张失败不影响整体 */ }
  }

  const incoming = backup.products ?? [];
  const products = replace ? incoming : mergeProducts(await listProducts(), incoming);
  await saveProducts(products);

  if (backup.settings) {
    await saveSettings(replace ? backup.settings : { ...backup.settings, ...(await getSettings()) });
  }

  return { products: products.length, images: imgCount, replaced: replace };
}

/** 按 id 合并：同 id 用导入的覆盖（假设备份更新）。 */
function mergeProducts(local, incoming) {
  const map = new Map(local.map((p) => [p.id, p]));
  for (const p of incoming) map.set(p.id, p);
  return [...map.values()];
}

/** 本地库占用了多少空间（让用户心里有数）。 */
export async function usage() {
  const d = await open();
  const info = await d.info();
  let bytes = 0;
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      bytes = est.usage ?? 0;
    }
  } catch { /* 浏览器不支持就算了 */ }
  return { docs: info.doc_count, bytes, mb: Math.round((bytes / 1024 / 1024) * 10) / 10 };
}
