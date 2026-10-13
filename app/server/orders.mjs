/**
 * 订单 —— 不可变 + 追加式修订 + 软删除
 *
 * 三条硬约束（都来自实测结论，见主文档 §4.1.1、§9）：
 *   1. **订单只软删除**，禁止硬删除。CouchDB 硬删除会让业务字段消失，
 *      过滤函数无法判断归属，删除变更被丢弃 → 客户端留幽灵订单。
 *   2. **修订追加不覆盖**。订单内容不可变，每次修改追加一条 revision，
 *      便于审计与回溯。
 *   3. **sales_id 是隔离键**。创建时绑定，之后不可改。
 *
 * 并发保护：写入用队列串行化 + 原子替换，避免同进程内并发写导致丢单。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, ORDERS_DIR } from './datadir.mjs';

/* ---------------- 写入串行化 ---------------- *
 * Node 是单线程，但 await 之间会交错。若不串行，
 * 两个并发的"读-改-写"会互相覆盖，直接丢单。
 */
let writeChain = Promise.resolve();
function serialize(fn) {
  const next = writeChain.then(fn, fn);
  // 吞掉错误以免链条断掉，错误由调用方通过返回的 promise 感知
  writeChain = next.catch(() => {});
  return next;
}

const monthKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

const fileForMonth = (key) => path.join(ORDERS_DIR, `${key}.json`);

/**
 * 读取某月订单文件。
 *
 * 损坏时**备份证据 + 警告 + 当作空**，不抛错。
 * ⚠️ 但订单是经营凭证，绝不能静默丢：原始内容一定留在 .corrupt-<时间戳> 里，
 *    由人工检查恢复。这里的选择是"服务继续可用 + 保留全部证据"，
 *    而不是"让整个系统起不来"。
 *
 * 注：这些本地月度文件是第 4 步之前的存储形态；现在订单的权威存储是
 *     CouchDB（见 app/server/sync.mjs）。此模块目前仅供测试脚本验证业务规则。
 */
async function readMonth(key) {
  const file = fileForMonth(key);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { month: key, orders: [] };
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const bak = `${file}.corrupt-${Date.now()}`;
    try {
      await fs.rename(file, bak);
      console.warn(`[数据] 订单文件 ${key} 损坏，已备份为 ${path.basename(bak)}。原因：${err.message}`);
    } catch (e2) {
      console.warn(`[数据] 订单文件 ${key} 损坏且备份失败：${e2.message}`);
    }
    return { month: key, orders: [] };
  }
}

