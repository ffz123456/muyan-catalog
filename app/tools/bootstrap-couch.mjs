/**
 * 初始化 CouchDB（幂等）。
 *
 * 做四件事：
 *   1. 建 orders 数据库
 *   2. 建应用账号（app 角色）—— 服务端同步代理用它访问 CouchDB
 *   3. 设置 _security：只有 app 角色可读写
 *   4. 写入设计文档：过滤函数 + 校验函数
 *
 * 运行：node --env-file=.env tools/bootstrap-couch.mjs
 */
import { bootstrap, config, DB } from '../server/couch.mjs';

console.log(`目标：${config.base}`);
console.log(`数据库：${DB}`);
console.log('');
try {
  const results = await bootstrap({ log: (m) => console.log(m) });
  console.log('');
  console.log(`完成，共 ${results.length} 步。`);
  console.log('');
  console.log('下一步：重启应用服务端（node --env-file=.env server/index.mjs）');
} catch (err) {
  console.error('初始化失败：', err.message);
  process.exit(1);
}
