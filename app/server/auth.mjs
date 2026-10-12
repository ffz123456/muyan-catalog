/**
 * 会话 —— 应用登录身份，以及同步代理用的 CouchDB 连接
 *
 * 身份如何传递（两层，互不依赖）：
 *   第 1 层（应用层）：浏览器带 cookie 会话 -> 服务端知道"现在是谁在操作"
 *                      写入订单时由服务端**强制**填 sales_id，不接受客户端传值
 *   第 2 层（数据库层）：服务端用 app 账号访问 CouchDB，
 *                      CouchDB 的 validate_doc_update 校验 sales_id 合法且为订单类型
 *
 * 为什么不用每个销售一个 CouchDB 账号：
 *   订单同步走服务端代理，代理必须用一个统一身份连 CouchDB；
 *   逐个销售建账号会让代理无法代表他们。**归属由服务端应用层强制**，
 *   这才是可信的那一层（客户端无法影响）。
 *
 * 为什么服务端代而不让浏览器直连 CouchDB：
 *   过滤函数取 req.userCtx.name。若浏览器直连就得把凭据交给浏览器，
 *   且身份可被伪造。服务端代理后，身份由服务端注入。
 */
import crypto from 'node:crypto';
import { config, loginAs, fetchAuth } from './couch.mjs';

/* ---------------- 服务端连 CouchDB 的身份 ---------------- */

/**
 * 服务端访问 CouchDB 用的身份。
 *
 * ⚠️ 用 **admin**，不是共享的 app 账号。原因：
 *   同步全部经过本服务端代理，服务端是唯一可信层，
 *   授权规则由服务端自己执行（见 server/sync.mjs 顶部说明）。
 *   用共享 app 账号反而会让 CouchDB 的 userCtx 变成那个账号，
 *   导致过滤/校验函数全部失效（已实测：报"期望 app，实际 alice"）。
 *
 * 用 admin 的另一个好处：admin 天然不受用户级校验限制，
 * 服务端可以在校验通过后代表销售写库。
 */
let adminSession = null;   // { cookie, at }

async function ensureAdminSession() {
  const fresh = adminSession && (Date.now() - adminSession.at) < 10 * 60 * 1000;
  if (fresh) return adminSession;
  const s = await loginAs(config.adminUser, process.env.COUCHDB_ADMIN_PASS ?? '');
  if (!s.ok) {
    throw Object.assign(
      new Error(`无法以 ${config.adminUser} 身份登录 CouchDB：HTTP ${s.status}。`
        + '请确认 app/.env 里的 COUCHDB_ADMIN_PASS 正确'),
      { status: 503 },
    );
  }
  adminSession = { cookie: s.cookie, at: Date.now() };
  return adminSession;
}

/** 带自动重登的 CouchDB 请求（admin 身份）。 */
export async function couchAs(_user, path, opts = {}) {
  let s = await ensureAdminSession();
  let r = await fetchAuth(config.base, path, { ...opts, cookie: s.cookie });
  if (r.status === 401) {          // 会话过期，重登一次
    adminSession = null;
    s = await ensureAdminSession();
    r = await fetchAuth(config.base, path, { ...opts, cookie: s.cookie });
  }
  return r;
}

/* ---------------- 浏览器会话 ---------------- */

const COOKIE = 'fs_sid';
const SESSION_TTL = 30 * 24 * 3600 * 1000;   // 30 天：销售不该天天被踢出去重登

/** 进程内会话表。重启即失效（销售需重选身份），可接受。 */
const sessions = new Map();

export function createSession(name) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { name, at: Date.now() });
  return sid;
}

export function readSession(req) {
  const raw = req.headers.cookie ?? '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s) return null;
  if (Date.now() - s.at > SESSION_TTL) { sessions.delete(m[1]); return null; }
  s.at = Date.now();
  return { sid: m[1], ...s };
}

export function destroySession(req) {
  const s = readSession(req);
  if (s) sessions.delete(s.sid);
}

export function sessionCookie(sid, { secure = false } = {}) {
  const parts = [`${COOKIE}=${sid}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL / 1000)}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/* ---------------- 权限判断 ---------------- */

/** 是否可以看全部订单（管理者）。 */
export function canSeeAll(sales) {
  return !!sales?.admin;
}
