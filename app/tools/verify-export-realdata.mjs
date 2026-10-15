/**
 * 用**真实订单数据**验导出：从服务端把订单拉下来，跑真实导出逻辑，看生成的 CSV
 *
 * 为什么不测"手机上点按钮下载"：
 *   那一步是浏览器标准行为（Blob + <a download>），而且受厂商下载管理器干扰，
 *   反复试的收益很低。**真正会出错的是数据**：列对不对、金额准不准、
 *   中文有没有乱码、转义有没有把表格撑坏 —— 这些在这里全能验。
 *
 * 顺带把导出的文件写到磁盘，方便人工用 Excel 打开看一眼。
 *
 * 用法：PW_ALICE=xxx node tools/verify-export-realdata.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ordersToItemsCsv, ordersToSummaryCsv, exportFileName, BOM } from '../shared/csv.mjs';

const BASE = process.env.APP_URL || 'http://127.0.0.1:8080';
const PW = process.env.PW_ALICE;
if (!PW) {
  console.error('  需要 PW_ALICE');
  process.exit(1);
}

/* ---------- 登录 ---------- */
let cookie = '';
const req = async (method, p, body) => {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  return { status: res.status, body: await res.json().catch(() => null) };
};

const login = await req('POST', '/api/session', { name: 'alice', password: PW });
if (login.status !== 200) {
  console.error(`  ✗ 登录失败 HTTP ${login.status}`);
  process.exit(1);
}
console.log('  ✓ 已登录 alice');

/* ---------- 造三张有代表性的订单 ---------- */
const samples = [
  {
    name: '张先生', phone: '13800000001', remark: '包送货安装',
    items: [
      { _id: 'i1', product_id: 'p1', product_name: '白蜡木实木茶几', qty: 2, list_price: 1680, actual_price: 1500 },
      { _id: 'i2', product_id: 'p2', product_name: '云舒三人布艺沙发', qty: 1, list_price: 4380, actual_price: 4380 },
    ],
  },
  {
    name: '李女士（老客户）', phone: '13900000002', remark: '要现货，越快越好',
    items: [{ _id: 'i3', product_id: 'p3', product_name: '橡木伸缩餐桌', qty: 1, list_price: 3280, actual_price: 3000 }],
  },
  {
    // 故意带逗号与引号：验证转义在真实链路上也没问题
    name: '王先生, 带"引号"的客户', phone: '13700000003', remark: '备注里也有,逗号',
    items: [{ _id: 'i4', product_id: 'p4', product_name: '胡桃木书桌', qty: 1, list_price: 2600, actual_price: 2600 }],
  },
  {
    // 空明细：验证"这单不能凭空消失"
    name: '只有金额没有明细的单', phone: '', remark: '',
    items: [],
  },
];

const stamp = Date.now();
for (const [i, sp] of samples.entries()) {
  const items = sp.items.map((it) => ({ ...it, subtotal: it.qty * it.actual_price }));
  const listTotal = items.reduce((a, it) => a + it.qty * it.list_price, 0);
  const total = items.reduce((a, it) => a + it.subtotal, 0);
  const id = `order:real-${stamp}-${i}`;
  const r = await req('POST', '/api/hub/push', {
    changes: [{
      id, rev: null,
      doc: {
        _id: id, type: 'order', status: 'active',
        sales_id: 'alice', sales_display: '销售 A',
        customer_name: sp.name, customer_phone: sp.phone, remark: sp.remark,
        items, list_total: listTotal, discount: listTotal - total, total,
        item_count: items.reduce((a, it) => a + it.qty, 0),
        version: 1,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
    }],
  });
  if (!r.body?.results?.[0]?.ok) {
    console.error(`  ✗ 第 ${i + 1} 张推送失败：${JSON.stringify(r.body)}`);
    process.exit(1);
  }
}
console.log(`  ✓ 推了 ${samples.length} 张订单`);

/* ---------- 从服务端拉回来（走真实同步路径）---------- */
const pull = await req('POST', '/api/hub/pull', { since: 0 });
const docs = (pull.body?.changes ?? []).map((c) => c.doc).filter((d) => d && d.type === 'order');
// 客户端会把 _id 映射成 id，这里补上，模拟界面看到的数据形状
const orders = docs.map((d) => ({ ...d, id: d.id ?? d._id })).filter((o) => String(o.id).includes(`real-${stamp}`));
console.log(`  ✓ 拉回 ${orders.length} 张（本次造的）`);

/* ---------- 跑真实导出逻辑 ---------- */
const itemsCsv = ordersToItemsCsv(orders);
const sumCsv = ordersToSummaryCsv(orders);

const OUT = path.join(import.meta.dirname, '..', 'data', '.tmp');
await fs.mkdir(OUT, { recursive: true });
const f1 = path.join(OUT, exportFileName('订单明细', new Date(stamp)));
const f2 = path.join(OUT, exportFileName('订单汇总', new Date(stamp)));
await fs.writeFile(f1, itemsCsv, 'utf-8');
await fs.writeFile(f2, sumCsv, 'utf-8');

/* ---------- 逐项检查 ---------- */
let bad = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) bad++;
};

console.log('\n  生成的文件：');
console.log(`    明细 ${path.basename(f1)}  ${(Buffer.byteLength(itemsCsv) / 1024).toFixed(1)} KB`);
console.log(`    汇总 ${path.basename(f2)}  ${(Buffer.byteLength(sumCsv) / 1024).toFixed(1)} KB`);

console.log('\n  内容检查：');
check('带 UTF-8 BOM（不带的话 Excel 打开中文是乱码）', itemsCsv.startsWith(BOM));
check('中文没有乱码', itemsCsv.includes('白蜡木实木茶几'));
check('客户名里的逗号被正确转义', itemsCsv.includes('"王先生, 带""引号""的客户"'),
  '含逗号+引号的客户名必须整体加引号、内部引号翻倍');
check('没有明细的订单也在（不会凭空消失）', itemsCsv.includes('（无明细）'));
check('出单人显示显示名而不是登录名', itemsCsv.includes('销售 A') && !itemsCsv.includes(',alice,'));

// 金额核对：2 × 1500 + 1 × 4380 = 7380；目录价 2×1680+4380 = 7740；让利 360
check('金额算对了（应收 7380）', itemsCsv.includes(',7380'));
check('目录价合计对（7740）', itemsCsv.includes(',7740'));
check('让利对（360）', itemsCsv.includes(',360'));

const lines = itemsCsv.replace(BOM, '').trim().split('\r\n');
console.log(`\n  明细 ${lines.length - 1} 行数据、${lines[0].split(',').length} 列`);
console.log('  表头：' + lines[0]);
console.log('\n  前两行数据：');
lines.slice(1, 3).forEach((l) => console.log('    ' + l));

console.log('');
console.log('  ────────────────────────────────────────');
if (bad) {
  console.log(`  ✗ ${bad} 项未通过`);
  process.exitCode = 1;
} else {
  console.log('  ✓ 导出内容全部正确（用真实订单数据验的）');
  console.log('');
  console.log('  想用 Excel 亲眼看一眼：');
  console.log('    ' + f1);
}
console.log('');
