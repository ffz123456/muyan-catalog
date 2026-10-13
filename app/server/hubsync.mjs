/**
 * 自研同步路由 —— **不依赖 CouchDB**
 *
 * 协议只有两个端点（对比 CouchDB 复制协议要 6 个）：
 *
 *   POST /api/hub/pull   { since }           → { changes: [...], lastSeq }
 *   POST /api/hub/push   { changes: [...] }  → { results: [...] }
 *
 * 为什么不用 PouchDB 复制协议：
 *   实测抓到了它完整的行为——`GET /db/`、`_local/<hash>` 读写检查点、
 *   `_revs_diff`、`_changes?since=&style=all_docs`、`_bulk_docs`，
 *   还有 `PUT /db/_local/x` 里那套 `history` 数组。
 *   要兼容它就得把这些形状**全部**做对；错一处不会报错，
 *   只是**静默不同步**——正是这个项目反复踩过的那类故障。
 *
 *   自定义协议的语义是明确写出来的，而且能直接被断言。
 *   代价是客户端要改传输层（3 处），但换来的是可验证性。
 *
 * 授权：复用 authz.mjs 的规则（与 CouchDB 那条路**同一份**）。
 *   R1 读：只能读自己的单；admin 读全部
 *   R2 写：sales_id 必须是自己；admin 不受限
 *
 * 返回形状刻意与原来的 `_changes` / `_bulk_docs` 保持一致，
 * 让客户端与验证脚本的既有断言仍然成立。
 */
import { canRead, canWrite } from './authz.mjs';
import * as store from './orderstore.mjs';

/**
 * 拉取：返回 since 之后的变更。
 *
 * @param {object} opts
 * @param {object} opts.sales  当前身份（来自服务端会话，客户端无法伪造）
 * @param {number} opts.since  客户端已有的序列号
 */
export async function pull({ sales, since = 0 }) {
  const { results, lastSeq } = await store.changesSince(
    Number(since) || 0,
    (doc) => canRead(doc, sales),
  );

  /**
   * 返回完整文档，让客户端一次拿到手，不用再逐个 GET。
   *
   * 为什么可以这样：一家公司的订单量很小（一年几千张），
   * 增量拉取每次通常只有个位数条。批量给全文比"先给 id 再逐个取"少一轮往返，
   * 而且**减少了失败点**——逐个取时中间失败会留下"变更列表拿到了但文档没拿全"
   * 的半吊子状态。
   */
  const changes = [];
  for (const r of results) {
    const doc = await store.getDoc(r.id);
    if (!doc) continue;
    // 再判一次：changesSince 已经过滤过，但文档可能在这一瞬间被改动
    if (!canRead(doc, sales)) continue;
    changes.push({ seq: doc._seq, id: doc._id, rev: doc._rev, doc: stripInternal(doc) });
  }

  return { changes, lastSeq };
}

/**
 * 推送：把客户端的本地变更写上来。
 *
 * 冲突处理是**乐观并发**：客户端要说明自己基于哪个修订（rev），
 * 与服务端当前修订不一致就判 conflict，并把当前版本回给客户端。
 *
 * 为什么不做自动合并：
 *   两个人在同一张单上同时改，业务上该由人决定留哪个。
 *   自动合并可能把一方刚改的成交价悄悄覆盖掉——那比报冲突糟得多。
 *   这个场景概率很低（各自管自己的单），报冲突让客户端提示重试就够了。
 */
export async function push({ sales, changes = [] }) {
  const entries = [];

  for (const c of changes ?? []) {
    if (!c) continue;
    let doc;
    try {
      doc = typeof c.doc === 'string' ? JSON.parse(c.doc) : c.doc;
    } catch {
      entries.push({ id: c.id, doc: null, rev: c.rev, _bad: '文档内容无法解析' });
      continue;
    }
    entries.push({ id: c.id ?? doc?._id, doc, rev: c.rev ?? null });
  }

  const bad = entries.filter((e) => e._bad);
  const good = entries.filter((e) => !e._bad);

  const results = await store.pushChanges(
    good.map((e) => ({ id: e.id, doc: e.doc, rev: e.rev })),
    {
      canWrite: (doc) => canWrite(doc, sales),
    },
  );

  return {
    results: [
      ...results,
      ...bad.map((e) => ({ id: e.id, error: 'bad_request', reason: e._bad })),
    ],
  };
}

/**
 * 去掉只在服务端有意义的内部字段。
 *
 * `_seq` 是我们的变更序列号，客户端不需要（它有 lastSeq）。
 * 发出去会让客户端把它当成文档的一部分存进本地库，白白占空间，
 * 而且下次推上来时会被当成"新字段"，让修订号计算不一致。
 */
function stripInternal(doc) {
  const { _seq, ...rest } = doc;
  void _seq;
  return rest;
}
