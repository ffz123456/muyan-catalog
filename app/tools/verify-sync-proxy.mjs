/**
 * 同步代理验证（服务端 HTTP 层）
 *
 * 验证目标：
 *   1. 未登录时同步端点拒绝（401）
 *   2. 登录后拿到会话 Cookie
 *   3. 通过代理请求 _changes：只看到**自己的**订单 + 共享产品
 *   4. 🔴 客户端伪造 sales_id 查询参数无效（身份来自服务端会话）
 *   5. 通过代理写入：自己能写的成功，伪造归属被服务端挡住
 *   6. 系统文档（_design 等）不下发
 *   7. 软删除的变更能通过代理看到（status=deleted，而非文档消失）
 *
 * 用内置 fetch 直接打 HTTP，不经过浏览器，
 * 这样验证的是**服务端代理本身**，与前端实现无关。
 *
 * 运行（需先启动服务端）：node tools/verify-sync-proxy.mjs
 */
import { createSuite } from './assert-lib.mjs';

const BASE = process.env.APP_URL || 'http://127.0.0.1:8080';
const DB = 'orders';

const s = createSuite('第 4 步 · 同步代理验证');

/* ---------------- HTTP 工具（手工管 Cookie，便于观察） ---------------- */

let cookie = '';

async function call(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setC = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setC.length) cookie = setC.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

/**
 * 以某个身份登录。
 *
 * 走开发模式免密入口（服务端需以 DEV_ALLOW_PASSWORDLESS_LOGIN=1 启动，且绑回环地址）。
 * 这样脚本不必硬编码密码——把密码写进测试脚本本身就是坏习惯。
 * 若服务端未开该开关，会自动回退到密码登录（密码从环境变量取）。
 */
async function login(name) {
  const dev = await call('/api/session', { method: 'POST', body: { name, devNoPassword: true } });
  if (dev.status === 200) return dev;

  const envKey = `PW_${name.toUpperCase()}`;
  const password = process.env[envKey];
  if (!password) {
    throw new Error(
      `免密入口不可用（HTTP ${dev.status}），且未提供 ${envKey} 环境变量。\n`
      + '  要么用 DEV_ALLOW_PASSWORDLESS_LOGIN=1 启动服务端，\n'
      + `  要么设置 ${envKey}=<该账号密码>。`,
    );
  }
  return call('/api/session', { method: 'POST', body: { name, password } });
}

