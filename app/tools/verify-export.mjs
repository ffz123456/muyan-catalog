/**
 * 订单导出验证
 *
 * 导出这块最容易错的两件事，都是**不看数据发现不了**的：
 *   1. CSV 转义 —— 客户名里带个逗号，整张表的列就错位了；
 *      Excel 里看到的是"数据对不上"，而你会先去怀疑统计逻辑
 *   2. 公式注入 —— 客户名填成 `=1+1`，Excel 会当公式执行。
 *      销售把表发给会计，风险跟着文件走
 *
 * 所以这里逐条验数据，而不是"能在手机上下载一次就算过"。
 */
import { createSuite } from './assert-lib.mjs';
import {
  toCsv, ordersToItemsCsv, ordersToSummaryCsv, exportFileName, shortId, BOM,
} from '../shared/csv.mjs';

const s = createSuite('订单导出（CSV）');

/** 造一张贴近真实的订单。 */
const order = (over = {}) => ({
  id: 'order:abc12345def67890',
  status: 'active',
  sales_id: 'alice',
  sales_display: '销售 A',
  customer_name: '张先生',
  customer_phone: '13800000000',
  remark: '包送货安装',
  items: [
    { product_id: 'p1', product_name: '白蜡木实木茶几', qty: 2, list_price: 1680, actual_price: 1500 },
    { product_id: 'p2', product_name: '云舒三人布艺沙发', qty: 1, list_price: 4380, actual_price: 4380 },
  ],
  list_total: 7740,
  discount: 360,
  total: 7380,
  item_count: 3,
  created_at: '2026-03-15T10:30:00.000Z',
  updated_at: '2026-03-15T10:30:00.000Z',
  ...over,
});

