/**
 * 启动自检 —— 把"装完还要人工做几步"变成"起来就可用"。
 *
 * 对应主文档 §2b.5 第 3 条：首次启动自动初始化，
 * 不让人手工建库、写权限文档、建账号。
 *
 * 这一步做三件事：
 *   1. 等 CouchDB 就绪（容器启动顺序不保证，必须自己等）
 *   2. 建库 + 应用账号 + 设计文档（过滤与校验函数，纵深防御用）
 *   3. 打印可用状态；失败则明确报错而不是静默降级
 *
 * 全部幂等，可反复执行。
 */
import { adminClient, bootstrap, config, DB } from './couch.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等 CouchDB 起来。容器编排下它可能比应用晚就绪。 */
async function waitForCouch({ attempts = 30, delayMs = 2000, log = console.log } = {}) {
  const c = adminClient();
  for (let i = 1; i <= attempts; i++) {
    const r = await c.get('/');
    if (r.status === 200) {
      if (i > 1) log(`  CouchDB 已就绪（第 ${i} 次探测，version ${r.body?.version}）`);
      return r.body;
    }
    if (i === 1) log(`  等待 CouchDB 就绪：${config.base}`);
    await sleep(delayMs);
  }
  throw new Error(
    `等了 ${attempts} 次仍未连上 CouchDB（${config.base}）。\n`
    + '  请确认：容器 couchdb 是否已启动、COUCHDB_URL 是否正确、'
    + 'COUCHDB_ADMIN_PASS 是否与 CouchDB 的 ADMIN_PASSWORD 一致。',
  );
}

/**
 * 启动自检。返回 { ready, version, steps }。
 * 失败时抛错——**不要静默降级**：同步不可用却装作可用，比直接报错更危险。
 */
export async function ensureCouchReady({ log = console.log } = {}) {
  const info = await waitForCouch({ log });
  const steps = await bootstrap({ log });
  return { ready: true, version: info?.version, steps, db: DB };
}