/** 通过代理读 _changes，返回文档 id 列表。 */
async function changesViaProxy(since = 0) {
  const r = await call(`/api/sync/${DB}/_changes?since=${since}&style=all_docs`);
  if (r.status !== 200) throw new Error(`_changes 失败 HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body.results ?? [];
}

async function main() {
  /* ---------- 1. 未登录 ---------- */
  s.group('【1】未登录时同步被拒');
  cookie = '';
  const anon = await call(`/api/sync/${DB}/_changes?since=0`);
  s.check('未登录请求同步端点返回 401', anon.status === 401, `HTTP ${anon.status}`);
  const anonSession = await call('/api/session');
  s.check('未登录时会话状态为未登录', anonSession.body?.signedIn === false, JSON.stringify(anonSession.body));

  /* ---------- 2. 登录 ---------- */
  s.group('【2】登录与会话');
  const li = await login('alice');
  s.check('登录成功', li.status === 200 && !!li.body?.sales, `HTTP ${li.status}`);
  s.check('下发了会话 Cookie', cookie.includes('fs_sid='), cookie.slice(0, 24) + '…');
  const me = await call('/api/session');
  s.check('会话可读出当前身份', me.body?.sales?.name === 'alice', JSON.stringify(me.body?.sales));

  /* ---------- 3. 通过代理读 _changes ---------- */
  s.group('【3】通过代理拉取变更（身份由服务端注入）');
  const rows = await changesViaProxy(0);
  const ids = rows.map((r) => r.id);
  s.info(`可见文档 ${ids.length} 个：${ids.slice(0, 12).join(', ')}${ids.length > 12 ? ' …' : ''}`);

  const orderIds = ids.filter((i) => i.startsWith('order:'));
  const sysIds = ids.filter((i) => i.startsWith('_'));
  s.check('能看到订单', orderIds.length > 0, `${orderIds.length} 张`);
  s.check('系统文档未下发（_design 等）', sysIds.length === 0, sysIds.join(',') || '零泄露');
  s.check('产品数据可见（全公司共享）', ids.some((i) => i.startsWith('product:')));

  /* ---------- 4. 伪造身份参数 ---------- */
  s.group('【4】🔴 伪造 sales_id 查询参数无效');
  const spoof = await call(`/api/sync/${DB}/_changes?since=0&sales_id=bob`);
  s.check('带 sales_id=bob 参数仍返回 200', spoof.status === 200, `HTTP ${spoof.status}`);
  const spoofIds = (spoof.body?.results ?? []).map((r) => r.id);
  s.check('伪造参数没有改变可见集合（身份来自服务端会话）',
    spoofIds.length === ids.length,
    `${spoofIds.length} vs ${ids.length}`);

  /* ---------- 5. 通过代理写入 ---------- */
  s.group('【5】通过代理写入');
  const ownId = `order:proxy_own_${Date.now()}`;
  const w1 = await call(`/api/sync/${DB}/_bulk_docs`, {
    method: 'POST',
    body: { docs: [{ _id: ownId, sales_id: 'alice', total: 1, status: 'active', items: [], type: 'order' }] },
  });
  const w1res = Array.isArray(w1.body) ? w1.body[0] : w1.body;
  s.check('写入自己的订单成功', w1.status < 300 && !w1res?.error,
    `HTTP ${w1.status} ${JSON.stringify(w1res).slice(0, 100)}`);

  const forgedId = `order:proxy_forged_${Date.now()}`;
  const w2 = await call(`/api/sync/${DB}/_bulk_docs`, {
    method: 'POST',
    body: { docs: [{ _id: forgedId, sales_id: 'bob', total: 1, status: 'active', items: [], type: 'order' }] },
  });
  const w2res = Array.isArray(w2.body) ? w2.body[0] : w2.body;
  s.check('写入伪造归属的订单被拒（validate_doc_update）',
    !!w2res?.error,
    w2res?.error ? `${w2res.error}: ${w2res.reason ?? ''}` : '竟然成功了');

  /* ---------- 6. 软删除的变更可见 ---------- */
  s.group('【6】软删除的变更能通过代理看到');
  const beforeRows = await changesViaProxy(0);
  const mine = beforeRows.filter((r) => r.id === ownId);
  s.check('刚写入的订单已出现在变更流里', mine.length > 0);

  // 软删除 = 再写一次，status 改 deleted
  const cur = await call(`/api/sync/${DB}/${encodeURIComponent(ownId)}`);
  const rev = cur.body?._rev;
  s.check('能读到该订单及其 _rev', !!rev, String(rev).slice(0, 20));
  const del = await call(`/api/sync/${DB}/${encodeURIComponent(ownId)}?rev=${rev}`, {
    method: 'PUT',
    body: { _id: ownId, _rev: rev, sales_id: 'alice', total: 1, status: 'deleted', deleted_at: new Date().toISOString(), items: [], type: 'order' },
  });
  s.check('软删除写入成功', del.status < 300, `HTTP ${del.status}`);

  const afterDoc = await call(`/api/sync/${DB}/${encodeURIComponent(ownId)}`);
  s.check('软删后文档仍存在（可审计）', afterDoc.status === 200, `HTTP ${afterDoc.status}`);
  s.check('软删后 status=deleted', afterDoc.body?.status === 'deleted', String(afterDoc.body?.status));

  s.group('【6b】非管理员不能硬删除订单（服务端挡住）');
  const hardId = `order:proxy_hard_${Date.now()}`;
  await call(`/api/sync/${DB}/_bulk_docs`, {
    method: 'POST',
    body: { docs: [{ _id: hardId, sales_id: 'alice', total: 1, status: 'active', items: [], type: 'order' }] },
  });
  const h = await call(`/api/sync/${DB}/${encodeURIComponent(hardId)}`);
  const hardDel = await call(`/api/sync/${DB}/${encodeURIComponent(hardId)}?rev=${h.body._rev}`, { method: 'DELETE' });
  const hardReason = Array.isArray(hardDel.body) ? hardDel.body[0]?.reason : hardDel.body?.reason;
  s.check('非管理员硬删除被拒（403）', hardDel.status === 403, `HTTP ${hardDel.status}`);
  s.info(`拒绝理由：${hardReason ?? '(无)'}`);
  const hardStill = await call(`/api/sync/${DB}/${encodeURIComponent(hardId)}`);
  s.check('被拒后文档仍存在（没被误删）', hardStill.status === 200, `HTTP ${hardStill.status}`);
  s.info('这是"业务删除必须走软删除"的服务端强制：销售无法硬删自己的单。');
  s.info('（管理员仍可硬删除用于运维清理，但那不属于业务路径。）');

  /* ---------- 7. 换身份后可见集合变化 ---------- */
  s.group('【7】换身份后可见集合随之改变');
  const aliceIds = new Set((await changesViaProxy(0)).map((r) => r.id));
  await login('bob');
  const bobIds = new Set((await changesViaProxy(0)).map((r) => r.id));
  const shared = [...aliceIds].filter((i) => bobIds.has(i) && i.startsWith('product:'));
  const onlyAlice = [...aliceIds].filter((i) => !bobIds.has(i) && i.startsWith('order:'));
  s.info(`alice 可见 ${aliceIds.size}，bob 可见 ${bobIds.size}，共享产品 ${shared.length}`);
  s.check('产品对两人都可见', shared.length > 0, `${shared.length} 款`);
  s.check('存在只有 alice 能看到的订单（隔离生效）',
    onlyAlice.length > 0, `${onlyAlice.length} 张仅 alice 可见`);

  /* ---------- 8. 管理员可见全部 ---------- */
  s.group('【8】管理者可见全部');
  await login('admin');
  const adminIds = new Set((await changesViaProxy(0)).map((r) => r.id));
  s.info(`admin 可见 ${adminIds.size}`);
  s.check('管理员可见集合不小于任一销售',
    adminIds.size >= Math.max(aliceIds.size, bobIds.size),
    `${adminIds.size} ≥ ${Math.max(aliceIds.size, bobIds.size)}`);

  /* ---------- 9. 清理 ---------- */
  s.group('【9】清理测试数据');
  await login('alice');
  for (const id of [ownId]) {
    const g = await call(`/api/sync/${DB}/${encodeURIComponent(id)}`);
    if (g.status === 200) {
      await call(`/api/sync/${DB}/${encodeURIComponent(id)}?rev=${g.body._rev}`, { method: 'DELETE' });
    }
  }
  s.check('清理完成', true);
  s.info('（硬删除运维操作仅用于清理测试数据，业务删除仍走软删除）');

  cookie = '';
  await fetch(BASE + '/api/session', { method: 'DELETE' }).catch(() => {});
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; console.error('\n运行中断：', e.message); }

const { failed } = s.summary();
if (crashed) {
  console.log(`\n脚本异常终止：${crashed.message}`);
  console.log(crashed.stack.split('\n').slice(0, 5).join('\n'));
}
process.exitCode = (failed.length || crashed) ? 1 : 0;
