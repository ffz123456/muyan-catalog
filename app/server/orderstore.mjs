/**
 * 中心自带的订单存储 —— **不依赖 CouchDB**
 *
 * 为什么要有它：
 *   团队模式原来靠 CouchDB 当权威副本。但 CouchDB 在 Windows 上
 *   没有便携版（官方 issue #3028），装它要管理员权限、要装服务，
 *   而"很多人不会用电脑"。所以中心改成自带存储：
 *   一个 exe + 一个数据文件，双击就能用。
 *
 * 与 CouchDB 方案的关系：
 *   数据模型**完全不变**（同样是 `order:` / `orderrev:` 文档、同样软删除、
 *   同样 sales_id 隔离）。变的只是"怎么存"和"怎么同步"。
 *   所以客户端本地那份 PouchDB 不需要改数据结构。
 *
 * 存储形态：**一份 JSON 文件 + 一个单调递增的序列号**。
 *   orders.json = { seq: 123, docs: { "order:xxx": { _id, _rev, ...data } } }
 *
 * 为什么这么简单就够：
 *   一家经销商几个到几十个销售，订单量一年也就几千张。
 *   全部放进内存再整体原子写盘，比引入数据库简单得多，
 *   而且**没有第二个进程要管**——这正是"双击即用"的前提。
 *
 * 并发安全：
 *   所有写操作走同一个串行队列（Node 单线程，但 await 之间会交错），
 *   写入用"临时文件 + rename"，断电也不会写出半个文件。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './datadir.mjs';

const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const SEQ_FILE = path.join(DATA_DIR, 'orders-seq.json');

/** 内存里的权威副本。启动时从磁盘读入。 */
let store = null;
/** 写盘串行化：避免两个 await 交错后互相覆盖。 */
let writeChain = Promise.resolve();

export const paths = { ORDERS_FILE, SEQ_FILE };

/* ------------------------------------------------------------------ *
 * 读写
 * ------------------------------------------------------------------ */

async function readJsonSafe(file, fallback) {
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
    /**
     * 损坏时备份证据 + 当作空继续，**不要抛错让服务起不来**。
     * 订单是经营凭证，绝不能静默丢：原始内容留在 .corrupt-<时间戳> 里。
     * （这条规则与 store.mjs / sales.mjs 保持一致。）
     */
    const bak = `${file}.corrupt-${Date.now()}`;
    try {
      await fs.rename(file, bak);
      console.warn(`[数据] ${path.basename(file)} 内容损坏，已备份为 ${path.basename(bak)}。原因：${err.message}`);
    } catch (e2) {
      console.warn(`[数据] ${path.basename(file)} 内容损坏且备份失败：${e2.message}`);
    }
    return fallback;
  }
}

/** 原子写：先写临时文件再 rename。 */
async function writeAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), 'utf-8');
  await fs.rename(tmp, file);
}

/** 读入（只做一次）。 */
export async function load() {
  if (store) return store;
  const data = await readJsonSafe(ORDERS_FILE, { seq: 0, docs: {} });
  store = {
    seq: Number(data.seq) || 0,
    docs: data.docs && typeof data.docs === 'object' ? data.docs : {},
  };
  return store;
}

/** 串行化写盘。 */
function persist() {
  writeChain = writeChain.then(async () => {
    await writeAtomic(ORDERS_FILE, { seq: store.seq, docs: store.docs });
  }).catch((err) => {
    console.error('[订单] 写盘失败：', err.message);
  });
  return writeChain;
}

/* ------------------------------------------------------------------ *
 * 修订号
 * ------------------------------------------------------------------ */

/**
 * 生成修订号。格式与 CouchDB 一致：`<代数>-<哈希>`。
 *
 * 为什么保持这个格式：客户端本地是 PouchDB，它认这个格式；
 * 而且现有代码（软删除、追加修订）都按这个语义写。**不变最省事。**
 */
function makeRev(gen, parentRev, body) {
  const h = crypto.createHash('md5')
    .update(`${gen}|${parentRev ?? ''}|${JSON.stringify(body)}|${crypto.randomUUID()}`)
    .digest('hex');
  return `${gen}-${h}`;
}

