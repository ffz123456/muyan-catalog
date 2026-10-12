/**
 * CouchDB 客户端与初始化（零外部依赖，用内置 fetch）
 *
 * 设计要点：
 *  - 过滤函数从 **认证身份**（req.userCtx.name）取 sales_id，不从查询参数取。
 *    这是整个权限模型唯一的攻击面：一旦 identity 可由客户端指定，隔离即失效。
 *  - 应用使用**专用账号**（默认 app），不用 admin 跑日常同步。
 *  - 初始化幂等：已存在的不重建，可反复运行。
 */

const DEFAULT_BASE = process.env.COUCHDB_URL || 'http://127.0.0.1:5984';
const ADMIN_USER = process.env.COUCHDB_ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.COUCHDB_ADMIN_PASS || '';
const APP_USER = process.env.COUCHDB_APP_USER || 'app';
const APP_PASS = process.env.COUCHDB_APP_PASS || 'app-local-dev';
export const DB = process.env.COUCHDB_DB || 'orders';
export const DDOC_ID = '_design/app';
export const FILTER_NAME = 'by_sales';

function authHeader(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** 低层请求：返回 { status, body }，不抛 HTTP 错误，便于断言具体状态码。 */
async function req(base, path, { method = 'GET', body, user, pass, contentType = 'application/json' } = {}) {
  const headers = {};
  if (user !== undefined) headers.Authorization = authHeader(user, pass ?? '');
  if (body !== undefined) headers['Content-Type'] = contentType;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

/** admin 客户端（仅用于初始化与运维，不用于日常同步）。 */
export function adminClient(base = DEFAULT_BASE) {
  if (!ADMIN_PASS) throw new Error('未提供 admin 密码（环境变量 COUCHDB_ADMIN_PASS）');
  return {
    base,
    get: (p) => req(base, p, { user: ADMIN_USER, pass: ADMIN_PASS }),
    put: (p, b) => req(base, p, { method: 'PUT', body: b, user: ADMIN_USER, pass: ADMIN_PASS }),
    post: (p, b) => req(base, p, { method: 'POST', body: b, user: ADMIN_USER, pass: ADMIN_PASS }),
    del: (p) => req(base, p, { method: 'DELETE', user: ADMIN_USER, pass: ADMIN_PASS }),
  };
}

/**
 * 过滤函数 —— 写入设计文档。
 *
 * 三条规则（对应主文档 §5.1）：
 *   ① 系统文档（_design/_local 等）一律不下发
 *   ② 非订单文档（产品、货源）全公司共享
 *   ③ 订单按 sales_id 隔离；admin 可见全部
 *
 * ⚠️ sales_id 取自 req.userCtx.name（服务端认证身份），
 *    绝不从 req.query 取 —— 否则客户端改个参数就能看到别人的单。
 */
export const FILTER_SOURCE = `function (doc, req) {
  var salesId = (req.userCtx && req.userCtx.name) || null;
  if (!salesId) return false;

  // ① 系统文档不下发
  if (doc._id.charAt(0) === '_') return false;

  // ② 非订单文档全公司共享
  var isOrder = doc._id.indexOf('order:') === 0 || doc._id.indexOf('orderrev:') === 0;
  if (!isOrder) return true;

  // ③ 订单按 sales_id 隔离
  if (salesId === 'admin') return true;
  return doc.sales_id === salesId;
}`;

/**
 * 校验函数 —— 防止跨销售伪造订单。
 *
 * 为什么必须要有它：
 *   过滤函数只控制「读」，不控制「写归属」。实测确认：bob 可以写入
 *   `{_id:'order:x', sales_id:'alice'}`，而这条记录会被下发到 alice 的客户端，
 *   冒充成 alice 自己的单。
 *
 * ⚠️ CouchDB 的限制：**每个设计文档只能有一个 validate_doc_update**。
 *    若将来有多个设计文档都要校验，只有其中一个会生效（最后写入的赢）。
 *    因此所有校验规则必须集中在这一个函数里。
 */
export const VALIDATE_SOURCE = `function (newDoc, oldDoc, userCtx, secObj) {
  var roles = (userCtx && userCtx.roles) || [];
  var name = (userCtx && userCtx.name) || null;

  function isAdmin() {
    return roles.indexOf('_admin') !== -1 || name === 'admin';
  }

  var isOrder = newDoc._id.indexOf('order:') === 0 || newDoc._id.indexOf('orderrev:') === 0;
  if (!isOrder) return;                       // 非订单文档不在此校验

  if (isAdmin()) return;                      // admin 不受限

  // 订单的归属必须等于写入者本人
  if (newDoc.sales_id !== name) {
    throw({ forbidden: '订单的 sales_id 必须是你本人：期望 ' + name
      + '，实际 ' + (newDoc.sales_id === undefined ? '(缺失)' : newDoc.sales_id) });
  }

  // 订单金额必须是非负数字，避免脏数据进入同步链路
  if (newDoc.total !== undefined && (typeof newDoc.total !== 'number' || newDoc.total < 0)) {
    throw({ forbidden: 'total 必须是非负数字' });
  }
}`;

/** 幂等初始化：建库、建应用账号、写安全策略、写过滤函数。 */
export async function bootstrap({ log = console.log } = {}) {
  const c = adminClient();
  const results = [];

  /* 1. 数据库 */
  const head = await c.get(`/${DB}`);
  if (head.status === 404) {
    const made = await c.put(`/${DB}`);
    results.push(`创建数据库 ${DB}：HTTP ${made.status}`);
  } else {
    results.push(`数据库 ${DB} 已存在`);
  }

  /* 2. 应用账号（幂等）
   *
   * ⚠️ 必须先确保 _users 库存在。
   *    实测踩过：容器化部署的全新 CouchDB 实例里**只有我们自建的 orders 库**，
   *    _users 并不自动存在，于是写账号返回 404，而日志里只留下一行
   *    "创建应用账号 app：HTTP 404"——不显眼，但账号确实没建出来。
   */
  const usersDb = await c.put('/_users');
  if (usersDb.status < 300) {
    results.push('创建 _users 库：HTTP ' + usersDb.status);
  } else if (usersDb.status !== 412) {
    // 412 = 已存在，属正常
    results.push(`⚠️ _users 库检查异常：HTTP ${usersDb.status} ${JSON.stringify(usersDb.body)?.slice(0, 100)}`);
  }

  const userId = `org.couchdb.user:${APP_USER}`;
  const existing = await c.get(`/_users/${encodeURIComponent(userId)}`);
  const userDoc = {
    _id: userId,
    name: APP_USER,
    type: 'user',
    roles: ['app'],
    password: APP_PASS,
  };
  if (existing.status === 200) {
    userDoc._rev = existing.body._rev;
    const upd = await c.put(`/_users/${encodeURIComponent(userId)}`, userDoc);
    results.push(`应用账号 ${APP_USER} 已更新口令与角色：HTTP ${upd.status}`);
  } else {
    const made = await c.put(`/_users/${encodeURIComponent(userId)}`, userDoc);
    if (made.status >= 300) {
      results.push(`⚠️ 创建应用账号 ${APP_USER} 失败：HTTP ${made.status} ${JSON.stringify(made.body)?.slice(0, 120)}`);
    } else {
      results.push(`创建应用账号 ${APP_USER}：HTTP ${made.status}`);
    }
  }

  /* 3. 安全策略：只允许 app 角色读写本库 */
  const sec = await c.put(`/${DB}/_security`, {
    admins: { names: [ADMIN_USER], roles: [] },
    members: { names: [], roles: ['app'] },
  });
  results.push(`设置 _security：HTTP ${sec.status}（members.roles=[app]）`);

  /* 4. 过滤函数 + 校验函数（设计文档） */
  const ddocExisting = await c.get(`/${DB}/${DDOC_ID}`);
  const cur = ddocExisting.status === 200 ? ddocExisting.body : null;
  const upToDate = cur
    && cur.filters?.[FILTER_NAME] === FILTER_SOURCE
    && cur.validate_doc_update === VALIDATE_SOURCE;

  if (upToDate) {
    results.push(`设计文档 ${DDOC_ID} 已是最新，跳过`);
  } else {
    const ddoc = {
      _id: DDOC_ID,
      language: 'javascript',
      filters: { [FILTER_NAME]: FILTER_SOURCE },
      validate_doc_update: VALIDATE_SOURCE,
      views: {},
    };
    if (cur) ddoc._rev = cur._rev;
    const put = await c.put(`/${DB}/${DDOC_ID}`, ddoc);
    results.push(`写入设计文档 ${DDOC_ID}（过滤 + 校验）：HTTP ${put.status}`);
  }

  for (const r of results) log('  ' + r);
  return results;
}

/**
 * 以某个用户身份登录，返回带 Cookie 的认证配置。
 * 用于验证 req.userCtx.name 是否真的来自认证身份。
 */
export async function login(username, password, base = DEFAULT_BASE) {
  const res = await fetch(`${base}/_session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: username, password }),
  });
  const body = await res.json();
  return {
    ok: res.ok && body.ok === true,
    status: res.status,
    userCtx: body,
    cookie: res.headers.getSetCookie ? res.headers.getSetCookie().join('; ') : res.headers.get('set-cookie'),
  };
}

export const config = {
  base: DEFAULT_BASE,
  adminUser: ADMIN_USER,
  appUser: APP_USER,
  appPass: APP_PASS,
  db: DB,
};

export { req };

/* ------------------------------------------------------------------ *
 * 应用层：会话与文档读写
 *
 * 为什么服务端做代理而不是让浏览器直连 CouchDB：
 *   过滤函数取 req.userCtx.name，这必须是**服务端认证身份**。
 *   浏览器直连就必须把凭据给浏览器，且身份可被伪造。
 *   由服务端代理后，身份由服务端注入，客户端无法影响。
 * ------------------------------------------------------------------ */

/** 用某账号登录 CouchDB，返回 { ok, name, roles, cookie }。 */
export async function loginAs(name, password, base = DEFAULT_BASE) {
  const res = await fetch(`${base}/_session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password }),
  });
  const body = await res.json().catch(() => ({}));
  const setCookie = res.headers.getSetCookie
    ? res.headers.getSetCookie().join('; ')
    : (res.headers.get('set-cookie') ?? '');
  // 只保留 Cookie 名值对，避免把属性串进后续请求
  const cookie = setCookie.split(',').map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
  return {
    ok: res.ok && body.ok === true,
    status: res.status,
    name: body.name ?? null,
    roles: body.roles ?? [],
    cookie,
  };
}

