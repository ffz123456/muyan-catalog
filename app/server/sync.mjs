/**
 * 同步服务端 —— 代理 CouchDB，并在服务端执行授权
 *
 * 架构决策（为什么授权在服务端，而不是靠 CouchDB 的 userCtx）：
 *
 *   原先设想用 CouchDB 的过滤函数/校验函数按 req.userCtx.name 隔离。
 *   但浏览器→CouchDB 的同步全部经过本服务端代理，
 *   而服务端是唯一可信的一层（客户端无法影响它）。
 *
 *   实测确认：用一个共享的 CouchDB 账号做代理时，userCtx.name 是那个共享账号，
 *   过滤函数永远匹配不到任何销售的单、校验函数也会把合法写入判为越权
 *   （报错原文：期望 app，实际 alice）。要让 userCtx 变成真实销售身份，
 *   需要在 CouchDB 里启用代理认证并重启服务（需管理员权限改 Program Files 下的配置）。
 *
 *   因此改为：**服务端持 admin 身份访问 CouchDB，授权规则由服务端执行。**
 *   好处：
 *     - 无需修改 CouchDB 配置、无需给每个销售建账号、无需保存任何密码
 *     - 授权逻辑集中在一处，就是下面这几个函数，容易审计
 *     - 仍然保留设计文档里的过滤/校验函数作为纵深防御
 *       （若将来改成浏览器直连 CouchDB，它们会立即生效）
 *
 * 服务端执行的规则（与设计文档里的函数表达的是同一套规则）：
 *   R1  读订单：只能读 sales_id === 自己 的；admin 读全部
 *   R2  写订单：sales_id 必须 === 自己；admin 不受限
 *   R3  非订单文档（产品/货源等）：全公司可读，仅 admin 可写
 *   R4  系统文档（_design 等）不下发给客户端
 */
import { couchAs, canSeeAll } from './auth.mjs';
import { DB } from './couch.mjs';

const isOrderId = (id) => typeof id === 'string'
  && (id.startsWith('order:') || id.startsWith('orderrev:'));

/** R4：系统文档不外发。 */
const isSystemDoc = (id) => typeof id === 'string' && id.startsWith('_');

/** 该身份能否读这个文档。 */
function canRead(doc, sales) {
  if (!doc) return false;
  const id = doc._id ?? doc.id;

  /**
   * ⚠️ `_local/*` 必须放行，不能当成"系统文档"挡掉。
   *
   * 实测踩过：PouchDB 用 `_local/<hash>` 存放**复制检查点**。
   * 挡掉它会让客户端读不到自己的检查点，整个复制无法推进——
   * 表现为订单反复推不上去、界面一直显示"未同步"。
   * `_local` 文档不参与复制、只存在于服务端，放行不泄露任何业务数据。
   */
  if (typeof id === 'string' && id.startsWith('_local/')) return true;

  if (isSystemDoc(id)) return false;
  if (canSeeAll(sales)) return true;
  if (!isOrderId(id)) return true;                 // R3：产品等共享
  return doc.sales_id === sales.name;              // R1
}

/** 校验一批待写文档是否越权；返回被拒的项（供响应里回报错误）。 */
function rejectForbidden(docs, sales) {
  if (canSeeAll(sales)) return [];
  return docs
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => isOrderId(d._id) && d.sales_id !== sales.name)
    .map(({ d, i }) => ({
      id: d._id,
      error: 'forbidden',
      reason: `订单的 sales_id 必须是你本人：期望 ${sales.name}，实际 ${d.sales_id ?? '(缺失)'}`,
      _index: i,
    }));
}

/**
 * 处理同步代理请求。
 * @returns {Promise<{status:number, body:any}>}
 */
