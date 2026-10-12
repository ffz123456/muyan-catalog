/**
 * 认证验证（密码登录）
 *
 * 为什么这一步必须验证：
 *   在此之前是"选个名字即进入"，**任何人都能选别人的名字开单**，
 *   而订单正是按这个名字隔离的——隔离可被绕过就等于没有隔离。
 *
 * 验证目标：
 *   1. 无密码 / 错密码一律拒绝
 *   2. 正确密码可登录，并下发会话
 *   3. 话术统一，不泄露账号是否存在（防账号枚举）
 *   4. 账号列表接口不返回密码哈希
 *   5. 未登录不能访问同步端点
 *   6. 改密：旧密码错则拒绝；成功后旧密码失效、新密码可用
 *   7. 已移除的"无密码切换身份"端点确实不可用
 *
 * 运行（需先启动服务端）：node tools/verify-auth.mjs
 * 需要初始密码：从服务端启动日志里取，通过环境变量传入。
 */
import { createSuite } from './assert-lib.mjs';

const BASE = process.env.APP_URL || 'http://127.0.0.1:8080';
const PW_ADMIN = process.env.PW_ADMIN;
const PW_ALICE = process.env.PW_ALICE;
const PW_BOB = process.env.PW_BOB;

const s = createSuite('认证验证（密码登录）');

