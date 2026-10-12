/**
 * 第 1 步真实 CouchDB 复验
 *
 * 覆盖范围（含 pouchdb-server 无法验证的认证相关部分）：
 *   1. 认证身份（req.userCtx.name）驱动的隔离
 *   2. 🔴 客户端伪造身份（查询参数）
 *   3. 🔴 跨销售伪造订单归属（validate_doc_update）
 *   4. 🔴 删除同步（软删除方案）
 *   5. 双向同步、系统文档不下发、冲突拒绝、admin 全可见
 *
 * 运行：node --env-file=.env tools/verify-real-couchdb.mjs
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { createSuite } from './assert-lib.mjs';
import { adminClient, bootstrap, config, DB, DDOC_ID, FILTER_NAME } from '../server/couch.mjs';

/**
 * 加载 pouchdb（Node 构建）。
 *
 * 本机开发时它在 ../sync/node_modules；容器部署时它装在 app 自己的 node_modules。
 * 逐个尝试，避免硬编码某一种目录布局（实测：容器里按开发路径找会报
 * "requireStack: /srv/sync/package.json" 而失败）。
 */
function loadPouchDB() {
  const anchors = [
    path.join(import.meta.dirname, '..', 'package.json'),              // 容器：app/node_modules
    path.join(import.meta.dirname, '..', '..', 'sync', 'package.json'), // 本机：sync/node_modules
  ];
  const errs = [];
  for (const a of anchors) {
    try {
      return createRequire(a)('pouchdb');
    } catch (e) {
      errs.push(`  ${a}: ${e.code ?? e.message}`);
    }
  }
  throw new Error(`找不到 pouchdb。请先安装：cd app && npm install pouchdb\n${errs.join('\n')}`);
}
const PouchDB = loadPouchDB();

const REMOTE = `${config.base}/${DB}`;
const FILTER = `${DDOC_ID.split('/')[1]}/${FILTER_NAME}`;
const ALICE = { name: 'alice', pass: 'alice-pw-123' };
const BOB = { name: 'bob', pass: 'bob-pw-123' };
const ADMIN = { name: config.adminUser, pass: process.env.COUCHDB_ADMIN_PASS };

const s = createSuite('第 1 步 · 真实 CouchDB 复验');
const c = adminClient();

const locals = [];
async function freshLocal(name) {
  try { await new PouchDB(name).destroy(); } catch { /* 忽略 */ }
  locals.push(name);
  return new PouchDB(name);
}
const ids = async (db) => (await db.allDocs()).rows.map((r) => r.id).sort();
const pull = (local, user, extra = {}) => PouchDB.replicate(REMOTE, local, {
  filter: FILTER, auth: { username: user.name, password: user.pass }, ...extra,
});
const basic = (u) => 'Basic ' + Buffer.from(`${u.name}:${u.pass}`).toString('base64');

