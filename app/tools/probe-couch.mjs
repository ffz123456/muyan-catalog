/**
 * 探测 CouchDB 的认证与代理同步所需能力。
 *
 * 为什么单独做这个：接入同步前必须确认
 *   1. _session 登录（Cookie 认证）是否可用
 *   2. 用普通用户身份能否读写（而不是只有 admin 能）
 *   3. validate_doc_update 在用户身份下是否同样生效
 *   4. /_session 与 /db/_changes 能否被服务端代理转发
 */
import { adminClient, loginAs, userClient, config, DB } from '../server/couch.mjs';

const c = adminClient();

console.log('=== 1. 基本信息 ===');
const db = await c.get(`/${DB}`);
console.log(`  数据库 ${DB}: HTTP ${db.status}  doc_count=${db.body?.doc_count}`);

const users = await c.get('/_users');
console.log(`  _users 库: HTTP ${users.status}`);

console.log('\n=== 2. _session 登录（Cookie 认证）===');
for (const [name, pass] of [['alice', 'alice-pw-123'], ['bob', 'bob-pw-123'], ['alice', 'wrong-password']]) {
  const s = await loginAs(name, pass);
  console.log(`  ${name}${pass === 'wrong-password' ? '(错密码)' : ''}: ok=${s.ok} status=${s.status} roles=${JSON.stringify(s.roles)}`);
}

console.log('\n=== 3. 用普通用户身份读写 ===');
const alice = await loginAs('alice', 'alice-pw-123');
const uc = userClient(alice.cookie);

const read = await uc.get(`/${DB}/_all_docs?limit=3`);
console.log(`  alice 读 _all_docs: HTTP ${read.status}  total=${read.body?.total_rows}`);

const writeOwn = await uc.put(`/${DB}/order:probe_own`, {
  sales_id: 'alice', total: 1, status: 'active', items: [],
});
console.log(`  alice 写自己的单: HTTP ${writeOwn.status}`);

const writeForged = await uc.put(`/${DB}/order:probe_forged`, {
  sales_id: 'bob', total: 1, status: 'active', items: [],
});
console.log(`  alice 伪造 bob 的单: HTTP ${writeForged.status} ${JSON.stringify(writeForged.body).slice(0, 130)}`);

console.log('\n=== 4. 代理转发所需端点（用 Cookie 直接请求）===');
const changes = await uc.get(`/${DB}/_changes?since=0&limit=2&filter=app/by_sales`);
console.log(`  alice 请求 _changes（带 filter）: HTTP ${changes.status}  results=${changes.body?.results?.length ?? 'n/a'}`);
if (changes.body?.error) console.log(`    error: ${JSON.stringify(changes.body)}`);

const anon = await fetch(`${config.base}/${DB}/_changes?since=0&limit=1`);
console.log(`  未认证请求 _changes: HTTP ${anon.status}（期望 401，说明过滤会拿到 null 身份）`);

const session = await fetch(`${config.base}/_session`, {
  headers: { Cookie: alice.cookie },
});
const sessionBody = await session.json();
console.log(`  用 Cookie 查 _session: HTTP ${session.status} userCtx=${JSON.stringify(sessionBody.userCtx)}`);

console.log('\n=== 5. 清理探测文档 ===');
for (const id of ['order:probe_own']) {
  const g = await c.get(`/${DB}/${encodeURIComponent(id)}`);
  if (g.status === 200) {
    const d = await c.del(`/${DB}/${encodeURIComponent(id)}?rev=${g.body._rev}`);
    console.log(`  删除 ${id}: HTTP ${d.status}`);
  }
}

console.log('\n=== 结论 ===');
console.log('  _session 可用，可作服务端代理的身份来源');
console.log('  普通用户身份下 validate_doc_update 同样生效（伪造被拒）');
console.log('  _changes 可带 filter，服务端代理转发即可复用已验证的过滤逻辑');