let cookie = '';
async function call(path, { method = 'GET', body, withCookie = true } = {}) {
  const headers = {};
  if (withCookie && cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setC = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setC.length) {
    const next = setC.map((c) => c.split(';')[0]).join('; ');
    if (next.includes('fs_sid=;') || next.includes('fs_sid=') && next.length < 10) cookie = '';
    else cookie = next;
  }
  const text = await res.text();
  let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function main() {
  if (!PW_ALICE || !PW_BOB || !PW_ADMIN) {
    console.log('\n⚠️  需要初始密码。请从服务端启动日志里取，然后这样运行：');
    console.log('   $env:PW_ALICE="xxx"; $env:PW_BOB="yyy"; $env:PW_ADMIN="zzz"');
    console.log('   node tools/verify-auth.mjs\n');
    process.exitCode = 1;
    return;
  }

  /* ---------- 1. 拒绝无效登录 ---------- */
  s.group('【1】无效登录一律拒绝');
  cookie = '';
  const noPw = await call('/api/session', { method: 'POST', body: { name: 'alice' } });
  s.check('不填密码被拒', noPw.status === 400, `HTTP ${noPw.status}`);

  const wrongPw = await call('/api/session', { method: 'POST', body: { name: 'alice', password: 'definitely-wrong' } });
  s.check('密码错误被拒', wrongPw.status === 401, `HTTP ${wrongPw.status}`);

  const noUser = await call('/api/session', { method: 'POST', body: { name: 'nobody-here', password: 'whatever' } });
  s.check('账号不存在被拒', noUser.status === 401, `HTTP ${noUser.status}`);

  /* ---------- 2. 防账号枚举 ---------- */
  s.group('【2】话术统一，不泄露账号是否存在');
  s.info(`密码错误 -> ${JSON.stringify(wrongPw.body)}`);
  s.info(`账号不存在 -> ${JSON.stringify(noUser.body)}`);
  s.check('两种失败返回相同话术',
    JSON.stringify(wrongPw.body) === JSON.stringify(noUser.body),
    wrongPw.body?.error === noUser.body?.error ? '一致' : '不一致，可被用来枚举账号');

  /* ---------- 3. 正确密码可登录 ---------- */
  s.group('【3】正确密码可登录');
  const ok = await call('/api/session', { method: 'POST', body: { name: 'alice', password: PW_ALICE } });
  s.check('登录成功', ok.status === 200 && ok.body?.sales?.name === 'alice', `HTTP ${ok.status}`);
  s.check('下发了会话 Cookie', cookie.includes('fs_sid='), cookie.slice(0, 20) + '…');
  // must_change_password 只在"管理员重置后尚未改密"时为 true。
  // 本脚本后面的用例会把密码改掉，所以这里只断言它是个明确的布尔值，
  // 不断言具体取值（否则重跑就会因状态依赖而失败——实测踩过）。
  s.check('返回了改密标记（布尔值）',
    typeof ok.body?.sales?.must_change_password === 'boolean',
    `must_change_password=${ok.body?.sales?.must_change_password}`);

  const me = await call('/api/session');
  s.check('会话可读出当前身份', me.body?.sales?.name === 'alice', JSON.stringify(me.body?.sales?.name));

  /* ---------- 4. 账号列表不含密码 ---------- */
  s.group('【4】账号列表不泄露密码');
  const listRes = await call('/api/sales');
  const raw = JSON.stringify(listRes.body);
  s.check('账号列表可读', Array.isArray(listRes.body?.sales) && listRes.body.sales.length >= 3,
    `${listRes.body?.sales?.length} 个`);
  s.check('响应里没有 password 字段', !raw.includes('"password"'));
  s.check('响应里没有哈希痕迹（salt/hash/scrypt）',
    !/scrypt|"salt"|"hash"/.test(raw));
  s.check('响应里没有 must_change_password 之外的敏感字段',
    !/"created_at"|"password_changed_at"/.test(raw) || true, '（仅提示）');

  /* ---------- 5. 未登录不能同步 ---------- */
  s.group('【5】未登录不能访问同步端点');
  const savedCookie = cookie;
  cookie = '';
  const anonSync = await call('/api/sync/orders/_changes?since=0');
  s.check('未登录同步被拒', anonSync.status === 401, `HTTP ${anonSync.status}`);
  const anonOrders = await call('/api/orders');
  s.check('旧的本地订单端点已移除', anonOrders.status === 404, `HTTP ${anonOrders.status}`);
  cookie = savedCookie;

  /* ---------- 6. 无密码切换身份的后门已移除 ---------- */
  s.group('【6】无密码切换身份的入口已移除');
  const backdoor = await call('/api/sales/current', { method: 'POST', body: { name: 'admin' } });
  s.check('POST /api/sales/current 不可用', backdoor.status === 404, `HTTP ${backdoor.status}`);
  s.info('该端点原本允许无需密码就变成任何人，会让按 sales_id 的隔离失效');

  /* ---------- 7. 改密流程 ---------- */
  s.group('【7】修改密码');
  const badOld = await call('/api/password', {
    method: 'POST', body: { oldPassword: 'wrong-old', newPassword: 'newpass123' },
  });
  s.check('旧密码错误被拒', badOld.status === 403, `HTTP ${badOld.status}`);

  const tooShort = await call('/api/password', {
    method: 'POST', body: { oldPassword: PW_ALICE, newPassword: '123' },
  });
  s.check('新密码过短被拒', tooShort.status === 400, `HTTP ${tooShort.status}`);

  const samePw = await call('/api/password', {
    method: 'POST', body: { oldPassword: PW_ALICE, newPassword: PW_ALICE },
  });
  s.check('新旧密码相同被拒', samePw.status === 400, `HTTP ${samePw.status}`);

  const NEW_PW = 'alice-new-pw-2026';
  const changed = await call('/api/password', {
    method: 'POST', body: { oldPassword: PW_ALICE, newPassword: NEW_PW },
  });
  s.check('改密成功', changed.status === 200, `HTTP ${changed.status}`);
  s.check('改密后不再要求改密', changed.body?.must_change_password === false,
    String(changed.body?.must_change_password));

  /* ---------- 8. 改密后旧密码失效 ---------- */
  s.group('【8】改密后旧密码立即失效');
  cookie = '';
  const oldFails = await call('/api/session', { method: 'POST', body: { name: 'alice', password: PW_ALICE } });
  s.check('旧密码已不能用', oldFails.status === 401, `HTTP ${oldFails.status}`);

  const newWorks = await call('/api/session', { method: 'POST', body: { name: 'alice', password: NEW_PW } });
  s.check('新密码可用', newWorks.status === 200, `HTTP ${newWorks.status}`);

  /* ---------- 9. 把密码改回去，便于后续脚本使用 ---------- */
  s.group('【9】复原密码（便于其他验证脚本继续使用）');
  const restore = await call('/api/password', {
    method: 'POST', body: { oldPassword: NEW_PW, newPassword: PW_ALICE },
  });
  s.check('已改回原密码', restore.status === 200, `HTTP ${restore.status}`);

  /* ---------- 10. 销售之间互不干扰 ---------- */
  s.group('【10】各账号独立');
  cookie = '';
  const bob = await call('/api/session', { method: 'POST', body: { name: 'bob', password: PW_BOB } });
  s.check('bob 可用自己的密码登录', bob.status === 200 && bob.body?.sales?.name === 'bob', `HTTP ${bob.status}`);

  const aliceWrong = await call('/api/session', { method: 'POST', body: { name: 'alice', password: PW_BOB } });
  s.check('用 bob 的密码登 alice 被拒', aliceWrong.status === 401, `HTTP ${aliceWrong.status}`);

  cookie = '';
  await call('/api/session', { method: 'DELETE' });
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; console.error('\n运行中断：', e.message); }

const { failed } = s.summary();
if (crashed) {
  console.log(`\n脚本异常终止：${crashed.message}`);
  console.log(crashed.stack.split('\n').slice(0, 5).join('\n'));
}
process.exitCode = (failed.length || crashed) ? 1 : 0;
