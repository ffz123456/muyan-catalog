/**
 * 第 3 步验证：出单记录模块
 *
 * 验证目标（全部来自实测确认的硬约束）：
 *   1. 订单创建：sales_id 绑定、总价与让利计算、两层价格快照
 *   2. 修改：不覆盖，追加修订并递增 version
 *   3. 删除：**软删除**（status=deleted），订单文档仍在，可审计
 *   4. 隔离：销售只见自己的单；admin 见全部
 *   5. 跨销售修改/删除被拒（与 CouchDB 校验函数同一规则）
 *   6. 并发写入不丢单（写入串行化）
 *   7. 服务端拒绝客户端伪造 list_price
 *
 * 直接测服务模块，不经过 HTTP，便于精确控制身份。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSuite } from './assert-lib.mjs';
import { listProducts, getProduct } from '../server/store.mjs';
import {
  listOrders, getOrder, createOrder, updateOrder, deleteOrder, orderStats, paths,
} from '../server/orders.mjs';

const s = createSuite('第 3 步 · 出单记录模块');
const DEP = { getProduct };

async function main() {
  // 清空已有订单，保证结果可重复
  await fs.rm(paths.ORDERS_DIR, { recursive: true, force: true });

  const products = await listProducts();
  s.group('【0】前置数据');
  s.check('有可用的产品数据', products.length > 0, `${products.length} 款`);
  const [p1, p2] = products;
  s.info(`用 ${p1.name}（目录价 ${p1.price}）和 ${p2.name}（目录价 ${p2.price}）测试`);

  /* ---------- 1. 创建 ---------- */
  s.group('【1】创建订单');
  const o1 = await createOrder({
    customer_name: '张先生',
    customer_phone: '13800000001',
    items: [
      { product_id: p1.id, qty: 1 },                          // 不传成交价 → 用目录价
      { product_id: p2.id, qty: 2, actual_price: Number(p2.price) - 100 },  // 让利 100/件
    ],
  }, { ...DEP, salesId: 'alice' });

  s.check('订单已创建', !!o1.id, o1.id);
  s.check('sales_id 已绑定为出单人', o1.sales_id === 'alice', o1.sales_id);
  s.check('初始 version = 1', o1.version === 1);
  s.check('初始 status = active', o1.status === 'active');
  s.check('生成了首条修订（含快照）',
    Array.isArray(o1.revisions) && o1.revisions.length === 1 && !!o1.revisions[0].snapshot);

  const expectList = Number(p1.price) * 1 + Number(p2.price) * 2;
  const expectTotal = Number(p1.price) * 1 + (Number(p2.price) - 100) * 2;
  s.info(`合计：目录价 ${o1.list_total} / 应收 ${o1.total} / 让利 ${o1.discount}`);
  s.check('目录价合计正确', Math.abs(o1.list_total - expectList) < 0.01, `${o1.list_total} vs ${expectList}`);
  s.check('应收金额正确（含让利）', Math.abs(o1.total - expectTotal) < 0.01, `${o1.total} vs ${expectTotal}`);
  s.check('让利金额正确', Math.abs(o1.discount - (expectList - expectTotal)) < 0.01, String(o1.discount));
  s.check('记录了产品名快照（产品改名后历史单仍可读）',
    o1.items.every((it) => !!it.product_name));
  s.check('未传成交价时回退为目录价',
    o1.items[0].actual_price === Number(p1.price));

  /* ---------- 2. 伪造 list_price ---------- */
  s.group('【2】服务端拒绝客户端伪造目录价');
  const oForge = await createOrder({
    items: [{ product_id: p1.id, qty: 1, list_price: 1, actual_price: 1 }],
  }, { ...DEP, salesId: 'alice' });
  s.check('list_price 取自服务端产品数据，而非客户端传入',
    oForge.items[0].list_price === Number(p1.price),
    `客户端传 1，实际存 ${oForge.items[0].list_price}`);

  /* ---------- 3. 修改：追加修订 ---------- */
  s.group('【3】修改订单：不覆盖，追加修订');
  const beforeRevCount = o1.revisions.length;
  const o1b = await updateOrder(o1.id, {
    items: [{ product_id: p1.id, qty: 2, actual_price: Number(p1.price) - 200 }],
    customer_name: '张先生（改）',
  }, { ...DEP, salesId: 'alice' });

  s.check('version 递增到 2', o1b.version === 2, String(o1b.version));
  s.check('修订追加而非覆盖',
    o1b.revisions.length === beforeRevCount + 1,
    `${beforeRevCount} → ${o1b.revisions.length}`);
  s.check('修订中保留了旧快照（可回溯）',
    o1b.revisions[0].version === 1 && !!o1b.revisions[0].snapshot);
  s.check('客户名已更新', o1b.customer_name === '张先生（改）');
  s.check('sales_id 不可被改动', o1b.sales_id === 'alice');
  s.check('总额随修改重算', Math.abs(o1b.total - (Number(p1.price) - 200) * 2) < 0.01, String(o1b.total));

  /* ---------- 4. 跨销售修改/删除被拒 ---------- */
  s.group('【4】跨销售操作被拒（与 CouchDB 校验函数同规则）');
  let updErr = null;
  try { await updateOrder(o1.id, { customer_name: 'x' }, { ...DEP, salesId: 'bob' }); } catch (e) { updErr = e; }
  s.check('bob 不能修改 alice 的订单', !!updErr, updErr?.message ?? '竟然成功了');
  s.check('拒绝时返回 403', updErr?.status === 403, String(updErr?.status));

  let delErr = null;
  try { await deleteOrder(o1.id, { salesId: 'bob' }); } catch (e) { delErr = e; }
  s.check('bob 不能删除 alice 的订单', !!delErr, delErr?.message ?? '竟然成功了');

  /* ---------- 5. 隔离 ---------- */
  s.group('【5】隔离：销售只见自己的单');
  const o2 = await createOrder({
    customer_name: '王先生',
    items: [{ product_id: p1.id, qty: 1 }],
  }, { ...DEP, salesId: 'bob' });

  const aliceOrders = await listOrders({ salesId: 'alice' });
  const bobOrders = await listOrders({ salesId: 'bob' });
  const allOrders = await listOrders({});
  s.info(`alice 可见 ${aliceOrders.length} 张；bob 可见 ${bobOrders.length} 张；全部 ${allOrders.length} 张`);
  s.check('alice 只看到自己的单', aliceOrders.every((o) => o.sales_id === 'alice') && aliceOrders.length >= 2);
  s.check('bob 只看到自己的单', bobOrders.every((o) => o.sales_id === 'bob'));
  s.check('不传 salesId 时（admin 视角）能看到多人订单',
    new Set(allOrders.map((o) => o.sales_id)).size >= 2);
  s.check('bob 的单不在 alice 的列表里', !aliceOrders.some((o) => o.id === o2.id));

  /* ---------- 6. 软删除 ---------- */
  s.group('【6】软删除：订单仍在，只打标记');
  const del = await deleteOrder(o2.id, { salesId: 'bob' });
  s.check('删除后 status = deleted', del.status === 'deleted');
  s.check('记录了 deleted_at', !!del.deleted_at);
  s.check('删除也追加了修订',
    del.revisions.some((r) => r.action === 'soft_delete'));

  const stillThere = await getOrder(o2.id);
  s.check('订单文档仍然存在（未真删，可审计）', !!stillThere);
  s.check('订单内容仍在（金额可查）', stillThere.total > 0, String(stillThere.total));

  const bobActive = await listOrders({ salesId: 'bob' });
  s.check('默认列表已不含被删的单', !bobActive.some((o) => o.id === o2.id));
  const bobAll = await listOrders({ salesId: 'bob', includeDeleted: true });
  s.check('显式要求时仍可查到被删的单', bobAll.some((o) => o.id === o2.id));

  const delAgain = await deleteOrder(o2.id, { salesId: 'bob' });
  s.check('重复删除是幂等的', delAgain.status === 'deleted' && delAgain.version === del.version);

  let modDelErr = null;
  try { await updateOrder(o2.id, { customer_name: 'x' }, { ...DEP, salesId: 'bob' }); } catch (e) { modDelErr = e; }
  s.check('已删除的订单不能再修改', modDelErr?.status === 409, modDelErr?.message ?? '竟然成功了');

  /* ---------- 7. 并发不丢单 ---------- */
  s.group('【7】并发出单不丢单（写入串行化）');
  const N = 12;
  const results = await Promise.allSettled(
    Array.from({ length: N }, (_, i) => createOrder({
      customer_name: `并发客户${i}`,
      items: [{ product_id: p1.id, qty: 1 }],
    }, { ...DEP, salesId: 'alice' })),
  );
  const okCount = results.filter((r) => r.status === 'fulfilled').length;
  const afterConcurrent = await listOrders({ salesId: 'alice' });
  const concurrentIds = new Set(results.filter((r) => r.status === 'fulfilled').map((r) => r.value.id));
  const persisted = afterConcurrent.filter((o) => concurrentIds.has(o.id)).length;
  s.info(`并发 ${N} 单：成功 ${okCount}，落盘 ${persisted}`);
  s.check(`并发的 ${N} 单全部创建成功`, okCount === N, `${okCount}/${N}`);
  s.check('并发订单全部落盘（无丢单）', persisted === N, `${persisted}/${N}`);

  /* ---------- 8. 统计 ---------- */
  s.group('【8】统计');
  const st = await orderStats({ salesId: 'alice' });
  s.info(`alice：累计 ${st.total} 单，本月 ${st.thisMonth} 单，本月金额 ${st.thisMonthAmount}`);
  s.check('统计返回本月单数与金额',
    typeof st.thisMonth === 'number' && typeof st.thisMonthAmount === 'number');
  s.check('统计不含已软删除的单（alice 无删除）', st.deleted === 0, `deleted=${st.deleted}`);
  const stb = await orderStats({ salesId: 'bob' });
  s.check('bob 的统计反映其被删的 1 单', stb.deleted === 1, `deleted=${stb.deleted}`);

  /* ---------- 9. 校验边界 ---------- */
  s.group('【9】输入校验');
  const cases = [
    ['空 items 被拒', { items: [] }, 400],
    ['不存在的产品被拒', { items: [{ product_id: 'p_not_exist', qty: 1 }] }, 400],
    ['数量为 0 被拒', { items: [{ product_id: p1.id, qty: 0 }] }, 400],
    ['数量为负被拒', { items: [{ product_id: p1.id, qty: -1 }] }, 400],
    ['成交价为负被拒', { items: [{ product_id: p1.id, qty: 1, actual_price: -5 }] }, 400],
  ];
  for (const [name, body, expect] of cases) {
    let err = null;
    try { await createOrder(body, { ...DEP, salesId: 'alice' }); } catch (e) { err = e; }
    s.check(name, err?.status === expect, err ? `HTTP ${err.status}` : '竟然没报错');
  }
  let noSales = null;
  try { await createOrder({ items: [{ product_id: p1.id, qty: 1 }] }, DEP); } catch (e) { noSales = e; }
  s.check('缺少 sales_id 时拒绝创建', noSales?.status === 400, noSales?.message ?? '竟然成功了');
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; console.error('\n运行中断：', e.message); }

const { failed } = s.summary();
if (crashed) {
  console.log(`\n脚本异常终止：${crashed.message}`);
  console.log(crashed.stack.split('\n').slice(0, 5).join('\n'));
}
process.exitCode = (failed.length || crashed) ? 1 : 0;
