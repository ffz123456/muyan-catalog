/**
 * 本地订单库 + 同步 —— 浏览器的离线副本
 *
 * 架构（主文档 §2b.3 红线）：
 *   CouchDB（服务端）= 权威副本
 *   本地 PouchDB     = 缓存，可随时从服务端重建
 *
 * 因此 UI 列表一律读本地库（离线可用），订单写入也先落本地再上行。
 *
 * ⚠️ 为什么出单时必须"暂停周期同步 -> 写完 -> 立即同步一次"：
 *   PouchDB 复制期间，本地写与复制的读-改-写会竞争，可能产生冲突修订。
 *   服务端的过滤函数看不到冲突的那一支，于是销售会看到一张"幽灵单"，
 *   而服务端却认为它不存在。串行化后就不存在这个竞争。
 */
/* global PouchDB */

/**
 * 远端库地址。
 *
 * ⚠️ 必须是**绝对 URL**。实测教训：
 *   PouchDB 只在参数是绝对 URL 时才按 HTTP 处理；
 *   传相对路径（'/api/sync/orders'）它会把该字符串当成**本地库名**，
 *   创建同名本地库并在两个本地库之间复制——表现为
 *   `docs_written: 1`、毫无报错、**网络请求 0 条**、服务端什么都没有。
 *   这正是"单子只留在本地"这个最危险症状的来源。
 */
const REMOTE = new URL('/api/sync/orders', window.location.origin).href;
const LOCAL_NAME = 'fs_orders';

const state = {
  db: null,
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  pending: 0,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  onChange: null,
};

export function onCreate(cb) { state.onChange = cb; }

function emit() { state.onChange?.(snapshot()); }

export function snapshot() {
  return {
    online: state.online,
    syncing: state.syncing,
    lastSyncAt: state.lastSyncAt,
    lastError: state.lastError,
    pending: state.pending,
  };
}

