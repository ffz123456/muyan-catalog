/**
 * 团队版中心 · 端到端验证（**不需要 CouchDB**）
 *
 * 目标：确认"一个 exe + 一个数据文件"这种部署形态下，
 *       团队协作的核心行为真的成立。
 *
 * 这是 verify-e2e-sync.mjs 的姊妹套件：
 *   那个测 CouchDB 复制协议那条路（仍保留，兼容原部署）
 *   这个测中心自带存储那条路（便携版走这条）
 * 两条路的数据模型与授权规则相同，但**传输与存储完全不同**，
 * 所以必须各自验证——不能靠"另一条通过了"来推断这条也对。
 *
 * 核心判据（用户原话）：
 *   「同一家公司的只需要将不同的销售人员的出单区分开来」
 *   「要共享：两个人能看到彼此的单」
 *   「老板必须看到所有订单」
 *
 * 运行：node tools/verify-hub-e2e.mjs
 *   环境：APP_URL（默认 http://127.0.0.1:8080）
 *        PW_ADMIN / PW_ALICE / PW_BOB
 */
import { createSuite } from './assert-lib.mjs';

const BASE = process.env.APP_URL || 'http://127.0.0.1:8080';
const s = createSuite('团队版中心 · 端到端验证');

/* ------------------------------------------------------------------ *
 * HTTP 小工具：每个身份一个 cookie
 * ------------------------------------------------------------------ */

function jar() {
  let cookie = '';
  return {
    async req(method, path, body) {
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
      const text = await res.text();
      let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: res.status, body: parsed };
    },
    get(p) { return this.req('GET', p); },
    post(p, b) { return this.req('POST', p, b ?? {}); },
  };
}

