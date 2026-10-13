/**
 * 授权规则 —— **唯一来源**
 *
 * 服务端执行的规则（与设计文档里的 CouchDB 过滤/校验函数表达同一套）：
 *   R1  读订单：只能读 sales_id === 自己 的；admin 读全部
 *   R2  写订单：sales_id 必须 === 自己；admin 不受限
 *   R3  非订单文档（产品/货源等）：全公司可读，仅 admin 可写
 *   R4  系统文档（_design / _local 等）不外发
 *
 * 为什么必须只有一份：
 *   这个项目有两种同步实现——
 *     · CouchDB 代理版（server/sync.mjs）
 *     · 自研中心版（server/hubsync.mjs，为了免装数据库）
 *   如果两边各写一套授权，迟早会走样，而**授权走样是安全事故**，
 *   不会有任何报错提示。
 */

/** 是否为订单类文档。 */
export const isOrderId = (id) => typeof id === 'string'
  && (id.startsWith('order:') || id.startsWith('orderrev:'));

/**
 * R4：系统文档。
 *
 * ⚠️ `_local/*` 必须**排除在外**——它是 PouchDB 的复制检查点。
 * 实测踩过：把它当系统文档挡掉，客户端读不到检查点，整个复制无法推进，
 * 表现为订单反复推不上去、界面一直显示"未同步"。
 * `_local` 不参与复制、只存在于服务端，放行不泄露任何业务数据。
 */
export const isSystemDoc = (id) => typeof id === 'string'
  && id.startsWith('_') && !id.startsWith('_local/');

/** 该身份能否读这个文档（R1 / R3 / R4）。 */
export function canRead(doc, sales) {
  if (!doc) return false;
  const id = doc._id ?? doc.id;
  if (typeof id === 'string' && id.startsWith('_local/')) return true;
  if (isSystemDoc(id)) return false;
  if (sales?.admin) return true;
  if (!isOrderId(id)) return true;                 // R3：产品等共享
  return doc.sales_id === sales?.name;             // R1
}

/**
 * 该身份能否写这个文档。
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
export function canWrite(doc, sales) {
  const id = doc?._id ?? doc?.id;
  if (!id) return { ok: false, reason: '缺少 _id' };
  if (isSystemDoc(id)) {
    return { ok: false, reason: `不接受客户端写系统文档（${String(id).split('/')[0]}）` };
  }
  if (sales?.admin) return { ok: true };
  if (!isOrderId(id)) {
    // R3：产品等共享文档仅 admin 可写
    return { ok: false, reason: '产品等共享资料只有管理员能修改' };
  }
  if (doc.sales_id !== sales?.name) {
    return {
      ok: false,
      reason: `订单的 sales_id 必须是你本人：期望 ${sales?.name}，实际 ${doc.sales_id ?? '(缺失)'}`,
    };
  }
  return { ok: true };
}

/** 校验一批待写文档；返回被拒的项（形状与 CouchDB 的 _bulk_docs 一致）。 */
export function rejectForbidden(docs, sales) {
  if (sales?.admin) return [];
  return docs
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => isOrderId(d._id) && d.sales_id !== sales?.name)
    .map(({ d, i }) => ({
      id: d._id,
      error: 'forbidden',
      reason: `订单的 sales_id 必须是你本人：期望 ${sales?.name}，实际 ${d.sales_id ?? '(缺失)'}`,
      _index: i,
    }));
}
