/**
 * 数据存储层 —— JSON 文件 + 原子写入
 *
 * 为什么先用 JSON 文件：
 *   本阶段目标是让「产品管理 + 画册生成」先跑起来（主文档 §13 第 2 步）。
 *   同步层（CouchDB/PouchDB）接入时，这一层会被替换成 PouchDB 适配器，
 *   但对上层的接口保持不变，所以 UI 与画册逻辑不需要改。
 *
 * 关键设计：所有写操作先写临时文件再 rename，避免断电/崩溃导致数据文件损坏。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, PRODUCTS_FILE, SETTINGS_FILE } from './datadir.mjs';

const DEFAULT_SETTINGS = {
  companyName: '家具经销商',
  tagline: '产品画册',
  logo: null,          // 相对路径或 data URI
  contact: '',
  currency: 'CNY',
  priceNote: '含税',
  validityDays: 30,
};

/** 原子写：先写 .tmp 再 rename。rename 在同一分区上是原子的。 */
async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

/**
 * 读取 JSON。
 *
 * 损坏时**备份证据 + 警告 + 当作缺失继续**，不抛错。
 * 理由见 sales.mjs 同名函数：一个文件损坏不该让整个服务起不来。
 * 备份是为了不静默丢数据——原始内容留在 .corrupt-<时间戳> 里可人工检查。
 */
async function readJson(file, fallback) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const bak = `${file}.corrupt-${Date.now()}`;
    try {
      await fs.rename(file, bak);
      console.warn(`[数据] ${path.basename(file)} 内容损坏，已备份为 ${path.basename(bak)} 并重建。原因：${err.message}`);
    } catch (e2) {
      console.warn(`[数据] ${path.basename(file)} 内容损坏且备份失败：${e2.message}`);
    }
    return fallback;
  }
}

/* ------------------------------ 产品 ------------------------------ */

export async function listProducts() {
  const doc = await readJson(PRODUCTS_FILE, { products: [] });
  return doc.products ?? [];
}

export async function saveProducts(products) {
  await writeJsonAtomic(PRODUCTS_FILE, { products });
  return products;
}

export async function getProduct(id) {
  const products = await listProducts();
  return products.find((p) => p.id === id) ?? null;
}

export async function upsertProduct(input) {
  const products = await listProducts();
  const now = new Date().toISOString();

  if (input.id) {
    const i = products.findIndex((p) => p.id === input.id);
    if (i === -1) throw Object.assign(new Error('产品不存在'), { status: 404 });
    products[i] = { ...products[i], ...input, updated_at: now };
    await saveProducts(products);
    return products[i];
  }

  // 新产品的默认值：让人尽量少填
  const product = {
    id: `p_${crypto.randomBytes(6).toString('hex')}`,
    name: input.name ?? '',
    category: input.category ?? '未分类',
    specs: input.specs ?? '',
    highlights: input.highlights ?? '',
    price: Number(input.price) || 0,
    stockStatus: input.stockStatus ?? '现货',
    supplier: input.supplier ?? '',
    images: input.images ?? [],
    created_at: now,
    updated_at: now,
  };
  if (!product.name.trim()) throw Object.assign(new Error('产品名称不能为空'), { status: 400 });
  products.push(product);
  await saveProducts(products);
  return product;
}

export async function deleteProduct(id) {
  const products = await listProducts();
  const next = products.filter((p) => p.id !== id);
  if (next.length === products.length) throw Object.assign(new Error('产品不存在'), { status: 404 });
  await saveProducts(next);
  return { deleted: id };
}

export async function replaceAllProducts(products) {
  const now = new Date().toISOString();
  const normalized = products.map((p) => ({
    id: p.id ?? `p_${crypto.randomBytes(6).toString('hex')}`,
    name: p.name ?? '',
    category: p.category ?? '未分类',
    specs: p.specs ?? '',
    highlights: p.highlights ?? '',
    price: Number(p.price) || 0,
    stockStatus: p.stockStatus ?? '现货',
    supplier: p.supplier ?? '',
    images: p.images ?? [],
    created_at: p.created_at ?? now,
    updated_at: now,
  })).filter((p) => p.name.trim());
  await saveProducts(normalized);
  return normalized;
}

/* ------------------------------ 设置 ------------------------------ */

export async function getSettings() {
  const saved = await readJson(SETTINGS_FILE, {});
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await writeJsonAtomic(SETTINGS_FILE, next);
  return next;
}

export const paths = { DATA_DIR, PRODUCTS_FILE, SETTINGS_FILE };