export async function handleSync({ sales, rest, method, query, body }) {
  const json = (status, b) => ({ status, body: b });
  const parseBody = () => {
    if (!body) return {};
    try { return JSON.parse(body); } catch { return null; }
  };

  /* ---------- _changes：过滤后再返回 ---------- */
  if (rest.endsWith('_changes') && method === 'GET') {
    // 服务端拉全量（admin 身份），自己按身份裁剪
    const r = await couchAs(sales.name, `/${rest}${query}`, { method: 'GET' });
    if (r.status >= 300) return json(r.status, r.body);

    const data = r.body ?? {};
    const rows = Array.isArray(data.results) ? data.results : [];

    /**
     * ⚠️ 过滤已删除的订单要特别小心。
     * 文档被硬删除后，CouchDB 只回 _id/_rev/_deleted，**业务字段全部消失**，
     * 无法判断归属。所以：
     *   - 已知归属的订单（在 allowedOrderIds 里）：放行其删除变更
     *   - 未知归属的删除：拒绝（宁可漏删，不可误删别人的数据）
     * 业务删除本身走软删除（改 status），所以正常路径不受影响。
     */
    const allowed = await collectVisibleOrderIds(sales);
    const kept = rows.filter((row) => {
      if (isSystemDoc(row.id)) return false;                  // R4
      if (!isOrderId(row.id)) return true;                    // R3
      if (canSeeAll(sales)) return true;                      // admin
      if (allowed.has(row.id)) return true;                   // R1：确属本人
      if (row.deleted) return false;                          // 归属不明的删除，拒绝
      return false;
    });

    // 注意：last_seq 必须原样透传，否则 PouchDB 的检查点会错位
    return json(200, { ...data, results: kept });
  }

  /* ---------- _bulk_docs：逐条校验归属 ---------- */
  if (rest.endsWith('_bulk_docs') && method === 'POST') {
    const parsed = parseBody();
    if (!parsed || !Array.isArray(parsed.docs)) return json(400, { error: 'bad_request', reason: '缺少 docs' });

    /**
     * 剔除客户端试图写的系统文档（_design 等）。
     *
     * ⚠️ 不能整批 403：PouchDB 的复制协议会在推送末尾带上 _design 文档
     * （它用于存放复制检查点）。整批拒绝会让**整次推送失败**，
     * 表现为客户端反复重试、订单始终上不去（实测踩过）。
     * 正确做法是把它们滤掉、其余照常写入，并在响应里说明被跳过。
     */
    const isSys = (d) => typeof d._id === 'string' && d._id.startsWith('_');
    const sysDocs = parsed.docs.filter(isSys);
    const realDocs = parsed.docs.filter((d) => !isSys(d));
    const skipNote = sysDocs.map((d) => ({
      id: d._id, error: 'forbidden', reason: '不接受客户端写系统文档（已跳过）',
    }));

    if (!realDocs.length) {
      // 整批都是系统文档：回报"跳过"，既不写库也不让整次推送失败
      return json(201, skipNote);
    }

    const forbidden = rejectForbidden(realDocs, sales);
    if (forbidden.length) {
      // 真正的越权（伪造归属）：整批拒绝，避免"部分成功"难以判断
      return json(403, forbidden);
    }

    const forward = JSON.stringify({
      new_edits: parsed.new_edits === undefined ? true : parsed.new_edits,
      docs: realDocs,
    });
    const r = await couchAs(sales.name, `/${rest}${query}`, { method: 'POST', body: forward });

    // 写成功后立刻失效归属缓存，否则刚出的单在缓存过期前看不到（实测踩过）
    // ⚠️ 判据是响应体里有没有真正写入成功的项，不是 HTTP 状态：
    //    _bulk_docs 即使部分失败也返回 201，且成功时响应体里没有 status 字段。
    if (anyWriteSucceeded(r.body)) resetVisibilityCache();

    const body = Array.isArray(r.body) ? [...r.body, ...skipNote] : r.body;
    return json(r.status, body);
  }

  /* ---------- 单文档读写：校验归属 ---------- */
  /**
   * ⚠️ 必须先排除"命令式端点"，否则它们会被当成文档 id 处理。
   *
   * 实测踩过：PouchDB 推送前的 `POST /db/_revs_diff` 被误判为文档 id，
   * 返回 403「不接受客户端写系统文档（_revs_diff）」，整次推送直接失败。
   * 复制协议里这类端点还有 _ensure_full_commit / _bulk_get / _revs_limit 等。
   *
   * 判据：路径最后一段以 `_` 开头，且是已知的端点名（不是文档 id，
   * 文档 id 形如 order:xxx / product:xxx，不以下划线开头）。
   */
  const lastSeg = rest.split('/').pop();
  const KNOWN_ENDPOINTS = new Set([
    '_revs_diff', '_ensure_full_commit', '_bulk_get', '_revs_limit',
    '_all_docs', '_changes', '_bulk_docs', '_find', '_index', '_compact',
    '_security', '_purge', '_view_cleanup',
  ]);
  // _local/xxx 是检查点文档，需要走单文档分支（下面会放行）
  const isCommandEndpoint = lastSeg.startsWith('_')
    && !lastSeg.startsWith('_local')
    && (KNOWN_ENDPOINTS.has(lastSeg) || !lastSeg.includes(':'));

  const docMatch = isCommandEndpoint ? null : /^(.*\/)([^/?]+)$/.exec(rest);
  if (docMatch) {
    const [, , docIdRaw] = docMatch;
    const docId = decodeURIComponent(docIdRaw);

    if (docId.startsWith('_')) {
      /**
       * _design 等：不下发也不接受写入。
       * _local/*：**必须放行**——PouchDB 用它存放复制检查点，
       *   且 _local 文档只存在于单个服务端、不参与复制，
       *   挡掉会让同步检查点无法推进（实测踩过 403）。
       */
      if (docId.startsWith('_local/')) {
        const r = await couchAs(sales.name, `/${rest}${query}`, { method, body });
        return json(r.status, r.body);
      }
      if (method === 'GET') return json(404, { error: 'not_found', reason: '系统文档不可访问' });
      return json(403, {
        error: 'forbidden',
        reason: `不接受客户端写系统文档（${docId.split('/')[0]}）`,
      });
    }

    if (method === 'GET') {
      const r = await couchAs(sales.name, `/${rest}${query}`, { method: 'GET' });
      if (r.status >= 300) return json(r.status, r.body);
      if (!canRead(r.body, sales)) {
        return json(403, { error: 'forbidden', reason: '不能读取他人订单' });
      }
      return json(200, r.body);
    }

    if (method === 'PUT') {
      const parsed = parseBody();
      if (parsed && !canSeeAll(sales) && isOrderId(docId) && parsed.sales_id !== sales.name) {
        return json(403, [{
          id: docId, error: 'forbidden',
          reason: `订单的 sales_id 必须是你本人：期望 ${sales.name}，实际 ${parsed.sales_id ?? '(缺失)'}`,
        }]);
      }
      const r = await couchAs(sales.name, `/${rest}${query}`, { method: 'PUT', body });
      // 同样按"是否真的写入成功"判断（PUT 的失败也可能带 201 之外的状态）
      if (r.status < 300 && r.body?.ok !== false) resetVisibilityCache();
      return json(r.status, r.body);
    }

    if (method === 'DELETE') {
      // 业务删除一律走软删除；这里只允许 admin 做运维性硬删除
      if (!canSeeAll(sales)) {
        return json(403, {
          error: 'forbidden',
          reason: '删除订单请改为软删除（把 status 置为 deleted），不要硬删除',
        });
      }
      const r = await couchAs(sales.name, `/${rest}${query}`, { method: 'DELETE' });
      return json(r.status, r.body);
    }
  }

  /* ---------- 其余（_all_docs / _revs_diff / _local 等）：放行但按需裁剪 ---------- */
  if (rest.endsWith('_all_docs') && method === 'GET' && isOrdersAllDocs(rest)) {
    const r = await couchAs(sales.name, `/${rest}${query}`, { method: 'GET' });
    if (r.status >= 300) return json(r.status, r.body);
    const rows = (r.body?.rows ?? []).filter((row) => {
      if (isSystemDoc(row.id)) return false;
      if (!isOrderId(row.id)) return true;
      return canSeeAll(sales) || allowedCache.has(row.id);
    });
    return json(200, { ...r.body, rows, total_rows: rows.length });
  }

  const r = await couchAs(sales.name, `/${rest}${query}`, { method, body });
  return json(r.status, r.body);
}