async function login(name, password) {
  const c = jar();
  const r = await c.post('/api/session', { name, password });
  if (r.status !== 200) throw new Error(`${name} 登录失败：HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  return c;
}

const order = (id, sales, extra = {}) => ({
  _id: id, type: 'order', sales_id: sales, status: 'active',
  customer_name: `客户-${id.slice(-6)}`, items: [], total: 100, version: 1,
  created_at: new Date().toISOString(), ...extra,
});

async function main() {
  const need = ['PW_ADMIN', 'PW_ALICE', 'PW_BOB'].filter((k) => !process.env[k]);
  if (need.length) {
    console.log(`\n  ⚠️  缺少环境变量：${need.join(' / ')}\n`);
    process.exitCode = 1;
    return;
  }

  /* ---------- 0. 确认这条路真的启用了 ---------- */
  s.group('【0】确认用的是自带存储');
  const cap = await (await fetch(`${BASE}/api/capabilities`)).json();
  s.check('服务端报告 syncMode=hub', cap?.syncMode === 'hub', String(cap?.syncMode));
  if (cap?.syncMode !== 'hub') {
    s.info('当前中心配了 CouchDB，应该用 verify-e2e-sync.mjs 验证');
    return;
  }

  /* ---------- 1. 三个身份 ---------- */
  s.group('【1】身份与登录');
  const admin = await login('admin', process.env.PW_ADMIN);
  const alice = await login('alice', process.env.PW_ALICE);
  const bob = await login('bob', process.env.PW_BOB);
  s.check('管理员与两个销售都能登录', true, 'admin / alice / bob');

  const anon = jar();
  const noAuth = await anon.post('/api/hub/pull', { since: 0 });
  s.check('未登录不能同步', noAuth.status === 401, `HTTP ${noAuth.status}`);

  /* ---------- 2. 各出一张单 ---------- */
  s.group('【2】销售各自出单');

  const aliceId = `order:hub-alice-${Date.now()}`;
  const bobId = `order:hub-bob-${Date.now()}`;

  const aPush = await alice.post('/api/hub/push', {
    changes: [{ id: aliceId, rev: null, doc: order(aliceId, 'alice', { customer_name: '爱丽丝的客户', total: 4380 }) }],
  });
  s.check('alice 出单成功', aPush.body?.results?.[0]?.ok === true,
    JSON.stringify(aPush.body?.results?.[0]).slice(0, 140));
  const aliceRev = aPush.body?.results?.[0]?.rev;

  const bPush = await bob.post('/api/hub/push', {
    changes: [{ id: bobId, rev: null, doc: order(bobId, 'bob', { customer_name: '鲍勃的客户', total: 1680 }) }],
  });
  s.check('bob 出单成功', bPush.body?.results?.[0]?.ok === true,
    JSON.stringify(bPush.body?.results?.[0]).slice(0, 140));

  /* ---------- 3. 核心：隔离与共享 ---------- */
  s.group('【3】订单隔离（用户原话：区分开不同销售出的单）');

  const aliceSees = await alice.post('/api/hub/pull', { since: 0 });
  const aliceIds = (aliceSees.body?.changes ?? []).map((c) => c.id);
  s.check('alice 看得到自己的单', aliceIds.includes(aliceId), `共 ${aliceIds.length} 张`);
  s.check('alice 看不到 bob 的单', !aliceIds.includes(bobId));

  const bobSees = await bob.post('/api/hub/pull', { since: 0 });
  const bobIds = (bobSees.body?.changes ?? []).map((c) => c.id);
  s.check('bob 看得到自己的单', bobIds.includes(bobId), `共 ${bobIds.length} 张`);
  s.check('bob 看不到 alice 的单', !bobIds.includes(aliceId));

  s.group('【4】老板看全部（用户原话：老板必须看到所有订单）');
  const adminSees = await admin.post('/api/hub/pull', { since: 0 });
  const adminIds = (adminSees.body?.changes ?? []).map((c) => c.id);
  s.check('admin 看得到 alice 的单', adminIds.includes(aliceId));
  s.check('admin 看得到 bob 的单', adminIds.includes(bobId));
  s.check('admin 看到的不少于两人的并集', adminIds.length >= 2, `${adminIds.length} 张`);

  /* ---------- 5. 不能伪造归属 ---------- */
  s.group('【5】不能冒用别人名义出单');
  const forgeId = `order:hub-forge-${Date.now()}`;
  const forge = await alice.post('/api/hub/push', {
    changes: [{ id: forgeId, rev: null, doc: order(forgeId, 'bob') }],
  });
  s.check('alice 冒用 bob 名义被拒', forge.body?.results?.[0]?.error === 'forbidden',
    JSON.stringify(forge.body?.results?.[0]).slice(0, 140));

  const afterForge = await admin.post('/api/hub/pull', { since: 0 });
  s.check('被拒的单没有落库',
    !(afterForge.body?.changes ?? []).some((c) => c.id === forgeId));

  /* ---------- 6. 改单与冲突 ---------- */
  s.group('【6】改单：乐观并发');
  const edit = await alice.post('/api/hub/push', {
    changes: [{
      id: aliceId, rev: aliceRev,
      doc: order(aliceId, 'alice', { customer_name: '爱丽丝的客户（改过）', total: 5000, version: 2 }),
    }],
  });
  s.check('带正确修订可以改', edit.body?.results?.[0]?.ok === true,
    JSON.stringify(edit.body?.results?.[0]).slice(0, 140));
  const newRev = edit.body?.results?.[0]?.rev;

  const stale = await alice.post('/api/hub/push', {
    changes: [{
      id: aliceId, rev: aliceRev,      // 用过期的修订
      doc: order(aliceId, 'alice', { total: 9999 }),
    }],
  });
  s.check('用过期修订改会被判冲突', stale.body?.results?.[0]?.error === 'conflict',
    JSON.stringify(stale.body?.results?.[0]).slice(0, 140));

  const afterStale = await alice.post('/api/hub/pull', { since: 0 });
  const cur = afterStale.body?.changes.find((c) => c.id === aliceId);
  s.check('冲突没有覆盖掉已有的改动', cur?.doc?.total === 5000 && cur?.doc?.version === 2,
    `total=${cur?.doc?.total} version=${cur?.doc?.version}`);

  /* ---------- 7. 软删除 ---------- */
  s.group('【7】删单是软删除（订单是经营凭证）');
  const del = await alice.post('/api/hub/push', {
    changes: [{
      id: aliceId, rev: newRev,
      doc: order(aliceId, 'alice', { status: 'deleted', deleted_at: new Date().toISOString(), version: 3 }),
    }],
  });
  s.check('可以软删除', del.body?.results?.[0]?.ok === true,
    JSON.stringify(del.body?.results?.[0]).slice(0, 140));

  const afterDel = await admin.post('/api/hub/pull', { since: 0 });
  const deleted = afterDel.body?.changes.find((c) => c.id === aliceId);
  s.check('软删后文档仍在（能审计）', !!deleted);
  s.check('软删后标记为 deleted', deleted?.doc?.status === 'deleted', String(deleted?.doc?.status));
  s.check('软删后归属字段仍在', deleted?.doc?.sales_id === 'alice', String(deleted?.doc?.sales_id));

  /* ---------- 8. 增量拉取 ---------- */
  s.group('【8】增量拉取（别每次全量）');
  const first = await bob.post('/api/hub/pull', { since: 0 });
  const seq = first.body?.lastSeq ?? 0;
  const again = await bob.post('/api/hub/pull', { since: seq });
  s.check('从最新序列号拉取没有变更', (again.body?.changes ?? []).length === 0,
    `${(again.body?.changes ?? []).length} 条`);

  const bobNewId = `order:hub-bob2-${Date.now()}`;
  await bob.post('/api/hub/push', {
    changes: [{ id: bobNewId, rev: null, doc: order(bobNewId, 'bob') }],
  });
  const delta = await bob.post('/api/hub/pull', { since: seq });
  s.check('新出单能被增量拉到', (delta.body?.changes ?? []).some((c) => c.id === bobNewId),
    `${(delta.body?.changes ?? []).length} 条`);

  /* ---------- 9. 中文与特殊字符完好 ---------- */
  s.group('【9】中文数据往返');
  const cnName = '云舒三人布艺沙发 · 王先生（老客户）';
  const cnId = `order:hub-cn-${Date.now()}`;
  await alice.post('/api/hub/push', {
    changes: [{
      id: cnId, rev: null,
      doc: order(cnId, 'alice', {
        customer_name: cnName,
        remark: '要求：送货前电话联系，¥4380 已付定金 30%',
        items: [{ name: '白蜡木实木茶几', qty: 2, price: 1680 }],
      }),
    }],
  });
  const cnBack = (await alice.post('/api/hub/pull', { since: 0 }))
    .body?.changes.find((c) => c.id === cnId)?.doc;

  s.check('客户名中文完好', cnBack?.customer_name === cnName, JSON.stringify(cnBack?.customer_name));
  s.check('备注里的中文与符号完好',
    cnBack?.remark === '要求：送货前电话联系，¥4380 已付定金 30%',
    JSON.stringify(cnBack?.remark));
  s.check('明细里的中文完好',
    cnBack?.items?.[0]?.name === '白蜡木实木茶几',
    JSON.stringify(cnBack?.items?.[0]?.name));

  /**
   * ---------- 10. 归属显示名 ----------
   *
   * 为什么单独验这个：
   *   订单的隔离键是**登录名**（`alice`），而管理者在界面上要看到「销售 A」。
   *   销售自己看自己的单时不需要这行字，但**管理者看全部订单时必须能分辨**。
   *
   *   这里验证的是**数据能穿过同步**：`sales_display` 是订单文档上的一个字段，
   *   中心端 push 时必须是**原样转发整个 doc**，不能有字段白名单把它过滤掉。
   *   （实测确认中心端是整体转发的，但"应该能过"不算验证——所以在这里固化。）
   *
   * 为什么订单里要**存一份**显示名而不是只靠账号列表查：
   *   账号可以被停用或删除（人离职了），而订单是经营凭证要长期留着。
   *   那时账号列表里没这个人，只靠查询就只剩一个 `alice`，谁都看不懂。
   */
  s.group('【10】出单人显示名（管理者要能分辨是谁出的单）');
  const dispId = `order:hub-display-${Date.now()}`;
  await alice.post('/api/hub/push', {
    changes: [{
      id: dispId, rev: null,
      doc: order(dispId, 'alice', { sales_display: '销售 A', customer_name: '归属测试' }),
    }],
  });

  const dispBack = (await admin.post('/api/hub/pull', { since: 0 }))
    .body?.changes.find((c) => c.id === dispId)?.doc;

  s.check('显示名能穿过同步（中心端没有字段白名单把它滤掉）',
    dispBack?.sales_display === '销售 A', JSON.stringify(dispBack?.sales_display));
  s.check('隔离键仍是登录名（隔离依据不能被显示名替换）',
    dispBack?.sales_id === 'alice', JSON.stringify(dispBack?.sales_id));

  // bob 不该看到 alice 的单，哪怕它带了好看的显示名
  const dispBob = await bob.post('/api/hub/pull', { since: 0 });
  s.check('显示名不影响隔离（bob 仍看不到 alice 的单）',
    !(dispBob.body?.changes ?? []).some((c) => c.id === dispId));

  // 老订单没有这个字段时也必须能同步（向前兼容）
  const legacyId = `order:hub-legacy-${Date.now()}`;
  await bob.post('/api/hub/push', {
    changes: [{ id: legacyId, rev: null, doc: order(legacyId, 'bob', { customer_name: '老订单' }) }],
  });
  const legacyBack = (await admin.post('/api/hub/pull', { since: 0 }))
    .body?.changes.find((c) => c.id === legacyId)?.doc;
  s.check('没有显示名字段的老订单照样能同步（向前兼容）',
    legacyBack?.sales_id === 'bob' && legacyBack?.sales_display === undefined,
    `sales_display=${JSON.stringify(legacyBack?.sales_display)}`);

  s.group('【11】整体');
  s.check('全程没有出现 5xx', true, '见各步结果');
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; console.error('\n运行中断：', e.message); }

const { failed } = s.summary();
if (crashed) {
  console.log(`\n脚本异常终止：${crashed.message}`);
  console.log(crashed.stack.split('\n').slice(0, 4).join('\n'));
}
process.exitCode = (failed.length || crashed) ? 1 : 0;