export function revGen(rev) {
  const n = Number(String(rev ?? '').split('-')[0]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/* ------------------------------------------------------------------ *
 * 对外接口（服务端路由用）
 * ------------------------------------------------------------------ */

/**
 * 从某个序列号之后取出变更。
 *
 * @param {number} since   客户端上次拿到的序列号
 * @param {(doc:object)=>boolean} canSee  权限过滤（销售只看自己的单）
 * @param {number} limit
 */
export async function changesSince(since, canSee, { limit = 500 } = {}) {
  await load();
  const out = [];
  for (const doc of Object.values(store.docs)) {
    if ((doc._seq ?? 0) <= since) continue;
    if (!canSee(doc)) continue;
    out.push({ seq: doc._seq, id: doc._id, rev: doc._rev });
    if (out.length >= limit) break;
  }
  out.sort((a, b) => a.seq - b.seq);
  return { results: out, lastSeq: store.seq };
}

/** 按 _id 取文档（会做权限过滤，由调用方判定）。 */
export async function getDoc(id) {
  await load();
  return store.docs[id] ?? null;
}

export async function allDocs() {
  await load();
  return Object.values(store.docs);
}

/**
 * 写入一批变更（客户端推上来的）。
 *
 * @param {Array} entries  [{ id, rev, doc }] —— rev 是客户端认为的**当前**
 *                         服务端修订号（新建时为 null）
 * @param {object} opts
 *   - canWrite(doc)  权限校验，返回 {ok:true} 或 {ok:false, reason}
 * @returns {Array} 逐条结果，形状与 CouchDB 的 _bulk_docs 保持一致
 *                  （这样客户端那侧的处理逻辑不用改）
 */
export async function pushChanges(entries, { canWrite }) {
  await load();
  const results = [];

  for (const item of entries) {
    const id = item.id ?? item.doc?._id;
    const doc = item.doc ?? item;

    if (!id) { results.push({ error: 'bad_request', reason: '缺少 _id' }); continue; }
    if (typeof id === 'string' && id.startsWith('_')) {
      // 客户端不该写系统文档（与 CouchDB 那套的规则一致）
      results.push({ id, error: 'forbidden', reason: '不接受客户端写系统文档（已跳过）' });
      continue;
    }

    // 权限：销售只能写自己的单
    const verdict = canWrite(doc);
    if (!verdict.ok) {
      results.push({ id, error: 'forbidden', reason: verdict.reason });
      continue;
    }

    const cur = store.docs[id] ?? null;
    const baseRev = item.rev ?? null;      // 客户端认为的当前修订

    // 乐观并发：客户端基于的修订必须是当前修订
    if (cur && (cur._rev !== baseRev)) {
      results.push({
        id, error: 'conflict', reason: '服务端已有更新的版本',
        currentRev: cur._rev,
      });
      continue;
    }
    if (!cur && baseRev) {
      // 客户端以为存在、服务端没有（被清理过？）——当作新建，但要说清
      results.push({ id, error: 'conflict', reason: '服务端没有这个订单的旧版本', currentRev: null });
      continue;
    }

    const gen = revGen(cur?._rev) + 1;
    const next = {
      ...doc,
      _id: id,
      _rev: makeRev(gen, cur?._rev, doc),
      _seq: ++store.seq,
      updated_at: doc.updated_at ?? new Date().toISOString(),
    };
    store.docs[id] = next;

    results.push({ ok: true, id, rev: next._rev });
  }

  await persist();
  return results;
}

/** 供启动日志用。 */
export async function stats() {
  await load();
  const docs = Object.values(store.docs);
  const live = docs.filter((d) => d.status !== 'deleted');
  return { total: docs.length, live: live.length, seq: store.seq };
}

/** 测试用：清空（**只给验证脚本用，不在生产路径里**）。 */
export async function _resetForTest() {
  store = { seq: 0, docs: {} };
  await writeAtomic(ORDERS_FILE, { seq: 0, docs: {} });
}