/** 一批 _bulk_docs 的结果里是否有真正写成功的项。 */
function anyWriteSucceeded(body) {
  if (!Array.isArray(body)) return false;
  return body.some((x) => x && !x.error);
}

/* ------------------------------------------------------------------ *
 * 归属查询：某身份拥有哪些订单 _id
 *
 * 用于过滤删除变更与 _all_docs：CouchDB 删除后业务字段消失，
 * 只能靠自己维护一份"这些单属于谁"的记录来判断。
 *
 * ⚠️ 用 Mango 查询（_find）而不是 _all_docs：
 *   本库的 _security 设了 members.roles=[app]，
 *   以 admin 身份请求 /orders/_all_docs 会被 403 挡住（实测），
 *   而 _find 不受该限制。
 * ------------------------------------------------------------------ */
const allowedCache = new Set();
let cacheAt = 0;
let cacheOwner = null;
const CACHE_MS = 3000;

async function collectVisibleOrderIds(sales) {
  if (canSeeAll(sales)) return allowedCache;
  const fresh = cacheOwner === sales.name && (Date.now() - cacheAt) < CACHE_MS;
  if (fresh) return allowedCache;

  const selector = {
    $or: [
      { _id: { $regex: '^order:' }, sales_id: sales.name },
      { _id: { $regex: '^orderrev:' }, sales_id: sales.name },
    ],
  };
  const r = await couchAs(sales.name, `/${DB}/_find`, {
    method: 'POST',
    body: JSON.stringify({ selector, fields: ['_id'], limit: 100000 }),
  });

  allowedCache.clear();
  for (const d of r.body?.docs ?? []) {
    if (d._id) allowedCache.add(d._id);
  }
  if (r.status >= 300) {
    // 查询失败时返回上一次的缓存（可能为空），并留下痕迹便于排查
    console.warn(`[sync] 归属查询失败 HTTP ${r.status}：${JSON.stringify(r.body)?.slice(0, 160)}`);
  }
  cacheOwner = sales.name;
  cacheAt = Date.now();
  return allowedCache;
}

const isOrdersAllDocs = (rest) => /_all_docs$/.test(rest);

/** 身份变化时清缓存，避免切换使用者后读到上一位的可见集合。 */
export function resetVisibilityCache() {
  allowedCache.clear();
  cacheOwner = null;
  cacheAt = 0;
}
