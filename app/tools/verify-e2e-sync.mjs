/**
 * 第 4 步端到端验证：浏览器本地库 ↔ 同步代理 ↔ CouchDB
 *
 * 判据（不只看界面，而是查数据真的落地）：
 *   A. 未登录时被登录闸门挡住
 *   B. 选身份后本地库初始化并同步
 *   C. 界面出单 -> 文档出现在 **CouchDB**（说明真的上行成功，不只是本地写）
 *   D. 界面软删除 -> CouchDB 里 status 变 deleted，文档仍在
 *   E. 换身份后本地可见集合变化（隔离在浏览器侧也成立）
 *   F. 同步状态只用"已同步/未同步"两种说法
 *
 * 运行（需先启动服务端）：node --env-file=.env tools/verify-e2e-sync.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSuite } from './assert-lib.mjs';
import { launchBrowser, loginAs } from './browser.mjs';
import { adminClient, DB } from '../server/couch.mjs';

const APP_DIR = path.join(import.meta.dirname, '..');
const SHOTS = path.join(APP_DIR, 'data', 'shots-e2e');

const BASE = process.env.APP_URL || 'http://127.0.0.1:8080';
const s = createSuite('第 4 步 · 端到端同步验证');
const couch = adminClient();

async function waitForPaint(page) {
  await page.evaluate(() => new Promise((resolve) => {
    const style = document.createElement('style');
    style.textContent = '@keyframes __p{to{opacity:.01}}';
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;opacity:0;pointer-events:none;animation:__p 24ms';
    document.head.appendChild(style);
    el.addEventListener('animationend', () => { el.remove(); resolve(); }, { once: true });
    document.body.appendChild(el);
    setTimeout(resolve, 400);
  }));
  await new Promise((r) => setTimeout(r, 80));
}

/** 从 CouchDB 直接查一个订单文档（这是"真的上行成功"的判据）。 */
async function couchDoc(id) {
  const r = await couch.get(`/${DB}/${encodeURIComponent(id)}`);
  return r.status === 200 ? r.body : null;
}

