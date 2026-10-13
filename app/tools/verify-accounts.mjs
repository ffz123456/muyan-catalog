/**
 * 账号管理验证（管理员建账号 / 重置密码 / 停用 / 删除 / 个人信息保护）
 *
 * 为什么必须有这一组：本项目是**开源给任意经销商自己部署**的，
 * 部署的人不会去改代码或数据文件。如果只能在界面上删数据文件才能加人，
 * 那这套东西对他们就是不可用的。
 *
 * 验证目标：
 *   1. 只有管理员能建账号 / 改账号 / 重置密码 / 删账号
 *   2. 登录名规则与查重
 *   3. 新建账号首次登录**强制改密**
 *   4. 重置密码后旧密码失效、临时密码可用、且再次强制改密
 *   5. 停用的账号不能登录
 *   6. 未登录看不到邮箱手机号（个人信息保护）
 *   7. 安全约束：不能停用/降级/删除最后一个管理员
 *
 * 运行（需先启动服务端）：PW_ADMIN=xxx node tools/verify-accounts.mjs
 */
import { createSuite, detectSyncMode } from './assert-lib.mjs';

const BASE = process.env.APP_URL || 'http://127.0.0.1:8080';
/**
 * 这个中心用哪套同步（couch / hub）。
 * 决定第 4 组怎么读「新账号能看到哪些文档」——两套的返回形状不同。
 */
const syncMode = await detectSyncMode(BASE);
const PW_ADMIN = process.env.PW_ADMIN;

const s = createSuite('账号管理验证');

let cookie = '';
async function call(path, { method = 'GET', body, as = null } = {}) {
  const headers = {};
  if (as) headers.Cookie = as;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setC = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const text = await res.text();
  let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, cookie: setC.map((c) => c.split(';')[0]).join('; ') };
}

/** 走免密入口或密码登录，自动选可用的一条。 */
async function login(name, password) {
  const dev = await call('/api/session', { method: 'POST', body: { name, devNoPassword: true } });
  if (dev.status === 200) return dev;
  if (!password) return dev;
  return call('/api/session', { method: 'POST', body: { name, password } });
}

const stamp = Date.now().toString().slice(-6);
const NEWNAME = `t${stamp}`;

let adminCookie = '';
let createdPassword = '';