async function writeMonth(key, doc) {
  await fs.mkdir(ORDERS_DIR, { recursive: true });
  const file = fileForMonth(key);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

/** 按月分文件存储：单文件不会无限增长，也便于按时间归档。 */
async function listAllMonths() {
  try {
    const files = await fs.readdir(ORDERS_DIR);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** 生成订单号：时间可读 + 随机后缀，天然无冲突（客户端生成即可上行）。 */
function newOrderId() {
  const t = new Date();
  const stamp = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`;
  return `order:${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

/* ---------------- 校验与计算 ---------------- */

/**
 * 校验并规范化 items。
 *
 * list_price 由服务端从产品数据取，**不接受客户端传入**——
 * 否则客户端可以伪造原价来伪造折扣，审计就失去意义。
 */
async function normalizeItems(rawItems, getProduct) {
  if (!Array.isArray(rawItems) || !rawItems.length) {
    throw Object.assign(new Error('订单至少要有一个产品'), { status: 400 });
  }
  const items = [];
  for (const raw of rawItems) {
    const product = await getProduct(raw.product_id);
    if (!product) {
      throw Object.assign(new Error(`产品不存在：${raw.product_id}`), { status: 400 });
    }
    const qty = Number(raw.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw Object.assign(new Error(`数量不合法：${product.name}`), { status: 400 });
    }
    const listPrice = Number(product.price) || 0;
    // 成交价缺省即目录价
    const actualPrice = raw.actual_price === undefined || raw.actual_price === null || raw.actual_price === ''
      ? listPrice
      : Number(raw.actual_price);
    if (!Number.isFinite(actualPrice) || actualPrice < 0) {
      throw Object.assign(new Error(`成交价不合法：${product.name}`), { status: 400 });
    }
    items.push({
      product_id: product.id,
      product_name: product.name,     // 快照：产品改名后历史单仍可读
      qty,
      list_price: listPrice,          // 快照：目录价
      actual_price: actualPrice,      // 成交价
    });
  }
  return items;
}

function computeTotals(items) {
  const total = items.reduce((s, it) => s + it.qty * it.actual_price, 0);
  const listTotal = items.reduce((s, it) => s + it.qty * it.list_price, 0);
  return {
    total: Math.round(total * 100) / 100,
    list_total: Math.round(listTotal * 100) / 100,
    discount: Math.round((listTotal - total) * 100) / 100,   // 让利金额
    item_count: items.reduce((s, it) => s + it.qty, 0),
  };
}

/* ---------------- 查询 ---------------- */

/**
 * 列出订单。
 * @param {object} opts
 * @param {string} [opts.salesId] 只列某人的单（销售视角）；不传则全部（admin 视角）
 * @param {boolean} [opts.includeDeleted] 是否包含已软删除的
 */
export async function listOrders({ salesId, includeDeleted = false } = {}) {
  const months = await listAllMonths();
  const all = [];
  for (const key of months) {
    const { orders } = await readMonth(key);
    all.push(...orders);
  }
  return all
    .filter((o) => (salesId ? o.sales_id === salesId : true))
    .filter((o) => (includeDeleted ? true : o.status !== 'deleted'))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function getOrder(id) {
  for (const key of await listAllMonths()) {
    const { orders } = await readMonth(key);
    const found = orders.find((o) => o.id === id);
    if (found) return found;
  }
  return null;
}

/** 已软删除的订单也要能被读到（用于审计与恢复） */
export async function getOrderAny(id) {
  return getOrder(id);
}

/* ---------------- 写入 ---------------- */

export async function createOrder(input, { getProduct, salesId }) {
  if (!salesId) throw Object.assign(new Error('缺少 sales_id（出单人）'), { status: 400 });
  const items = await normalizeItems(input.items, getProduct);
  const totals = computeTotals(items);
  const now = new Date().toISOString();
  const key = monthKey();

  return serialize(async () => {
    const doc = await readMonth(key);
    const order = {
      id: newOrderId(),
      sales_id: salesId,                   // 隔离键：创建时绑定，之后不可改
      status: 'active',
      customer_name: String(input.customer_name ?? '').trim(),
      customer_phone: String(input.customer_phone ?? '').trim(),
      remark: String(input.remark ?? '').trim(),
      items,
      ...totals,
      version: 1,
      created_at: now,
      updated_at: now,
      // 修订留档：不可变订单 + 追加式修订（对应主文档 §9）
      revisions: [{
        version: 1,
        at: now,
        by: salesId,
        snapshot: { items, ...totals, customer_name: String(input.customer_name ?? '').trim() },
      }],
    };
    doc.orders.push(order);
    await writeMonth(key, doc);
    return order;
  });
}

/**
 * 修改订单 —— 不覆盖，追加一条修订并递增 version。
 * sales_id 不可改；跨销售修改一律拒绝（与 CouchDB 校验函数同一规则）。
 */
export async function updateOrder(id, input, { getProduct, salesId }) {
  const key = (await findMonthOf(id));
  if (!key) throw Object.assign(new Error('订单不存在'), { status: 404 });

  return serialize(async () => {
    const doc = await readMonth(key);
    const idx = doc.orders.findIndex((o) => o.id === id);
    if (idx === -1) throw Object.assign(new Error('订单不存在'), { status: 404 });
    const order = doc.orders[idx];

    if (salesId && order.sales_id !== salesId) {
      throw Object.assign(
        new Error(`不能修改他人订单（该单属于 ${order.sales_id}）`),
        { status: 403 },
      );
    }
    if (order.status === 'deleted') {
      throw Object.assign(new Error('订单已删除，不能修改'), { status: 409 });
    }

    const items = input.items ? await normalizeItems(input.items, getProduct) : order.items;
    const totals = computeTotals(items);
    const now = new Date().toISOString();
    const nextVersion = order.version + 1;

    const updated = {
      ...order,
      items,
      ...totals,
      customer_name: input.customer_name !== undefined ? String(input.customer_name).trim() : order.customer_name,
      customer_phone: input.customer_phone !== undefined ? String(input.customer_phone).trim() : order.customer_phone,
      remark: input.remark !== undefined ? String(input.remark).trim() : order.remark,
      version: nextVersion,
      updated_at: now,
      revisions: [
        ...order.revisions,
        { version: nextVersion, at: now, by: salesId ?? order.sales_id, snapshot: { items, ...totals } },
      ],
    };
    doc.orders[idx] = updated;
    await writeMonth(key, doc);
    return updated;
  });
}

/**
 * 删除订单 —— **软删除**。
 * 只把 status 改成 'deleted' 并追加修订，绝不真删文档。
 */
export async function deleteOrder(id, { salesId } = {}) {
  const key = await findMonthOf(id);
  if (!key) throw Object.assign(new Error('订单不存在'), { status: 404 });

  return serialize(async () => {
    const doc = await readMonth(key);
    const idx = doc.orders.findIndex((o) => o.id === id);
    if (idx === -1) throw Object.assign(new Error('订单不存在'), { status: 404 });
    const order = doc.orders[idx];

    if (salesId && order.sales_id !== salesId) {
      throw Object.assign(new Error(`不能删除他人订单（该单属于 ${order.sales_id}）`), { status: 403 });
    }
    if (order.status === 'deleted') return order;   // 幂等

    const now = new Date().toISOString();
    const nextVersion = order.version + 1;
    doc.orders[idx] = {
      ...order,
      status: 'deleted',
      deleted_at: now,
      version: nextVersion,
      updated_at: now,
      revisions: [
        ...order.revisions,
        { version: nextVersion, at: now, by: salesId ?? order.sales_id, action: 'soft_delete' },
      ],
    };
    await writeMonth(key, doc);
    return doc.orders[idx];
  });
}

async function findMonthOf(id) {
  for (const key of await listAllMonths()) {
    const { orders } = await readMonth(key);
    if (orders.some((o) => o.id === id)) return key;
  }
  return null;
}

/* ---------------- 统计 ---------------- */

export async function orderStats({ salesId } = {}) {
  const orders = await listOrders({ salesId, includeDeleted: true });
  const active = orders.filter((o) => o.status !== 'deleted');
  const now = new Date();
  const thisMonth = monthKey(now);
  const monthOrders = active.filter((o) => String(o.created_at).startsWith(thisMonth));
  return {
    total: active.length,
    thisMonth: monthOrders.length,
    thisMonthAmount: Math.round(monthOrders.reduce((s, o) => s + o.total, 0) * 100) / 100,
    deleted: orders.length - active.length,
  };
}

export const paths = { ORDERS_DIR };