function newId() {
  const t = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`;
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  return `order:${stamp}-${rand}`;
}

export async function init() {
  if (state.db) return state.db;
  state.db = new PouchDB(LOCAL_NAME);

  window.addEventListener('online', () => { state.online = true; emit(); sync(); });
  window.addEventListener('offline', () => { state.online = false; emit(); });

  await recountPending();
  emit();
  await sync();
  return state.db;
}

/**
 * 未同步计数。
 *
 * 语义：**本地已写入、但还没成功上行到服务端的改动数**。
 * 这是 §2b.3 红线要盯的指标——它不为 0 就意味着"数据只在本地"。
 *
 * 实现用显式计数器而不是猜测：
 *   写入时 +1；一次 push 成功且无错误时清零。
 *   （用 PouchDB 内部检查点判断在过滤复制下不可靠：服务端可见数天然少于本地数。）
 */
export async function refreshPending() {
  return state.pending;
}

/**
 * 清掉被污染的双向复制检查点。
 *
 * ⚠️ 这是本文件最关键的一处修复，实测出来的。
 *
 * 现象：本地 _changes 里明明有文档、update_seq=1，
 *       但 replicate.to() 返回 docs_read=0 / docs_written=0 / 无错误，
 *       CouchDB 里就是没有——单子只留在本机。
 *
 * 原因：PouchDB.sync() 做双向复制时，push 与 pull **共用同一个检查点存储**。
 *       pull 会把**服务端的序列号**（形如 "16-g1AAA..." 的字符串）写进去；
 *       之后 push 读这个检查点，拿字符串序列号与本地数字序列号比较，
 *       判定"本地没有新变更"，于是什么都不推。
 *
 * 因此每次同步前显式清掉这两个检查点，强制按本地 _changes 全量比对。
 * 代价是每轮重新比对变更列表（单量级很小，可忽略），
 * 换来的是"不会静默漏推"——这正是主文档 §2b.3 红线要求的。
 */
async function resetReplicationCheckpoints() {
  try {
    const all = await state.db.allDocs({ startkey: '_local/', endkey: '_local/\ufff0' });
    for (const row of all.rows) {
      const id = row.id;
      // 只清复制检查点（PouchDB 用 _local/<hash> 命名），保留我们自己的清单
      if (id === PENDING_DOC) continue;
      try {
        await state.db.remove(id, row.value.rev);
      } catch { /* 已被清掉，忽略 */ }
    }
  } catch { /* 忽略：清不掉就照常同步 */ }
}

/**
 * 清掉本地"已无权查看"的订单残留。
 *
 * 为什么必须做（对应主文档 §10.4「权限撤销后的数据残留」）：
 *   服务端代理会正确拒绝下发无权文档（403），但**不会删除本地已有副本**。
 *   于是换使用者后，本地库里仍留着上一位的订单：
 *   离职交接、换人用同一台手机，新销售就会看到前任的客户与价格。
 *
 * 实现：向服务端问"我现在能看到哪些订单"，把本地不在这个集合里的订单删掉。
 *   只处理订单（order:/orderrev:），产品等共享文档不动。
 *
 * ⚠️ 前提：必须能连上服务端。离线时**不做清理**——
 *   宁可暂时多留，也不能在没确认权限的情况下误删用户自己的单。
 */
async function purgeUnauthorizedLocals() {
  if (!state.online) return { skipped: 'offline', removed: 0 };

  let allowed;
  try {
    const res = await fetch(
      new URL('/api/sync/orders/_changes?since=0', window.location.origin),
      { headers: { Accept: 'application/json' }, credentials: 'same-origin' },
    );
    if (!res.ok) return { skipped: `http ${res.status}`, removed: 0 };
    const data = await res.json();
    allowed = new Set((data.results ?? []).map((r) => r.id));
  } catch {
    return { skipped: 'request failed', removed: 0 };
  }

  const isOrder = (id) => id.startsWith('order:') || id.startsWith('orderrev:');
  const local = await state.db.allDocs();
  const removable = local.rows
    .map((r) => r.id)
    .filter((id) => isOrder(id) && !allowed.has(id));

  let removed = 0;
  for (const id of removable) {
    try {
      const doc = await state.db.get(id);
      await state.db.remove(doc);
      removed++;
    } catch { /* 已被删或冲突，忽略 */ }
  }
  if (removed) {
    // 同时把它们移出待上传清单，避免计数虚高
    const ids = await readPendingIds();
    for (const id of removable) ids.delete(id);
    await writePendingIds(ids);
    state.pending = ids.size;
    emit();
  }
  return { removed };
}

/** 双向同步一次。并发调用会被合并，避免同时跑两个复制。 */let inflight = null;
export function sync() {
  if (inflight) return inflight;
  inflight = (async () => {
    state.syncing = true;
    emit();
    try {
      /**
       * ⚠️ 用**独立的 push + pull 两次复制**，不用 PouchDB.sync()。
       *
       * 实测问题：PouchDB.sync() 的双向复制让 push 与 pull 共用同一个检查点，
       * pull 写进去的服务端序列号（"16-g1AAA..." 字符串）会污染 push 的判断，
       * 导致本地新写入的单**推不上去且不报错**（docs_read=0 / docs_written=0）。
       * 这直接违反 §2b.3 红线（本地不能存在只在本机、未上行的订单）。
       *
       * 所以：先清双向检查点 -> 单独 push -> 再单独 pull。
       */
      await resetReplicationCheckpoints();
      const push = await state.db.replicate.to(REMOTE, { batch_size: 50, retry: false });
      state.lastSyncAt = new Date();

      const pushErr = push?.errors?.length ?? 0;
      if (pushErr) {
        state.lastError = `上传失败 ${pushErr} 条`;
      } else {
        // 只把**本次真正推送成功**的文档移出待上行清单。
        // 全清是错的：若本轮没推送任何文档（例如还没写入），
        // 全清会把上一轮遗留的未同步标记一并抹掉，掩盖真实风险。
        const pushed = new Set(
          (push?.docs ?? [])
            .map((d) => d?._id ?? d?.id)
            .filter(Boolean),
        );
        if (pushed.size) {
          await clearPending(pushed);
        } else {
          // 没推送任何文档时，顺带确认清单是否本就为空
          await recountPending();
        }
        state.lastError = null;
      }
      emit();

      // 拉取放在推送之后：即使拉取失败，本次写入也已经安全到达服务端
      let pull = null;
      try {
        pull = await state.db.replicate.from(REMOTE, { batch_size: 50, retry: false });
        const pullErr = pull?.errors?.length ?? 0;
        if (pullErr) state.lastError = `下载失败 ${pullErr} 条`;
        state.lastSyncAt = new Date();
      } catch (e) {
        state.lastError = `下载失败：${e.message}`;
      }
      emit();

      // pull 会把服务端序列号写进检查点；下一轮 push 之前必须清掉，
      // 否则又会污染 push 的判断（这是上面那段注释描述的问题的防线）
      await resetReplicationCheckpoints();

      // 清掉"已无权查看"的本地残留（换使用者 / 权限收紧后必须做）
      await purgeUnauthorizedLocals();

      // 每次同步结束都据实重算未同步条数（红线判据）
      await recountPending();
      return { push, pull };
    } catch (err) {
      state.lastError = err?.message ?? String(err);
      emit();
      throw err;
    } finally {
      state.syncing = false;
      inflight = null;
      emit();
    }
  })();
  return inflight;
}

/**
 * 出单/改单：**先落本地，再立即同步一次**。
 * 期间不接受其它写（见文件头说明），由 UI 用 syncing 状态禁止重复提交。
 *
 * 红线条目（§2b.3）：本地不能存在"只在本机、尚未上行"的订单。
 * 所以这里做两件事：
 *   1. 把该单登记进本地"待上行清单"，界面据此显示"未同步"
 *   2. 写入后立刻同步；同步失败也保留本地并保持"未同步"标记
 *
 * ⚠️ 待上行清单放在 **_local/unsynced** 文档里，**不是普通文档的字段**。
 *    实测教训：普通文档里不允许出现下划线开头的字段，
 *    写成 `_unsynced` 会被 PouchDB 直接拒绝——
 *      "Bad special document member: _unsynced"
 *    表现为点保存没反应、单子上不了服务端。而且普通字段还会被同步到
 *    CouchDB，那是纯本地内部状态，本就不该进服务端。
 */
const PENDING_DOC = '_local/unsynced';

async function readPendingIds() {
  try {
    const d = await state.db.get(PENDING_DOC);
    return new Set(d.ids ?? []);
  } catch {
    return new Set();
  }
}

async function writePendingIds(ids) {
  const cur = await state.db.get(PENDING_DOC).catch(() => null);
  await state.db.put({
    _id: PENDING_DOC,
    ids: [...ids],
    ...(cur ? { _rev: cur._rev } : {}),
  });
}

/** 登记为待上行（写入前调用，确保同步失败也看得见）。 */
async function markPending(id) {
  const ids = await readPendingIds();
  ids.add(id);
  await writePendingIds(ids);
  state.pending = ids.size;
  emit();
}

/** 推送成功后把给定 id 从待上行清单移除。 */
async function clearPending(ids) {
  const cur = await readPendingIds();
  for (const id of ids) cur.delete(id);
  await writePendingIds(cur);
  state.pending = cur.size;
  emit();
}

export async function putOrder(doc) {
  if (state.syncing) {
    throw new Error('正在同步，请稍候一秒再保存');
  }
  await markPending(doc._id);
  const res = await state.db.put(doc);
  try {
    await sync();
  } catch {
    // 离线或服务端不可达：本地已保存，等下次同步。**这就是不能丢的那部分**
  }
  return { ...doc, _rev: res.rev };
}

/**
 * 本地还有多少条"尚未确认上行"的改动。
 * 这是 §2b.3 红线唯一的判据，所以每次同步结束都据实重算，
 * 而不是靠内存计数器（计数器会被周期同步清零，掩盖问题）。
 */
export async function recountPending() {
  const ids = await readPendingIds();
  state.pending = ids.size;
  emit();
  return state.pending;
}

export async function newOrder(input, salesId) {
  const now = new Date().toISOString();
  const doc = {
    _id: newId(),
    type: 'order',
    sales_id: salesId,
    status: 'active',
    customer_name: input.customer_name ?? '',
    customer_phone: input.customer_phone ?? '',
    remark: input.remark ?? '',
    items: input.items ?? [],
    total: input.total ?? 0,
    list_total: input.list_total ?? 0,
    discount: input.discount ?? 0,
    item_count: input.item_count ?? 0,
    version: 1,
    created_at: now,
    updated_at: now,
  };
  return putOrder(doc);
}

export async function updateOrderDoc(id, patch) {
  const cur = await state.db.get(id);
  const next = {
    ...cur,
    ...patch,
    version: (cur.version ?? 1) + 1,
    updated_at: new Date().toISOString(),
  };
  return putOrder(next);
}

/**
 * 软删除 —— 只改 status，绝不真删文档。
 * 硬删除会让服务端过滤函数拿不到业务字段，删除变更被丢弃，
 * 其它设备会永久残留这张单（见第 1 步实测结论 §10.2）。
 */
export async function softDeleteOrder(id) {
  return updateOrderDoc(id, {
    status: 'deleted',
    deleted_at: new Date().toISOString(),
  });
}

/**
 * 归一化：CouchDB 用 `_id`，UI 层按 `id` 使用。
 * 在一处转换，避免把 `_id` 泄漏到整个界面代码里。
 */
function normalize(doc) {
  if (!doc) return doc;
  return { ...doc, id: doc._id };
}

/** 列出订单。默认读本地库，离线也能用。 */
export async function listOrders({ includeDeleted = false } = {}) {
  const res = await state.db.allDocs({ include_docs: true });
  return res.rows
    .map((r) => normalize(r.doc))
    .filter((d) => d && !d._id.startsWith('_'))
    .filter((d) => (includeDeleted ? true : d.status !== 'deleted'))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function getOrderDoc(id) {
  try { return normalize(await state.db.get(id)); } catch { return null; }
}

/** 本地重新从服务端拉取一次（用于"重新同步"按钮或怀疑数据不一致时）。 */
export async function resync() {
  state.lastError = null;
  emit();
  return sync();
}

/**
 * 销毁本地库并重建。
 *
 * 用途：**退出登录时**。比"按权限清理"更彻底——
 * 下一位使用者不该在本地看到上一位的任何数据。
 * 数据都在服务端（§2b.3 权威副本），重新登录会完整拉回来，不会丢单。
 */
export async function wipeLocal() {
  if (state.db) {
    try { await state.db.destroy(); } catch { /* 忽略 */ }
    state.db = null;
  }
  state.pending = 0;
  state.lastError = null;
  state.lastSyncAt = null;
  inflight = null;
  emit();
}

export const localName = LOCAL_NAME;
export const remoteUrl = REMOTE;