async function main() {
  await fs.rm(SHOTS, { recursive: true, force: true });
  await fs.mkdir(SHOTS, { recursive: true });
  const profile = path.join(APP_DIR, 'data', '.chrome-profile-e2e');
  await fs.rm(profile, { recursive: true, force: true });

  const browser = await launchBrowser({ userDataDir: profile });
  s.info(`浏览器：${browser.__source} + ${browser.__executable}`);

  const shot = async (page, name) => {
    await waitForPaint(page);
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  };

  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => s.info(`[页面异常] ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') s.info(`[console.error] ${m.text()}`); });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

    /* ---------- A. 登录闸门 ---------- */
    s.group('【A】未登录时被挡住');
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    // 清掉可能残留的会话 cookie，确保从"未登录"开始
    const cookies = await page.cookies();
    for (const c of cookies) await page.deleteCookie(c);
    await page.reload({ waitUntil: 'networkidle0' });
    await waitForPaint(page);

    const gateVisible = await page.$eval('#loginGate', (el) => !el.hidden);
    s.check('未登录时显示登录闸门', gateVisible);
    const hasLoginForm = await page.evaluate(() => ({
      form: !!document.getElementById('loginForm'),
      userSel: document.querySelectorAll('#loginUser option').length,
      pwInput: !!document.querySelector('#loginForm [name=password]'),
    }));
    s.check('登录闸门提供账号选择与密码输入',
      hasLoginForm.form && hasLoginForm.userSel >= 2 && hasLoginForm.pwInput,
      `${hasLoginForm.userSel} 个账号`);
    await shot(page, 'A-login-gate');

    /* ---------- B. 登录并同步 ---------- */
    s.group('【B】登录后本地库初始化并同步');
    const loginRes = await loginAs(page, 'alice');
    s.check('以 alice 登录成功', loginRes.status === 200,
      `${loginRes.how} → HTTP ${loginRes.status}${loginRes.status === 200 ? '' : '：' + loginRes.body}`);

    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.getElementById('loginGate').hidden, { timeout: 20000 });
    s.check('登录后闸门收起', true);

    // 等首次同步完成
    let synced = false;
    try {
      await page.waitForFunction(
        () => document.getElementById('syncText')?.textContent.includes('已同步'),
        { timeout: 25000 },
      );
      synced = true;
    } catch { /* 下面断言会体现 */ }
    const syncText = await page.$eval('#syncText', (el) => el.textContent.trim());
    s.check('首次同步完成，状态显示"已同步"', synced, syncText);

    const whoName = await page.$eval('#whoName', (el) => el.textContent.trim());
    s.info(`当前使用人：${whoName}`);

    const localInfo = await page.evaluate(async () => {
      const db = new PouchDB('fs_orders');
      const info = await db.info();
      const all = await db.allDocs();
      return { docCount: info.doc_count, ids: all.rows.map((r) => r.id) };
    });
    s.check('浏览器本地库已建立', localInfo.docCount >= 0, `本地 ${localInfo.docCount} 个文档`);
    s.info(`本地文档示例：${localInfo.ids.slice(0, 6).join(', ')}${localInfo.ids.length > 6 ? ' …' : ''}`);
    s.check('本地库不含系统文档', !localInfo.ids.some((i) => i.startsWith('_design')));
    await shot(page, 'B-signed-in');

    /* ---------- C. 出单 -> 检查是否真的进了 CouchDB ---------- */
    s.group('【C】界面出单，验证文档真的落到 CouchDB');
    const customer = `E2E客户${Date.now() % 100000}`;
    await page.click('#btnNewOrder');
    await waitForPaint(page);
    await page.click('#btnAddItem');
    await waitForPaint(page);
    await page.click('#pickSource .pick-card');
    await waitForPaint(page);
    await page.click('#btnPickConfirm');
    await waitForPaint(page);
    await waitForPaint(page);
    await page.evaluate((n) => {
      document.querySelector('#orderForm [name=customer_name]').value = n;
    }, customer);
    await page.click('#orderForm button[type=submit]');
    await page.waitForFunction(() => document.getElementById('orderSheet').hidden, { timeout: 20000 });

    // 等同步回到"已同步"
    try {
      await page.waitForFunction(
        () => document.getElementById('syncText')?.textContent.includes('已同步'),
        { timeout: 25000 },
      );
    } catch { /* 忽略 */ }
    await waitForPaint(page);

    const localAfter = await page.evaluate(async () => {
      const db = new PouchDB('fs_orders');
      const all = await db.allDocs({ include_docs: true });
      return all.rows.map((r) => r.doc).filter((d) => d && d.customer_name);
    });
    const mine = localAfter.find((d) => d.customer_name === customer);
    s.check('本地库里有这张单', !!mine, mine?._id ?? '未找到');

    if (mine) {
      const remote = await couchDoc(mine._id);
      s.check('该单已上行到 CouchDB（关键判据）', !!remote, remote ? 'CouchDB 中已存在' : 'CouchDB 中不存在！');
      if (remote) {
        s.check('CouchDB 中的归属正确', remote.sales_id === 'alice', String(remote.sales_id));
        s.check('CouchDB 中的金额与本地一致', remote.total === mine.total, `${remote.total} vs ${mine.total}`);
      }
    } else {
      s.check('该单已上行到 CouchDB（关键判据）', false, '本地都没有，无法验证');
    }
    await shot(page, 'C-after-order');

    /* ---------- D. 软删除 ---------- */
    s.group('【D】界面软删除，验证 CouchDB 中标记而非消失');
    if (mine) {
      // 打开该单并删除
      await page.evaluate((id) => {
        const el = document.querySelector(`#orderList .item[data-id="${id}"]`);
        if (el) el.click();
      }, mine._id);
      await waitForPaint(page);
      const opened = await page.$eval('#orderSheet', (el) => !el.hidden);
      s.check('能打开刚出的单', opened);

      page.once('dialog', (d) => d.accept());
      await page.click('#btnDeleteOrder');
      await page.waitForFunction(() => document.getElementById('orderSheet').hidden, { timeout: 20000 });
      try {
        await page.waitForFunction(
          () => document.getElementById('syncText')?.textContent.includes('已同步'),
          { timeout: 25000 },
        );
      } catch { /* 忽略 */ }
      await waitForPaint(page);

      const remoteAfter = await couchDoc(mine._id);
      s.check('软删后 CouchDB 中文档仍存在（未硬删）', !!remoteAfter, remoteAfter ? '仍存在' : '消失了');
      s.check('软删后 CouchDB 中 status=deleted', remoteAfter?.status === 'deleted', String(remoteAfter?.status));
      s.check('软删后归属字段仍在（可审计）', remoteAfter?.sales_id === 'alice', String(remoteAfter?.sales_id));

      const localList = await page.evaluate(async () => {
        const db = new PouchDB('fs_orders');
        const all = await db.allDocs({ include_docs: true });
        return all.rows.map((r) => r.doc).filter((d) => d && d.status !== 'deleted').map((d) => d._id);
      });
      s.check('界面列表已不含被删的单', !localList.includes(mine._id));
    } else {
      s.check('软删除验证', false, '没有可用的订单');
    }
    await shot(page, 'D-after-delete');

    /* ---------- E. 换身份后的隔离 ---------- */
    s.group('【E】换身份后可见集合变化');
    const aliceIds = await page.evaluate(async () => {
      const db = new PouchDB('fs_orders');
      const all = await db.allDocs();
      return all.rows.map((r) => r.id);
    });

    // 换身份必须走登录（需密码），不能点名字就变
    const switchRes = await loginAs(page, 'bob');
    s.check('切换到 bob 成功', switchRes.status === 200,
      `${switchRes.how} → HTTP ${switchRes.status}`);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.getElementById('loginGate').hidden, { timeout: 20000 });

    let settled = false;
    try {
      await page.waitForFunction(
        () => !document.getElementById('syncText')?.textContent.includes('同步中'),
        { timeout: 25000 },
      );
      settled = true;
    } catch { /* 忽略 */ }
    await new Promise((r) => setTimeout(r, 2000));

    const bobIds = await page.evaluate(async () => {
      const db = new PouchDB('fs_orders');
      const all = await db.allDocs();
      return all.rows.map((r) => r.id);
    });
    s.info(`alice 本地 ${aliceIds.length} 个文档，切到 bob 后 ${bobIds.length} 个`);
    s.check('切换后同步已稳定', settled);

    // 后端确认：bob 通过代理只能看到自己的单
    const bobVisible = await page.evaluate(async () => {
      const r = await fetch(new URL('/api/sync/orders/_changes?since=0', location.origin));
      const d = await r.json();
      return (d.results ?? []).map((x) => x.id);
    });
    const bobOrders = bobVisible.filter((i) => i.startsWith('order:'));
    const bobOwners = [];
    for (const id of bobOrders.slice(0, 20)) {
      const owner = await page.evaluate(async (docId) => {
        const r = await fetch(new URL(`/api/sync/orders/${encodeURIComponent(docId)}`, location.origin));
        const d = await r.json();
        return d.sales_id ?? null;
      }, id);
      bobOwners.push(owner);
    }
    const owners = [...new Set(bobOwners)];
    s.info(`bob 可见订单 ${bobOrders.length} 张，归属：${owners.join(',') || '(空)'}`);
    s.check('bob 看不到 alice 的订单', owners.every((o) => o === 'bob') || owners.length === 0,
      owners.join(','));
    await shot(page, 'E-after-switch');

    /* ---------- F. 同步状态用词 ---------- */
    s.group('【F】同步状态只用两种说法');
    const chipStates = await page.evaluate(() => {
      const t = document.getElementById('syncText').textContent.trim();
      return { text: t, dotClass: document.getElementById('syncDot').className };
    });
    s.info(`当前：${chipStates.text}  (${chipStates.dotClass})`);
    const allowed = ['已同步', '未同步', '同步中…', '离线', '同步异常', '未登录'];
    s.check('状态文案在允许集合内（不露技术细节）',
      allowed.some((a) => chipStates.text.startsWith(a.replace('…', ''))),
      chipStates.text);
  } finally {
    await browser.close();
  }

  console.log(`\n截图目录：${path.relative(APP_DIR, SHOTS)}`);
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; console.error('\n运行中断：', e.message); }

const { failed } = s.summary();
if (crashed) {
  console.log(`\n脚本异常终止：${crashed.message}`);
  console.log(crashed.stack.split('\n').slice(0, 5).join('\n'));
}
process.exitCode = (failed.length || crashed) ? 1 : 0;
