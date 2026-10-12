/**
 * 第 1 步验证：PouchDB ↔ CouchDB 协议服务端的「订单按销售隔离」
 *
 * 验证目标（对应主文档 §5 出单隔离）：
 *   1. 双向同步能跑通（PouchDB ↔ 服务端）
 *   2. 过滤复制能生效：销售 Alice 的设备上拿不到 Bob 的订单
 *   3. 隔离是物理层面的：Alice 本地库里根本不存在 Bob 的文档
 *   4. admin 能看到全部
 *
 * 使用 pouchdb-server（CouchDB 协议子集的 Node 实现）以便在无 Docker 环境验证。
 * ⚠️ 它不能替代真实 CouchDB，仅用于验证过滤同步的机制与数据模型。
 *
 * 运行：node verify-sync.mjs
 */
import express from 'express';
import expressPouchDB from 'express-pouchdb';
import PouchDB from 'pouchdb';
import http from 'node:http';

const PORT = 5984;
const DB = 'orders';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 过滤函数：与服务端 design doc 中应写入的逻辑保持一致。
 * 写成字符串以便序列化，模拟真实 CouchDB 的 filter 参数值。
 * ------------------------------------------------------------------ */
const FILTER_SRC = `
function (doc, req) {
  var user = (req && req.userCtx && req.userCtx.name) || (req && req.query && req.query.user) || 'anonymous';
  var salesId = (req && req.query && req.query.sales_id) || user;
  // 系统文档（_design/_local 等）一律不下发到客户端
  if (doc._id.charAt(0) === '_') return false;
  var isOrder = doc._id.indexOf('order:') === 0 || doc._id.indexOf('orderrev:') === 0;
  // 非订单类文档（产品、货源）全公司共享 —— 对应主文档 §5.1
  if (!isOrder) return true;
  // 订单按 sales_id 隔离
  if (salesId === 'admin') return true;          // admin 可见全部
  return doc.sales_id === salesId;
}
`;

/* ------------------------------------------------------------------ *
 * 启动服务端
 * ------------------------------------------------------------------ */
const app = express();
app.use('/', expressPouchDB(PouchDB, { mode: 'minimumForPouchDB', inMemoryConfig: true }));
app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));

const server = http.createServer(app);
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
console.log(`服务端已启动: http://127.0.0.1:${PORT}\n`);

const remote = `http://127.0.0.1:${PORT}/${DB}`;
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
};