async function main() {
  if (!PW_ADMIN) {
    console.log('\n⚠️  需要管理员密码。从服务端启动日志取，然后：');
    console.log('   $env:PW_ADMIN="xxx"; node tools/verify-accounts.mjs\n');
    process.exitCode = 1;
    return;
  }

  /* ---------- 0. 管理员登录 ---------- */
  s.group('【0】管理员登录');
  const adm = await login('admin', PW_ADMIN);
  s.check('管理员登录成功', adm.status === 200, `${adm.status}`);
  adminCookie = adm.cookie;
  cookie = adminCookie;

  /* ---------- 1. 未登录看不到个人信息 ---------- */
  s.group('【1】未登录只能看到登录所需的最小信息');
  const anon = await call('/api/sales');
  const anonRaw = JSON.stringify(anon.body);
  s.check('未登录能拿到账号列表（登录页需要）', Array.isArray(anon.body?.sales), `${anon.body?.sales?.length} 个`);
  s.check('未登录拿不到邮箱', !anonRaw.includes('"email"'), anonRaw.includes('@') ? '出现了邮箱！' : '无邮箱');
  /* 账号上刻意没有手机号字段（找回密码走管理员重置，不做短信验证码） */
  s.check('账号上没有手机号字段', !anonRaw.includes('"phone"'));
  /*
   * 注意判据是**字段名 `"admin":`**，不能只找 `"admin"` 子串：
   * 管理员的登录名本身就叫 admin，每次都出现在列表里，会误判。
   * （第一版就是这么写错的。）
   */
  s.check('未登录拿不到"是否管理员"标记', !anonRaw.includes('"admin":'));
  s.check('未登录拿不到"是否停用"标记', !anonRaw.includes('"active":'));
  s.check('未登录拿不到创建时间等内部字段', !anonRaw.includes('"created_at":'));
  s.check('返回里明确标记这是登录用视图', anon.body?.scope === 'login', String(anon.body?.scope));

  const admList = await call('/api/sales', { as: adminCookie });
  s.check('管理员视图被标记为完整视图', admList.body?.scope === 'admin', String(admList.body?.scope));
  s.check('管理员能看到"是否停用"等管理字段',
    (admList.body?.sales ?? []).every((x) => 'active' in x), `${admList.body?.sales?.length} 个`);

  /**
   * 验证"管理员确实能看到邮箱/手机号"。
   *
   * 不能简单断言 `'email' in x` —— 内置账号从没填过邮箱，那字段是 null，
   * 甚至可能不存在。第一版就是这么写错的：断言失败但功能没问题。
   * 正确做法是**建一个带邮箱的账号，再确认管理员能读到它**。
   */
  const probeName = `probe${stamp}`;
  const probe = await call('/api/sales', {
    method: 'POST', as: adminCookie,
    body: { name: probeName, display: '资料探针', email: 'probe@example.com' },
  });
  s.check('建带邮箱的探针账号成功', probe.status === 200, `HTTP ${probe.status}`);

  const admList2 = await call('/api/sales', { as: adminCookie });
  const probeRow = (admList2.body?.sales ?? []).find((x) => x.name === probeName);
  s.check('管理员能看到该账号的邮箱', probeRow?.email === 'probe@example.com', String(probeRow?.email));

  const anonList = await call('/api/sales');
  const anonRow = (anonList.body?.sales ?? []).find((x) => x.name === probeName);
  s.check('未登录看不到该账号的邮箱', anonRow && !('email' in anonRow), JSON.stringify(anonRow));

  await call(`/api/sales/${probeName}`, { method: 'DELETE', as: adminCookie });

  /* ---------- 2. 非管理员不能管理账号 ---------- */
  s.group('【2】非管理员不能管理账号');
  const aliceLogin = await login('alice', process.env.PW_ALICE);
  if (aliceLogin.status === 200) {
    const aliceCookie = aliceLogin.cookie;
    const tryCreate = await call('/api/sales', {
      method: 'POST', as: aliceCookie,
      body: { name: `hack${stamp}`, display: '越权' },
    });
    s.check('销售建账号被拒', tryCreate.status === 403, `HTTP ${tryCreate.status}`);

    const tryReset = await call('/api/sales/admin/reset-password', { method: 'POST', as: aliceCookie });
    s.check('销售重置他人密码被拒', tryReset.status === 403, `HTTP ${tryReset.status}`);

    const tryDelete = await call('/api/sales/admin', { method: 'DELETE', as: aliceCookie });
    s.check('销售删账号被拒', tryDelete.status === 403, `HTTP ${tryDelete.status}`);
  } else {
    s.info(`跳过：alice 登录不可用（HTTP ${aliceLogin.status}）`);
  }

  /* ---------- 3. 建账号 ---------- */
  s.group('【3】管理员新建账号');
  const badName = await call('/api/sales', {
    method: 'POST', as: adminCookie, body: { name: '张三', display: '中文名' },
  });
  s.check('中文登录名被拒（会带来编码问题）', badName.status === 400, `HTTP ${badName.status}`);

  const badEmail = await call('/api/sales', {
    method: 'POST', as: adminCookie, body: { name: NEWNAME, display: 'x', email: '不是邮箱' },
  });
  s.check('错误邮箱格式被拒', badEmail.status === 400, `HTTP ${badEmail.status}`);

  const made = await call('/api/sales', {
    method: 'POST', as: adminCookie,
    body: { name: NEWNAME, display: '验证账号', email: 'v@example.com' },
  });
  s.check('建账号成功', made.status === 200 && made.body?.account?.name === NEWNAME, `HTTP ${made.status}`);
  s.check('返回一次性初始密码', typeof made.body?.initialPassword === 'string'
    && made.body.initialPassword.length >= 8, `${made.body?.initialPassword?.length} 位`);
  s.check('新账号标记为需改密', made.body?.account?.must_change_password === true);
  s.check('新账号默认不是管理员', made.body?.account?.admin === false);
  s.check('新账号默认启用', made.body?.account?.active === true);
  s.check('邮箱已保存', made.body?.account?.email === 'v@example.com');
  s.check('账号上没有手机号字段（刻意不做）', !('phone' in (made.body?.account ?? {})),
    JSON.stringify(Object.keys(made.body?.account ?? {})));
  createdPassword = made.body.initialPassword;

  const dup = await call('/api/sales', {
    method: 'POST', as: adminCookie, body: { name: NEWNAME, display: '重复' },
  });
  s.check('重复登录名被拒', dup.status === 409, `HTTP ${dup.status}`);

  /* ---------- 4. 新账号只能看到自己的单 ---------- */
  s.group('【4】新账号能登录，且归属为本人');
  const newLogin = await login(NEWNAME, createdPassword);
  s.check('新账号可登录', newLogin.status === 200, `HTTP ${newLogin.status}`);
  s.check('登录信息带出需改密标记', newLogin.body?.sales?.must_change_password === true);
  const newCookie = newLogin.cookie;

  /**
   * 新账号能访问同步端点，且看不到任何既有订单。
   *
   * 同步分两套（见主文档 §3.3）：couch 走 /api/sync/*，hub 走 /api/hub/*。
   * **只测当前启用的那套**——另一套会返回 503（这个中心没配数据库），
   * 那不是权限问题。两套的返回形状不同，所以取 id 的方式也不同。
   */
  let newDocIds;
  if (syncMode === 'hub') {
    const r = await call('/api/hub/pull', { method: 'POST', as: newCookie, body: { since: 0 } });
    s.check('新账号可访问同步端点（自带存储）', r.status === 200, `HTTP ${r.status}`);
    newDocIds = (r.body?.changes ?? []).map((c) => c.id);
  } else {
    const r = await call('/api/sync/orders/_changes?since=0', { as: newCookie });
    s.check('新账号可访问同步端点', r.status === 200, `HTTP ${r.status}`);
    newDocIds = (r.body?.results ?? []).map((x) => x.id);
  }

  /**
   * 只看**订单**类文档。
   *
   * 同步库是订单库，但里面还有共享的产品/货源文档（`product:` / `supplier:`），
   * 那些本来就该所有销售都能看到。
   * 一开始我把断言写成"一条都看不到"，结果被一个遗留的 product:p1 判失败——
   * 是断言错了，不是权限漏了。
   */
  const newOrders = newDocIds.filter((id) => id.startsWith('order:') || id.startsWith('orderrev:'));
  s.check('新账号看不到任何既有订单', newOrders.length === 0,
    `订单 ${newOrders.length} 条（其他共享文档 ${newDocIds.length - newOrders.length} 条）`);

  /* ---------- 5. 立即改密 ---------- */
  s.group('【5】新账号首次登录必须改密');
  const weak = await call('/api/password', {
    method: 'POST', as: newCookie, body: { oldPassword: createdPassword, newPassword: '123' },
  });
  s.check('新密码过短被拒', weak.status === 400, `HTTP ${weak.status}`);

  const NEWPW = `pw-${stamp}-ok`;
  const changed = await call('/api/password', {
    method: 'POST', as: newCookie, body: { oldPassword: createdPassword, newPassword: NEWPW },
  });
  s.check('改密成功', changed.status === 200, `HTTP ${changed.status}`);
  s.check('改密后不再要求改密', changed.body?.must_change_password === false);

  /* ---------- 6. 管理员重置密码 ---------- */
  s.group('【6】管理员重置密码（忘密码时的正路）');
  const reset = await call(`/api/sales/${NEWNAME}/reset-password`, { method: 'POST', as: adminCookie });
  s.check('重置成功', reset.status === 200, `HTTP ${reset.status}`);
  s.check('返回临时密码', typeof reset.body?.temporaryPassword === 'string'
    && reset.body.temporaryPassword.length >= 8, `${reset.body?.temporaryPassword?.length} 位`);
  s.check('重置后强制改密', reset.body?.account?.must_change_password === true);

  const oldPwFails = await call('/api/session', { method: 'POST', body: { name: NEWNAME, password: NEWPW } });
  s.check('旧密码立即失效', oldPwFails.status === 401, `HTTP ${oldPwFails.status}`);

  const tempWorks = await call('/api/session', {
    method: 'POST', body: { name: NEWNAME, password: reset.body.temporaryPassword },
  });
  s.check('临时密码可用', tempWorks.status === 200, `HTTP ${tempWorks.status}`);
  const tempCookie = tempWorks.cookie;

  /* ---------- 7. 停用账号 ---------- */
  s.group('【7】停用账号后不能登录');
  const disable = await call(`/api/sales/${NEWNAME}`, {
    method: 'POST', as: adminCookie, body: { active: false },
  });
  s.check('停用成功', disable.status === 200 && disable.body?.active === false, `HTTP ${disable.status}`);

  const disabledLogin = await call('/api/session', {
    method: 'POST', body: { name: NEWNAME, password: reset.body.temporaryPassword },
  });
  s.check('停用后不能登录', disabledLogin.status === 401, `HTTP ${disabledLogin.status}`);
  s.check('提示明确说明是停用', String(disabledLogin.body?.error ?? '').includes('停用'),
    String(disabledLogin.body?.error ?? ''));

  const anonAfter = await call('/api/sales');
  s.check('停用账号不出现在登录列表',
    !(anonAfter.body?.sales ?? []).some((x) => x.name === NEWNAME));

  const reEnable = await call(`/api/sales/${NEWNAME}`, {
    method: 'POST', as: adminCookie, body: { active: true },
  });
  s.check('可重新启用', reEnable.status === 200 && reEnable.body?.active === true);
  void tempCookie;

  /* ---------- 8. 最后一个管理员的保护 ---------- */
  s.group('【8】安全约束：不能弄丢最后一个管理员');
  const demoteSelf = await call('/api/sales/admin', {
    method: 'POST', as: adminCookie, body: { admin: false },
  });
  s.check('不能降级最后一个管理员', demoteSelf.status === 400, `HTTP ${demoteSelf.status}`);
  s.check('拒绝理由说明后果', String(demoteSelf.body?.error ?? '').includes('最后一个'),
    String(demoteSelf.body?.error ?? ''));

  const disableSelf = await call('/api/sales/admin', {
    method: 'POST', as: adminCookie, body: { active: false },
  });
  s.check('不能停用最后一个管理员', disableSelf.status === 400, `HTTP ${disableSelf.status}`);

  const delSelf = await call('/api/sales/admin', { method: 'DELETE', as: adminCookie });
  s.check('不能删除最后一个管理员', delSelf.status === 400, `HTTP ${delSelf.status}`);

  /* ---------- 9. 删除测试账号 ---------- */
  s.group('【9】删除账号（订单不受影响）');
  const del = await call(`/api/sales/${NEWNAME}`, { method: 'DELETE', as: adminCookie });
  s.check('删除成功', del.status === 200, `HTTP ${del.status}`);
  s.check('明确回报订单已保留', del.body?.ordersKept === true);

  const gone = await call('/api/sales', { as: adminCookie });
  s.check('账号已从列表消失', !(gone.body?.sales ?? []).some((x) => x.name === NEWNAME));

  const delLogin = await call('/api/session', {
    method: 'POST', body: { name: NEWNAME, password: reset.body.temporaryPassword },
  });
  s.check('被删账号不能登录', delLogin.status === 401, `HTTP ${delLogin.status}`);
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; console.error('\n运行中断：', e.message); }

const { failed } = s.summary();
if (crashed) {
  console.log(`\n脚本异常终止：${crashed.message}`);
  console.log(crashed.stack.split('\n').slice(0, 4).join('\n'));
}
process.exitCode = (failed.length || crashed) ? 1 : 0;