/**
 * 以某个身份读写文档（用 Cookie，不用 admin 凭据）。
 * 这样所有读写都会经过 CouchDB 的 validate_doc_update，
 * 与客户端同步走完全相同的规则。
 */
export function userClient(cookie, base = DEFAULT_BASE) {
  return {
    base,
    get: (p) => fetchAuth(base, p, { method: 'GET', cookie }),
    put: (p, b) => fetchAuth(base, p, { method: 'PUT', cookie, body: b }),
    post: (p, b) => fetchAuth(base, p, { method: 'POST', cookie, body: b }),
    del: (p) => fetchAuth(base, p, { method: 'DELETE', cookie }),
  };
}

/** 带 Cookie 的请求（不抛 HTTP 错误，便于按状态码判断）。 */
export async function fetchAuth(base, path, { method = 'GET', cookie, body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** 直接取某文档（走 admin，用于迁移与运维）。 */
export async function getDocRaw(id, { base = DEFAULT_BASE } = {}) {
  const c = adminClient(base);
  return c.get(`/${DB}/${encodeURIComponent(id)}`);
}

/**
 * 删除 CouchDB 中不存在于 keepIds 的订单文档（用于数据迁移对齐）。
 * ⚠️ 这是**运维操作**，不是业务删除。业务删除一律软删除。
 */
export async function pruneOrders(keepIds, { log = () => {} } = {}) {
  const c = adminClient();
  const all = await c.get(`/${DB}/_all_docs?startkey=%22order%3A%22&endkey=%22order%3A%5Cufff0%22`);
  const rows = all.body?.rows ?? [];
  let removed = 0;
  for (const row of rows) {
    if (keepIds.has(row.id)) continue;
    const del = await c.del(`/${DB}/${encodeURIComponent(row.id)}?rev=${row.value.rev}`);
    if (del.status < 300) { removed++; log(`  清理 ${row.id}`); }
  }
  return { scanned: rows.length, removed };
}