/** 把 CSV 解析回二维数组，用来验"转义之后还是对的"。 */
function parseCsv(text) {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"' && src[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\r') { /* 忽略 */ }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

/* ------------------------------------------------------------------ */
s.group('【1】CSV 转义（客户名里带逗号/引号/换行）');

s.check('普通值不加引号', toCsv([['a', 'b']], { withBom: false }) === 'a,b\r\n');

s.check('含逗号的值被引号包起来',
  toCsv([['张先生,老客户']], { withBom: false }) === '"张先生,老客户"\r\n',
  toCsv([['张先生,老客户']], { withBom: false }).trim());

s.check('含双引号的值，引号翻倍',
  toCsv([['他说"要这个"']], { withBom: false }) === '"他说""要这个"""\r\n',
  toCsv([['他说"要这个"']], { withBom: false }).trim());

s.check('含换行的值被引号包起来',
  toCsv([['第一行\n第二行']], { withBom: false }).startsWith('"第一行\n第二行"'));

// 关键：转义之后解析回来必须**完全等于**原值，否则列就错位了
const tricky = ['带,逗号', '带"引号"', '带\n换行', '普通', ''];
const round = parseCsv(toCsv([tricky], { withBom: false }))[0];
s.check('转义后能原样解析回来（列不会错位）',
  JSON.stringify(round) === JSON.stringify(tricky),
  JSON.stringify(round));

s.group('【2】公式注入防护');
s.check('以 = 开头的值被加前导单引号',
  toCsv([['=1+1']], { withBom: false }).startsWith("'=1+1"), toCsv([['=1+1']], { withBom: false }).trim());
s.check('以 + 开头的值被防护', toCsv([['+44']], { withBom: false }).startsWith("'+44"));
s.check('以 - 开头的值被防护', toCsv([['-1']], { withBom: false }).startsWith("'-1"));
s.check('以 @ 开头的值被防护', toCsv([['@SUM(A1)']], { withBom: false }).startsWith("'@SUM(A1)"));
s.check('正常的负数金额不受影响（业务数据要能算）',
  toCsv([['让利 -360']], { withBom: false }).trim() === '让利 -360',
  '注意：只有整格以符号开头才防护，句中的负号不动');

s.group('【3】BOM（不带的话 Excel 打开中文是乱码）');
s.check('默认带 BOM', toCsv([['a']]).startsWith(BOM));
s.check('BOM 是 U+FEFF', BOM.charCodeAt(0) === 0xFEFF);
s.check('可以显式关掉', !toCsv([['a']], { withBom: false }).startsWith(BOM));

s.group('【4】明细表');
const itemsCsv = ordersToItemsCsv([order()]);
const itemsRows = parseCsv(itemsCsv);
s.check('表头列数正确', itemsRows[0][0] === '订单号' && itemsRows[0][4] === '产品',
  itemsRows[0].join('|'));
s.check('一张单 2 个产品 → 2 行', itemsRows.length === 3, `${itemsRows.length - 1} 行数据`);
s.check('小计算对了（2 × 1500 = 3000）', itemsRows[1][8] === '3000', itemsRows[1][8]);
s.check('订单级字段在两行里重复（便于透视汇总）',
  itemsRows[1][11] === itemsRows[2][11], `应收 ${itemsRows[1][11]}`);
s.check('出单人显示的是显示名而不是登录名',
  itemsRows[1][12] === '销售 A', itemsRows[1][12]);

s.group('【5】没有明细的订单不能消失');
const noItems = parseCsv(ordersToItemsCsv([order({ items: [], id: 'order:none0001' })]));
s.check('没有明细也输出一行', noItems.length === 2, `${noItems.length - 1} 行数据`);
s.check('标明"（无明细）"', noItems[1][4] === '（无明细）', noItems[1][4]);
s.check('金额仍然带出来了（对账要用）', noItems[1][11] === '7380', noItems[1][11]);

s.group('【6】已删除的单');
const two = [order(), order({ id: 'order:del00001', status: 'deleted', customer_name: '已删客户' })];
s.check('默认不导出已删除的单',
  parseCsv(ordersToItemsCsv(two)).length === 3, `${parseCsv(ordersToItemsCsv(two)).length - 1} 行`);
s.check('可以选择包含已删除的单',
  parseCsv(ordersToItemsCsv(two, { withDeleted: true })).length === 5);
s.check('包含时状态列标"已删除"',
  parseCsv(ordersToItemsCsv(two, { withDeleted: true })).some((r) => r[14] === '已删除'));

s.group('【7】汇总表');
const sum = parseCsv(ordersToSummaryCsv(two));
s.check('一张单一行', sum.length === 2, `${sum.length - 1} 行数据`);
s.check('品种数是 2', sum[1][6] === '2', sum[1][6]);
s.check('件数是 3', sum[1][5] === '3', sum[1][5]);
s.check('应收带出来了', sum[1][9] === '7380', sum[1][9]);
s.check('默认不含已删除', parseCsv(ordersToSummaryCsv(two, { withDeleted: true })).length === 3);

s.group('【8】文件名');
const fn = exportFileName('订单明细', new Date(2026, 2, 15, 10, 30));
s.check('文件名带时间戳（下载多次能分清新旧）', fn === '木言-订单明细-20260315-1030.csv', fn);

s.group('【9】订单号');
s.check('去掉 order: 前缀', !shortId('order:abc12345def67890').startsWith('ORDER:'),
  shortId('order:abc12345def67890'));
s.check('空值不炸', shortId(null) === '');

/**
 * ⚠️ **这一条是真事故**，不是假想的边界情况。
 *
 * 第一版 shortId 会"删掉所有非字母数字"，于是
 *   order:real-1792071889721-0
 *   order:real-1792071889721-1
 * 都变成 20902980 —— **两张不同的单显示同一个订单号**。
 * 对账时看到两个一样的号，是事故。
 */
s.group('【10】订单号不能撞车（真事故回归测试）');
const ts = '1792071889721';
const ids = Array.from({ length: 12 }, (_, i) => `order:real-${ts}-${i}`);
const shorts = ids.map(shortId);
s.check('同批次 12 张单的短号互不相同',
  new Set(shorts).size === shorts.length,
  `${new Set(shorts).size}/${shorts.length} 个不同`);
s.check('相邻两张单的短号确实不同（这正是第一版栽的地方）',
  shorts[0] !== shorts[1], `${shorts[0]} vs ${shorts[1]}`);

const { failed } = s.summary();
process.exitCode = failed.length ? 1 : 0;