const clients = [];
try {
  /* ---------------- 1. 服务端种子数据 ---------------- */
  console.log('【1】服务端写入种子数据');
  const serverDb = new PouchDB(remote);
  const seed = [
    { _id: 'product:p1', name: '云舒三人布艺沙发', category: '客厅', specs: '2200×950×820mm' },
    { _id: 'product:p2', name: '白蜡木实木茶几', category: '客厅', specs: '1200×600×450mm' },
    { _id: 'order:a1', sales_id: 'alice', total: 4380, customer_name: '张先生', items: [] },
    { _id: 'order:a2', sales_id: 'alice', total: 1680, customer_name: '李女士', items: [] },
    { _id: 'order:b1', sales_id: 'bob', total: 3260, customer_name: '王先生', items: [] },
    { _id: 'order:b2', sales_id: 'bob', total: 5980, customer_name: '赵女士', items: [] },
  ];
  await serverDb.bulkDocs(seed);
  const info = await serverDb.info();
  check('服务端入库 6 条文档', info.doc_count >= 6, `doc_count=${info.doc_count}`);

  /* ---------------- 2. 上行同步：本地新建订单 → 服务端 ---------------- */
  console.log('\n【2】上行同步：本地新建订单能否同步到服务端');
  const alice = new PouchDB('spike_alice');
  clients.push(['spike_alice', alice]);
  await alice.put({
    _id: 'order:a3', sales_id: 'alice', total: 458,
    customer_name: '陈先生', items: [], created_at: new Date().toISOString(),
  });
  await alice.replicate.to(remote);
  const afterUp = await serverDb.allDocs({ startkey: 'order:', endkey: 'order:\ufff0' });
  check('本地新建的单已上行到服务端', afterUp.rows.some((r) => r.id === 'order:a3'),
    `服务端订单数=${afterUp.rows.length}`);

  /* ---------------- 3. 过滤下行：功能过滤 vs 设计文档过滤 ---------------- */
  console.log('\n【3】过滤下行：验证哪种过滤方式在本服务端有效');

  // 3a. 客户端函数过滤（PouchDB 支持，但真实 CouchDB 不支持函数）
  const fnAlice = new PouchDB('spike_alice_filter');
  clients.push(['spike_alice_filter', fnAlice]);
  const filterFn = new Function('return ' + FILTER_SRC.trim())();
  try {
    await alice.replicate.to(fnAlice); // 先让 alice 本地库有数据
  } catch { /* 忽略 */ }
  await alice.replicate.to(fnAlice);
  try {
    await alice.replicate.to(fnAlice);
  } catch { /* 忽略 */ }

  const fnAliceFromServer = new PouchDB('spike_alice_fromserver');
  clients.push(['spike_alice_fromserver', fnAliceFromServer]);
  let fnFilterWorked = false;
  try {
    await PouchDB.replicate(remote, fnAliceFromServer, {
      filter: filterFn,
      query_params: { sales_id: 'alice' },
    });
    fnFilterWorked = true;
  } catch (e) {
    console.log(`    (函数过滤失败: ${e.message})`);
  }

  // 3b. 字符串过滤（指向服务端设计文档，真实 CouchDB 的做法）
  const ddoc = new PouchDB('spike_ddoc');
  clients.push(['spike_ddoc', ddoc]);
  let ddocFilterWorked = false;
  let ddocError = '';
  try {
    await serverDb.put({
      _id: '_design/app',
      filters: { by_sales: FILTER_SRC.trim() },
    });
    const strAlice = new PouchDB('spike_alice_strfilter');
    clients.push(['spike_alice_strfilter', strAlice]);
    await PouchDB.replicate(remote, strAlice, {
      filter: 'app/by_sales',
      query_params: { sales_id: 'alice' },
    });
    ddocFilterWorked = true;
  } catch (e) {
    ddocError = e.message;
    console.log(`    (设计文档过滤失败: ${e.message})`);
  }

  const method = ddocFilterWorked ? '设计文档过滤 (app/by_sales)'
    : fnFilterWorked ? '客户端函数过滤 (实际不可用于真实 CouchDB)'
      : '均失败';

  console.log('');
  check('存在可用的过滤复制方式', ddocFilterWorked || fnFilterWorked, method);
  if (ddocFilterWorked) {
    check('设计文档过滤可用于真实 CouchDB 场景', true, 'filter=app/by_sales');
  } else {
    check('设计文档过滤可用于真实 CouchDB 场景', false, ddocError || '未实现');
  }

  /* ---------------- 4. 双向同步 ---------------- */
  console.log('\n【4】双向同步（sync）');
  const bob = new PouchDB('spike_bob');
  clients.push(['spike_bob', bob]);
  await bob.put({
    _id: 'order:b3', sales_id: 'bob', total: 888,
    customer_name: '孙女士', items: [], created_at: new Date().toISOString(),
  });
  const syncRes = await bob.sync(remote, { batch_size: 10 });
  check('sync 双向同步完成', syncRes.pull.ok !== undefined || syncRes.push.ok !== undefined,
    `push=${syncRes.push.ok ? syncRes.push.docs_written : '?'} pull=${syncRes.pull.ok ? syncRes.pull.docs_written : '?'}`);

  /* ---------------- 5. 隔离验证（核心） ---------------- */
  console.log('\n【5】隔离验证（核心）：销售设备上是否真的拿不到别人的单');
  const target = ddocFilterWorked
    ? new PouchDB('spike_iso_alice')
    : fnAliceFromServer;
  if (ddocFilterWorked) clients.push(['spike_iso_alice', target]);

  await PouchDB.replicate(remote, target, {
    filter: 'app/by_sales',
    query_params: { sales_id: 'alice' },
  });

  const localIds = (await target.allDocs()).rows.map((r) => r.id).sort();
  const localOrders = localIds.filter((i) => i.startsWith('order:'));
  const leaked = localOrders.filter((i) => i === 'order:b1' || i === 'order:b2' || i === 'order:b3');

  console.log(`    Alice 本地文档: ${localIds.join(', ')}`);
  check('Alice 拿到自己的订单', localOrders.includes('order:a1') && localOrders.includes('order:a2'),
    localOrders.join(','));
  check('Alice 拿不到 Bob 的任何订单', leaked.length === 0,
    leaked.length ? `泄露: ${leaked.join(',')}` : '零泄露');
  check('产品数据全公司可见', localIds.includes('product:p1') && localIds.includes('product:p2'));
  const sysDocs = localIds.filter((i) => i.startsWith('_'));
  check('系统文档（_design/_local）不下发到客户端', sysDocs.length === 0,
    sysDocs.length ? `泄露: ${sysDocs.join(',')}` : '零泄露');

  /* ---------------- 6. admin 可见全部 ---------------- */
  console.log('\n【6】admin 可见全部');
  const adminDb = new PouchDB('spike_admin');
  clients.push(['spike_admin', adminDb]);
  if (ddocFilterWorked) {
    await PouchDB.replicate(remote, adminDb, {
      filter: 'app/by_sales',
      query_params: { sales_id: 'admin' },
    });
  } else {
    await PouchDB.replicate(remote, adminDb, { filter: filterFn, query_params: { sales_id: 'admin' } });
  }
  const adminOrders = (await adminDb.allDocs()).rows
    .map((r) => r.id).filter((i) => i.startsWith('order:')).sort();
  console.log(`    admin 可见订单: ${adminOrders.join(', ')}`);
  check('admin 能看到 Alice 与 Bob 的全部订单',
    adminOrders.includes('order:a1') && adminOrders.includes('order:b1'),
    `共 ${adminOrders.length} 张`);

  /* ---------------- 7. 冲突检测：UNIQUE(order_id, version) ---------------- */
  console.log('\n【7】冲突检测：同版本号重复写入是否被拒绝');
  await serverDb.put({ _id: 'orderrev:a1:2', order_id: 'order:a1', version: 2, snapshot: { total: 4300 }, sales_id: 'alice' });
  let conflictRejected = false;
  try {
    // 模拟另一台设备同时提交同一个版本号
    await serverDb.put({ _id: 'orderrev:a1:2', order_id: 'order:a1', version: 2, snapshot: { total: 9999 }, sales_id: 'alice' });
  } catch (e) {
    conflictRejected = e.status === 409 || /conflict/i.test(e.message);
  }
  check('同版本号第二次写入被拒绝（原子冲突检测）', conflictRejected,
    conflictRejected ? '返回 409 conflict' : '未拒绝 —— 存在静默覆盖风险');

} finally {
  /* ---------------- 清理 ---------------- */
  for (const [name] of clients) {
    try { await new PouchDB(name).destroy(); } catch { /* 忽略 */ }
  }
  try { await new PouchDB(remote).destroy(); } catch { /* 忽略 */ }
  await new Promise((r) => server.close(r));
}

/* ---------------- 汇总 ---------------- */
const passed = results.filter((r) => r.pass).length;
console.log(`\n${'='.repeat(60)}`);
console.log(`结果: ${passed} / ${results.length} 项通过`);
const failed = results.filter((r) => !r.pass);
if (failed.length) {
  console.log('\n未通过：');
  failed.forEach((r) => console.log(`  ✗ ${r.name}  ${r.detail}`));
}
process.exitCode = failed.length ? 1 : 0;