async function writeAs(user, docs) {
  const r = await fetch(`${REMOTE}/_bulk_docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basic(user) },
    body: JSON.stringify({ docs }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function main() {
  console.log(`\n目标：${config.base}   数据库：${DB}\n`);

  /* ---------- 0. 重置与初始化 ---------- */
  s.group('【0】重置并初始化');
  const del = await c.del(`/${DB}`);
  s.info(`删除旧库：HTTP ${del.status}`);
  await c.put('/_users');
  const boot = await bootstrap({ log: () => {} });
  boot.forEach((r) => s.info(r));
  s.check('初始化完成（含过滤函数与校验函数）', true);

  /* ---------- 1. 账号 ---------- */
  s.group('【1】创建销售账号');
  for (const u of [ALICE, BOB]) {
    const id = `org.couchdb.user:${u.name}`;
    const existing = await c.get(`/_users/${encodeURIComponent(id)}`);
    const doc = { _id: id, name: u.name, type: 'user', roles: ['app'], password: u.pass };
    if (existing.status === 200) doc._rev = existing.body._rev;
    const r = await c.put(`/_users/${encodeURIComponent(id)}`, doc);
    s.check(`账号 ${u.name} 就绪`, r.status < 300, `HTTP ${r.status}`);
  }

  /* ---------- 2. 各自写单 ---------- */
  s.group('【2】以各自身份写入订单');
  const wa = await writeAs(ALICE, [
    { _id: 'order:a1', sales_id: 'alice', total: 4380, customer_name: '张先生', status: 'active', items: [] },
    { _id: 'order:a2', sales_id: 'alice', total: 1680, customer_name: '李女士', status: 'active', items: [] },
  ]);
  s.check('alice 能写入自己的订单', wa.status === 201, `HTTP ${wa.status}`);

  const wb = await writeAs(BOB, [
    { _id: 'order:b1', sales_id: 'bob', total: 3260, customer_name: '王先生', status: 'active', items: [] },
    { _id: 'order:b2', sales_id: 'bob', total: 5980, customer_name: '赵女士', status: 'active', items: [] },
  ]);
  s.check('bob 能写入自己的订单', wb.status === 201, `HTTP ${wb.status}`);

  await c.put(`/${DB}/product:p1`, { name: '云舒三人布艺沙发', category: '客厅' });

  const anon = await fetch(REMOTE);
  s.check('未认证访问被拒', anon.status === 401, `HTTP ${anon.status}`);

  /* ---------- 3. 隔离 ---------- */
  s.group('【3】隔离验证（认证身份驱动）');
  const aliceDb = await freshLocal('v_alice');
  await pull(aliceDb, ALICE);
  const aIds = await ids(aliceDb);
  s.info(`alice 本地：${aIds.join(', ')}`);
  s.check('alice 看到自己的单', aIds.includes('order:a1') && aIds.includes('order:a2'));
  s.check('alice 看不到 bob 的单', !aIds.some((i) => i === 'order:b1' || i === 'order:b2'));
  s.check('产品数据共享可见', aIds.includes('product:p1'));
  s.check('系统文档未下发', !aIds.some((i) => i.startsWith('_')));

  const bobDb = await freshLocal('v_bob');
  await pull(bobDb, BOB);
  const bIds = await ids(bobDb);
  s.info(`bob 本地：${bIds.join(', ')}`);
  s.check('bob 看不到 alice 的单', !bIds.some((i) => i === 'order:a1' || i === 'order:a2'));

  /* ---------- 4. 伪造身份（查询参数） ---------- */
  s.group('【4】🔴 身份伪造测试：改查询参数能否越权');
  const spoofDb = await freshLocal('v_spoof');
  let spoofErr = null;
  try {
    await pull(spoofDb, BOB, { query_params: { sales_id: 'alice' } });
  } catch (e) { spoofErr = e; }
  const sIds = await ids(spoofDb);
  s.info(`bob 带 sales_id=alice 参数后本地：${sIds.join(', ') || '(空)'}`);
  s.check('伪造 sales_id 参数无法看到 alice 的单',
    !sIds.some((i) => i === 'order:a1' || i === 'order:a2'),
    spoofErr ? `复制被拒：${spoofErr.message}` : '参数被忽略，过滤取认证身份');

  /* ---------- 5. 伪造订单归属 ---------- */
  s.group('【5】🔴 跨销售伪造订单：写一条声称属于别人的单');
  const forge = await writeAs(BOB, [
    { _id: 'order:b_forged', sales_id: 'alice', total: 1, customer_name: '伪造', status: 'active', items: [] },
  ]);
  const forgeErr = Array.isArray(forge.body) ? forge.body[0] : forge.body;
  s.info(`bob 写入 sales_id=alice 的结果：${JSON.stringify(forgeErr)}`);
  s.check('跨销售伪造订单被拒绝（validate_doc_update）',
    !!(forgeErr && forgeErr.error),
    forgeErr?.error ? `${forgeErr.error}: ${forgeErr.reason ?? ''}` : '竟然写入成功了！');

  // 反向确认：伪造的文档确实没有进入 alice 的库
  const forgeDb = await freshLocal('v_forge');
  await pull(forgeDb, ALICE);
  const fIds = await ids(forgeDb);
  s.check('伪造文档未下发给 alice', !fIds.includes('order:b_forged'));

  /* ---------- 6. 删除同步（软删除方案） ---------- */
  s.group('【6】🔴 删除同步：硬删除会留幽灵订单，改用软删除');
  const softId = 'order:a_soft';
  await writeAs(ALICE, [{ _id: softId, sales_id: 'alice', total: 999, customer_name: '软删', status: 'active', items: [] }]);

  const delDb = await freshLocal('v_softdelete');
  await pull(delDb, ALICE);
  const before = await ids(delDb);
  s.check('软删前客户端已拿到该单', before.includes(softId));

  // 软删除：改 status，不真删
  const cur = await c.get(`/${DB}/${softId}`);
  await c.put(`/${DB}/${softId}`, {
    ...cur.body, status: 'deleted', deleted_at: new Date().toISOString(), version: 2,
  });
  const res = await pull(delDb, ALICE);
  const local = await delDb.get(softId).catch(() => null);
  s.info(`软删后复制：docs_read=${res.docs_read} docs_written=${res.docs_written}`);
  s.info(`客户端 status=${local?.status}  sales_id=${local?.sales_id}`);
  s.check('软删除标记已同步到客户端', local?.status === 'deleted');
  s.check('软删后 sales_id 仍保留（硬删除会丢失）', local?.sales_id === 'alice');

  // 对照：硬删除确实会丢字段，故不采用
  const hardId = 'order:a_hard';
  await writeAs(ALICE, [{ _id: hardId, sales_id: 'alice', total: 111, customer_name: '硬删', status: 'active', items: [] }]);
  const hardDb = await freshLocal('v_harddelete');
  await pull(hardDb, ALICE);
  const hcur = await c.get(`/${DB}/${hardId}`);
  await c.del(`/${DB}/${hardId}?rev=${hcur.body._rev}`);
  const hres = await pull(hardDb, ALICE);
  const hafter = await ids(hardDb);
  s.info(`硬删除后复制：docs_read=${hres.docs_read} docs_written=${hres.docs_written}`);
  s.check('确证：硬删除的变更会被过滤丢弃（客户端残留）',
    hafter.includes(hardId),
    '文档内容随删除消失→过滤函数无法判断归属→变更被丢弃。故订单一律用软删除');

  /* ---------- 7. 冲突 ---------- */
  s.group('【7】同版本号冲突检测');
  await c.put(`/${DB}/orderrev:a2:2`, { order_id: 'order:a2', version: 2, sales_id: 'alice', snapshot: {} });
  const conflict = await c.put(`/${DB}/orderrev:a2:2`, { order_id: 'order:a2', version: 2, sales_id: 'alice', snapshot: {} });
  s.check('同 _id 重复写入返回 409', conflict.status === 409, `HTTP ${conflict.status}`);

  /* ---------- 8. admin ---------- */
  s.group('【8】admin 可见全部');
  const adminLocal = await freshLocal('v_admin');
  await PouchDB.replicate(REMOTE, adminLocal, {
    filter: FILTER, auth: { username: ADMIN.name, password: ADMIN.pass },
  });
  const adIds = await ids(adminLocal);
  const adOrders = adIds.filter((i) => i.startsWith('order:'));
  s.info(`admin 可见订单：${adOrders.join(', ')}`);
  s.check('admin 能看到多人订单',
    adOrders.some((i) => i.startsWith('order:b')) && adOrders.some((i) => i.startsWith('order:a')));

  /* ---------- 9. 上行同步 ---------- */
  s.group('【9】上行同步：客户端出单能否到服务端');
  const upLocal = await freshLocal('v_up');
  await upLocal.put({
    _id: 'order:a_up1', sales_id: 'alice', total: 2500,
    customer_name: '新客户', status: 'active', items: [], created_at: new Date().toISOString(),
  });
  await PouchDB.replicate(upLocal, REMOTE, { auth: { username: ALICE.name, password: ALICE.pass } });
  const upCheck = await c.get(`/${DB}/order:a_up1`);
  s.check('客户端新建订单已上行到服务端', upCheck.status === 200, `HTTP ${upCheck.status}`);

  // 反向：伪造归属上行应被拒
  await upLocal.put({
    _id: 'order:a_up_forged', sales_id: 'bob', total: 1,
    customer_name: '上行伪造', status: 'active', items: [],
  });
  const upForge = await PouchDB.replicate(upLocal, REMOTE, { auth: { username: ALICE.name, password: ALICE.pass } })
    .then(() => null).catch((e) => e);
  const upForgeCheck = await c.get(`/${DB}/order:a_up_forged`);
  s.check('客户端无法上行伪造归属的订单',
    upForgeCheck.status === 404,
    upForge ? `复制报错：${upForge.message}` : '服务端未接受该文档');
}

/* ---------------- 运行与收尾 ---------------- */
let crashed = null;
try {
  await main();
} catch (err) {
  crashed = err;
  console.error('\n运行中断：', err.message);
} finally {
  for (const n of locals) { try { await new PouchDB(n).destroy(); } catch { /* 忽略 */ } }
}

const { failed } = s.summary();
if (crashed) {
  console.log(`\n脚本异常终止：${crashed.message}`);
  console.log(crashed.stack.split('\n').slice(0, 5).join('\n'));
}
process.exitCode = (failed.length || crashed) ? 1 : 0;
