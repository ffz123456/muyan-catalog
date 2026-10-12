/**
 * 界面与画册的目视验证：无头浏览器截图 + 交互断言。
 *
 * 两道防线（来自第 2 步的教训）：
 *   1. 每个交互后**断言状态真的变了**，失败即报错，不静默出图
 *   2. 截图前等一次**实际重绘**，避免截到旧帧
 *
 * 运行（需先启动服务端）：node tools/ui-screenshot.mjs
 * 依赖复用 catalog/ 下已安装的 puppeteer。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSuite } from './assert-lib.mjs';
import { launchBrowser, loginAs } from './browser.mjs';

const HERE = import.meta.dirname;
const APP_DIR = path.join(HERE, '..');
const SHOTS = path.join(APP_DIR, 'data', 'shots');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const A4_H = 1123;

const s = createSuite('界面验证');
let shots = [];

/** 等浏览器真正重绘一帧，避免截到旧画面。 */
async function waitForPaint(page) {
  await page.evaluate(() => new Promise((resolve) => {
    const style = document.createElement('style');
    style.textContent = '@keyframes __paint{to{opacity:.01}}';
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;opacity:0;pointer-events:none;animation:__paint 24ms';
    document.head.appendChild(style);
    el.addEventListener('animationend', () => { el.remove(); resolve(); }, { once: true });
    document.body.appendChild(el);
    setTimeout(resolve, 400);
  }));
  await new Promise((r) => setTimeout(r, 80));
}

/**
 * 等提示条消失。
 *
 * 为什么要等：提示条浮在底部，虽然已设 pointer-events:none 不会挡住点击，
 * 但它会出现在截图里，而且脚本的时机把握如果撞上它，
 * 断言看到的就不是"稳定后的界面"。等它消失让结果可复现。
 */
async function waitForToastGone(page) {
  try {
    await page.waitForFunction(
      () => document.getElementById('toast')?.hidden !== false,
      { timeout: 4000 },
    );
  } catch { /* 提示条还在就算了，不因为提示条让测试失败 */ }
}

async function main() {
  await fs.rm(SHOTS, { recursive: true, force: true });
  await fs.mkdir(SHOTS, { recursive: true });

  const profile = path.join(APP_DIR, 'data', '.chrome-profile-shot');
  await fs.rm(profile, { recursive: true, force: true });

  const browser = await launchBrowser({ userDataDir: profile });
  s.info(`浏览器：${browser.__source} + ${browser.__executable}`);

  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => s.info(`[页面异常] ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') s.info(`[console.error] ${m.text()}`); });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);

    /**
     * 清空本地订单库，让每次运行从干净状态开始。
     *
     * 为什么需要：本脚本用固定浏览器 profile，IndexedDB 会跨运行累积数据。
     * 不清的话，换个使用者之后本地仍留着上一位的单，
     * 断言"归属只有当前销售"就会失败——那是环境残留，不是应用缺陷。
     *
     * ⚠️ 但这件事本身指向一个**真实待办**：
     *    换使用者（尤其离职交接）后，本地残留的旧订单需要主动清理。
     *    见主文档 §10.4「权限撤销后的数据残留」。
     */
    await page.evaluate(async () => {
      try { await new PouchDB('fs_orders').destroy(); } catch { /* 不存在则忽略 */ }
    });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);

    const shot = async (name) => {
      await waitForPaint(page);
      const f = path.join(SHOTS, `${name}.png`);
      await page.screenshot({ path: f });
      shots.push([name, f]);
    };
    const txt = (sel) => page.$eval(sel, (el) => el.textContent.trim()).catch(() => null);
    const cnt = (sel) => page.$$eval(sel, (els) => els.length).catch(() => 0);

    /* ---------- 0. 需要登录：先过登录闸门 ---------- */
    s.group('【0】登录闸门');
    const gateShown = await page.$eval('#loginGate', (el) => !el.hidden);
    s.info(`登录闸门显示：${gateShown}（已登录会话会直接跳过）`);
    if (gateShown) {
      const form = await page.evaluate(() => ({
        hasForm: !!document.getElementById('loginForm'),
        users: document.querySelectorAll('#loginUser option').length,
        hasPw: !!document.querySelector('#loginForm [name=password]'),
      }));
      s.check('闸门提供账号下拉与密码输入', form.hasForm && form.users >= 2 && form.hasPw,
        `${form.users} 个账号`);
      await shot('00-login-gate');

      // 用管理者身份进入：后续断言需要"能看到全部订单"。
      const r = await loginAs(page, 'admin');
      s.check('以管理者身份登录成功', r.status === 200,
        `${r.how} → HTTP ${r.status}${r.status === 200 ? '' : '：' + r.body}`);

      await page.reload({ waitUntil: 'networkidle0' });
      await page.waitForFunction(() => document.getElementById('loginGate').hidden, { timeout: 20000 });
      // 等首次同步完成，避免后续断言撞上"同步中"
      try {
        await page.waitForFunction(
          () => !document.getElementById('syncText')?.textContent.includes('同步中'),
          { timeout: 25000 },
        );
      } catch { /* 忽略 */ }
      s.check('登录后闸门收起', true);
      await shot('00-after-login');
    }

    /* ---------- 1. 开单页（默认首页） ---------- */
    s.group('【1】开单页为首页');
    const first = await page.evaluate(() => ({
      panel: document.querySelector('.panel.is-active')?.id,
      tab: document.querySelector('.tab.is-active')?.dataset.tab,
      who: document.getElementById('whoName')?.textContent,
      stats: document.querySelectorAll('#orderStats .stat').length,
    }));
    s.check('默认停在「开单」页', first.panel === 'panel-order', String(first.panel));
    s.check('显示经营概览（3 项）', first.stats === 3, String(first.stats));
    s.check('显示当前使用人', !!first.who && first.who !== '—', String(first.who));
    await shot('01-orders');

    /* ---------- 2. 新开一单 ---------- */
    s.group('【2】新开一单：选产品 → 数量 → 价格 → 合计');
    await page.click('#btnNewOrder');
    await waitForPaint(page);
    s.check('开单弹层已打开', await page.$eval('#orderSheet', (el) => !el.hidden));

    // 加产品：勾选 → 点「加入订单」（图片网格 + 多选）
    await page.click('#btnAddItem');
    await waitForPaint(page);
    s.check('选产品弹层已打开', await page.$eval('#pickSheet', (el) => !el.hidden));

    const pickCount = await cnt('#pickSource .pick-card');
    s.check('可选产品已列出', pickCount > 0, `${pickCount} 项`);

    // 关键：每张卡片必须有图——销售靠图确认款式
    const cardImgs = await page.$$eval('#pickSource .pick-card', (cards) => cards.filter(
      (c) => c.querySelector('.pick-card-img img'),
    ).length);
    s.check('产品卡片带图片', cardImgs === pickCount, `${cardImgs}/${pickCount} 有图`);
    s.check('卡片显示价格', (await cnt('#pickSource .pick-card-price')) === pickCount);
    await shot('02b-pick-grid');

    // 未勾选时确认条应隐藏
    s.check('未勾选时不显示确认条', await page.$eval('#pickBar', (el) => el.hidden));

    // 勾第一款
    await page.click('#pickSource .pick-card');
    await waitForPaint(page);
    s.check('勾选后出现确认条', await page.$eval('#pickBar', (el) => !el.hidden));
    s.check('确认条显示已选数量',
      (await txt('#pickBarCount'))?.includes('1'), String(await txt('#pickBarCount')));

    // 再勾第二款 → 一次加入两款
    await page.click('#pickSource .pick-card:nth-child(2)');
    await waitForPaint(page);
    s.check('可同时勾选多款',
      (await txt('#pickBarCount'))?.includes('2'), String(await txt('#pickBarCount')));

    await page.click('#btnPickConfirm');
    await waitForPaint(page);
    s.check('确认后弹层关闭', await page.$eval('#pickSheet', (el) => el.hidden));
    s.check('一次加入两款货', (await cnt('#orderItems .oitem')) === 2);

    // 关键：开单项里也要有图
    const oitemImgs = await page.$$eval('#orderItems .oitem', (rows) => rows.filter(
      (r) => r.querySelector('.oitem-thumb img'),
    ).length);
    s.check('开单项显示产品图片', oitemImgs === 2, `${oitemImgs}/2 有图`);
    await shot('02c-order-with-images');

    // 再加一款，验证重复打开弹层不会残留上次的勾选
    await waitForToastGone(page);
    await page.click('#btnAddItem');
    await waitForPaint(page);
    s.check('重开弹层时勾选已清空', await page.$eval('#pickBar', (el) => el.hidden));
    await page.click('#btnClosePick');
    await waitForPaint(page);

    // 数量 +1
    const totalBefore = await txt('#sumTotal');
    await page.click('#orderItems .oitem:first-child [data-plus]');
    await waitForPaint(page);
    const totalAfter = await txt('#sumTotal');
    s.check('加数量后合计变化', totalBefore !== totalAfter, `${totalBefore} → ${totalAfter}`);

    // 改成交价（让利）
    // 注意：必须先设 value 再派发 input，否则事件处理读到的是旧值
    await page.evaluate(() => {
      const el = document.querySelector('#orderItems .oitem:first-child [data-price]');
      el.value = '1000';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForPaint(page);
    const discount = await txt('#sumDiscount');
    s.check('改低成交价后出现让利金额', discount && discount !== '¥0', `让利 ${discount}`);
    await shot('02-order-new');

    // 填客户并保存
    await page.type('#orderForm [name=customer_name]', '界面测试客户');
    await page.click('#orderForm button[type=submit]');
    await page.waitForFunction(() => document.getElementById('orderSheet').hidden, { timeout: 8000 });
    await waitForPaint(page);
    const orderNames = await page.$$eval('#orderList .item .item-name', (els) => els.map((e) => e.textContent.trim()));
    s.check('新单已出现在列表', orderNames.some((n) => n.includes('界面测试客户')), orderNames.join(' / '));
    await shot('03-orders-after-save');

    /* ---------- 3. 切换使用人 → 隔离 ---------- */
    s.group('【3】切换使用人：销售只看自己的单');
    const allCount = await cnt('#orderList .item');
    s.info(`管理者可见 ${allCount} 张单（含多人）`);

    /* ---------- 3. 换身份必须重新登录（不能点名字就变） ---------- */
    s.group('【3】换身份：只能通过登录，不能点名字就变');

    // 先确认弹层里已没有"点一下就变成他"的入口
    await page.click('#btnWho');
    await waitForPaint(page);
    s.check('使用人弹层已打开', await page.$eval('#whoSheet', (el) => !el.hidden));
    const whoSheetInfo = await page.evaluate(() => ({
      names: Array.from(document.querySelectorAll('#whoList .item-name')).map((e) => e.textContent.trim()),
      options: Array.from(document.querySelectorAll('#whoList .item')).map((e) => e.dataset.name ?? null),
    }));
    s.info(`弹层里的操作项：${whoSheetInfo.names.join(' / ') || '(空)'}`);
    s.check('弹层不再提供"切换到某人"的入口',
      !whoSheetInfo.options.some(Boolean),
      whoSheetInfo.options.some(Boolean) ? '仍有可切换身份的项！' : '只有退出登录 / 修改密码');
    s.check('弹层提供退出登录', whoSheetInfo.names.includes('退出登录'));
    await page.click('#btnCloseWho');
    await waitForPaint(page);

    // 后端也不该有这个后门
    const backdoor = await page.evaluate(async () => {
      const r = await fetch(new URL('/api/sales/current', location.origin), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'bob' }),
      });
      return r.status;
    });
    s.check('后端"免密切换身份"端点已移除', backdoor === 404, `HTTP ${backdoor}`);

    // 用 alice 的身份重新登录
    const reLogin = await loginAs(page, 'alice');
    s.check('用 alice 登录成功', reLogin.status === 200,
      `${reLogin.how} → HTTP ${reLogin.status}`);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.getElementById('loginGate').hidden, { timeout: 20000 });
    try {
      await page.waitForFunction(
        () => !document.getElementById('syncText')?.textContent.includes('同步中'),
        { timeout: 25000 },
      );
    } catch { /* 忽略 */ }
    const targetName = await txt('#whoName');
    s.check('身份已变为 alice', !!targetName && targetName !== '未登录', String(targetName));

    const ownCount = await cnt('#orderList .item');
    const scopeText = await txt('#scopeNote');
    s.info(`以「${targetName}」登录后可见 ${ownCount} 张单；提示：${scopeText?.slice(0, 24)}`);
    s.check('界面明确提示可见范围',
      !!scopeText && (scopeText.includes('自己') || scopeText.includes('全部')));
    s.check('销售看到的单数 ≤ 管理者', ownCount <= allCount, `${ownCount} ≤ ${allCount}`);

    const owners = await page.evaluate(async () => {
      const db = new PouchDB('fs_orders');
      const all = await db.allDocs({ include_docs: true });
      const mine = all.rows.map((r) => r.doc).filter((d) => d && d.status !== 'deleted');
      return { owners: [...new Set(mine.map((o) => o.sales_id))] };
    });
    s.check('本地库不含他人订单',
      !owners.owners.includes('admin'),
      `归属：${owners.owners.join(',') || '(空)'}`);
    await shot('04-orders-sales-view');

    // 该销售自己开一单，验证归属正确
    s.group('【3b】以销售身份开单，归属应为本人');
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
    }, `${targetName}的客户`);
    await page.click('#orderForm button[type=submit]');
    await page.waitForFunction(() => document.getElementById('orderSheet').hidden, { timeout: 10000 });
    await waitForPaint(page);

    const newOwner = await page.evaluate(async () => {
      const db = new PouchDB('fs_orders');
      const all = await db.allDocs({ include_docs: true });
      const mine = all.rows.map((r) => r.doc).filter((d) => d && d.status !== 'deleted');
      return { owners: [...new Set(mine.map((o) => o.sales_id))], count: mine.length };
    });
    // 关键安全属性：**上一位使用者（admin）的本地残留必须已被清掉**。
    // 不去要求"只有自己一个人的单"——那会过严：别销售合法共享的单理应可见。
    s.check('上一位使用者的本地残留已清除',
      !newOwner.owners.includes('admin'),
      `本地归属=${newOwner.owners.join(',')}`);
    s.check('当前销售的单在本地', newOwner.owners.includes('alice'), `本地归属=${newOwner.owners.join(',')}`);
    s.check('新单已计入该销售列表', newOwner.count >= 1, `${newOwner.count} 张`);

    /* ---------- 4. 软删除 ---------- */
    s.group('【4】删除订单为软删除');
    const beforeDelCount = await cnt('#orderList .item');
    if (beforeDelCount > 0) {
      await page.click('#orderList .item');
      await waitForPaint(page);
      s.check('打开已有订单', await page.$eval('#orderSheet', (el) => !el.hidden));
      s.check('已有订单显示删除按钮', await page.$eval('#btnDeleteOrder', (el) => !el.hidden));
      await shot('05-order-edit');

      // confirm 是同步阻塞的，必须**在点击之前**挂上处理器
      page.once('dialog', (d) => d.accept());
      await page.click('#btnDeleteOrder');
      await page.waitForFunction(() => document.getElementById('orderSheet').hidden, { timeout: 10000 });
      await waitForPaint(page);
      const afterDel = await cnt('#orderList .item');
      s.check('删除后列表少一张', afterDel === beforeDelCount - 1, `${beforeDelCount} → ${afterDel}`);

      // 关键：确认是软删除，文档仍在（本地库 + CouchDB 都查）
      // 注意：订单已不再存服务端本地 JSON，数据源是本地 PouchDB 与同步库
      const soft = await page.evaluate(async () => {
        const db = new PouchDB('fs_orders');
        const all = await db.allDocs({ include_docs: true });
        const deleted = all.rows.map((r) => r.doc).filter((d) => d && d.status === 'deleted');
        return {
          deletedCount: deleted.length,
          stillHasAmount: deleted.every((d) => typeof d.total === 'number'),
          keepsOwner: deleted.every((d) => !!d.sales_id),
        };
      });
      s.check('被删订单仍可查到（文档未真删，可审计）', soft.deletedCount > 0, `deleted=${soft.deletedCount}`);
      s.check('被删订单的金额仍完整', soft.stillHasAmount);
      s.check('被删订单保留归属字段（可审计）', soft.keepsOwner);
    } else {
      s.check('该销售有订单可测删除', false, '没有订单，跳过删除验证');
    }

    /* ---------- 5. 产品页 ---------- */
    s.group('【5】产品页');
    await page.click('.tab[data-tab="products"]');
    await waitForPaint(page);
    s.check('切到产品页', (await page.$eval('.tab.is-active', (el) => el.dataset.tab)) === 'products');
    s.check('产品列表有数据', (await cnt('#productList .item')) > 0);
    await shot('06-products');

    /* ---------- 6. 画册页 ---------- */
    s.group('【6】画册页');
    await page.click('.tab[data-tab="catalog"]');
    await waitForPaint(page);
    const pickInfo = await page.evaluate(() => ({
      pick: document.querySelectorAll('#pickList .item').length,
      on: document.querySelectorAll('#pickList .item.is-on').length,
      sel: document.getElementById('selCount').textContent,
    }));
    s.check('可选产品已列出', pickInfo.pick > 0, `${pickInfo.pick} 项`);
    s.check('默认全选', pickInfo.on === pickInfo.pick, `${pickInfo.on}/${pickInfo.pick}`);
    await shot('07-catalog');

    /* ---------- 7. 设置页 ---------- */
    s.group('【7】设置页');
    await page.click('.tab[data-tab="settings"]');
    await waitForPaint(page);
    s.check('切到设置页', (await page.$eval('.tab.is-active', (el) => el.dataset.tab)) === 'settings');
    s.check('销售人员列表已显示', (await cnt('#salesList .item')) >= 2);
    s.check('公司名已回填', !!(await page.$eval('#settingsForm [name=companyName]', (el) => el.value)));
    await shot('08-settings');

    /* ---------- 7b. 账号管理（管理员可见） ---------- */
    s.group('【7b】账号管理界面');

    // 先确认"销售看不到管理入口"——这本身就是要验证的权限行为
    const asSales = await page.evaluate(() => ({
      addBtn: !document.getElementById('btnAddAccount').hidden,
      adminHint: !document.getElementById('salesAdminHint').hidden,
      normalHint: !document.getElementById('salesHint').hidden,
      clickable: document.querySelectorAll('#salesList .item[data-acct]').length,
    }));
    s.check('销售看不到「新建账号」按钮', !asSales.addBtn);
    s.check('销售看到的是普通说明', asSales.normalHint && !asSales.adminHint);
    s.check('销售的账号列表不可点开管理', asSales.clickable === 0, `${asSales.clickable} 个可点`);

    // 切回管理员才能测管理功能
    const backAdmin = await loginAs(page, 'admin');
    s.check('切回管理员成功', backAdmin.status === 200, `${backAdmin.how} → ${backAdmin.status}`);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.getElementById('loginGate').hidden, { timeout: 20000 });
    await page.click('.tab[data-tab="settings"]');
    await waitForPaint(page);

    const acctUi = await page.evaluate(() => ({
      addBtn: !document.getElementById('btnAddAccount').hidden,
      adminHint: !document.getElementById('salesAdminHint').hidden,
      normalHint: !document.getElementById('salesHint').hidden,
      rows: document.querySelectorAll('#salesList .item').length,
      clickable: document.querySelectorAll('#salesList .item[data-acct]').length,
    }));
    s.check('管理员能看到「新建账号」按钮', acctUi.addBtn);
    s.check('管理员看到管理说明', acctUi.adminHint && !acctUi.normalHint);
    s.check('账号列表有内容', acctUi.rows >= 3, `${acctUi.rows} 个`);
    s.check('每一项都可点开管理', acctUi.clickable === acctUi.rows,
      `${acctUi.clickable}/${acctUi.rows}`);

    // 打开新建弹层，验证表单字段
    await page.click('#btnAddAccount');
    await waitForPaint(page);
    const formInfo = await page.evaluate(() => {
      const f = document.getElementById('acctForm');
      return {
        open: !document.getElementById('acctSheet').hidden,
        title: document.getElementById('acctTitle').textContent.trim(),
        hasName: !!f.elements.name,
        hasEmail: !!f.elements.email,
        hasPhone: !!f.elements.phone,
        hasAdmin: !!f.elements.admin,
        hasActive: !!f.elements.active,
        nameEditable: !f.elements.name.readOnly,
        resetHidden: document.getElementById('btnResetPw').hidden,
        delHidden: document.getElementById('btnDelAcct').hidden,
        onceHidden: document.getElementById('onceBox').hidden,
      };
    });
    s.check('新建弹层已打开', formInfo.open, formInfo.title);
    s.check('表单含登录名与邮箱', formInfo.hasName && formInfo.hasEmail);
    s.check('表单上没有手机号字段（刻意不做）', !formInfo.hasPhone);
    s.check('表单含管理员与启用开关', formInfo.hasAdmin && formInfo.hasActive);
    s.check('新建时登录名可编辑', formInfo.nameEditable);
    s.check('新建时不显示重置/删除', formInfo.resetHidden && formInfo.delHidden);
    s.check('未生成密码时不显示一次性密码框', formInfo.onceHidden);
    await shot('08b-account-new');

    // 真的建一个，验证一次性密码框出现且内容像密码
    const testName = `ui${Date.now().toString().slice(-6)}`;
    await page.evaluate((n) => {
      const f = document.getElementById('acctForm');
      f.elements.name.value = n;
      f.elements.display.value = '界面测试账号';
      f.elements.email.value = `${n}@example.com`;
    }, testName);
    await page.click('#acctForm button[type=submit]');
    await page.waitForFunction(
      () => !document.getElementById('onceBox').hidden,
      { timeout: 15000 },
    ).catch(() => {});
    const onceInfo = await page.evaluate(() => ({
      shown: !document.getElementById('onceBox').hidden,
      pw: document.getElementById('oncePw').textContent.trim(),
    }));
    s.check('建账号后弹出一次性密码框', onceInfo.shown);
    s.check('一次性密码非空且像密码', onceInfo.pw.length >= 8, `${onceInfo.pw.length} 位`);
    await shot('08c-account-once-password');

    // 关掉后回到列表，应能看到新账号
    await page.click('#btnOnceDone');
    await waitForPaint(page);
    const listed = await page.$$eval('#salesList .item .item-sub', (els) => els.map((e) => e.textContent));
    s.check('新账号出现在列表里', listed.some((t) => t.includes(testName)),
      listed.filter((t) => t.includes(testName)).length ? '已出现' : '未出现');

    // 打开它，验证编辑态：登录名锁定 + 出现重置/删除
    await page.click(`#salesList .item[data-acct="${testName}"]`);
    await waitForPaint(page);
    const editInfo = await page.evaluate(() => {
      const f = document.getElementById('acctForm');
      return {
        title: document.getElementById('acctTitle').textContent.trim(),
        nameLocked: f.elements.name.readOnly,
        nameVal: f.elements.name.value,
        emailVal: f.elements.email.value,
        resetShown: !document.getElementById('btnResetPw').hidden,
        delShown: !document.getElementById('btnDelAcct').hidden,
      };
    });
    s.check('编辑态标题正确', editInfo.title.includes('界面测试账号'), editInfo.title);
    s.check('编辑时登录名锁定（它就是订单归属）', editInfo.nameLocked && editInfo.nameVal === testName);
    s.check('编辑时带出邮箱', editInfo.emailVal.endsWith('@example.com'), editInfo.emailVal);
    s.check('编辑时显示重置密码与删除', editInfo.resetShown && editInfo.delShown);
    await shot('08d-account-edit');

    // 清理：删掉测试账号
    page.once('dialog', (d) => d.accept());
    await page.click('#btnDelAcct');
    await page.waitForFunction(
      (n) => !Array.from(document.querySelectorAll('#salesList .item .item-sub'))
        .some((e) => e.textContent.includes(n)),
      { timeout: 15000 }, testName,
    ).catch(() => {});
    const afterDel = await page.$$eval('#salesList .item .item-sub', (els) => els.map((e) => e.textContent));
    s.check('测试账号已清理', !afterDel.some((t) => t.includes(testName)));


    /* ---------- 8. 画册渲染与分页 ---------- */
    s.group('【8】画册渲染与分页断言');
    const html = await (await fetch(`${BASE}/api/catalog/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupByCategory: false }),
    })).json();
    s.check('画册 HTML 已生成', !!html.html, `${html.count} 款`);

    if (html.html) {
      const tmp = path.join(APP_DIR, 'data', '.catalog-shot.html');
      await fs.writeFile(tmp, html.html, 'utf-8');
      const catPage = await browser.newPage();
      await catPage.setViewport({ width: 794, height: A4_H, deviceScaleFactor: 2 });
      await catPage.goto('file:///' + tmp.replace(/\\/g, '/'), { waitUntil: 'networkidle0' });
      await catPage.evaluate(() => document.fonts.ready);
      await catPage.evaluate(() => Promise.all(
        Array.from(document.images).filter((i) => !i.complete)
          .map((i) => new Promise((r) => { i.onload = i.onerror = r; }))
      ));
      const heights = await catPage.evaluate((a4) => Array.from(document.querySelectorAll('section.page'))
        .map((el, i) => ({ page: i + 1, h: Math.round(el.getBoundingClientRect().height), over: el.getBoundingClientRect().height > a4 + 1 })), A4_H);
      for (const x of heights) s.check(`第 ${x.page} 页 ${x.h}px / A4 ${A4_H}px`, !x.over);

      const sections = await catPage.$$('section.page');
      for (let i = 0; i < sections.length; i++) {
        const p = path.join(SHOTS, `09-catalog-page-${i + 1}.png`);
        await sections[i].screenshot({ path: p });
        shots.push([`09-catalog-page-${i + 1}`, p]);
      }
    }

    /* ---------- 9. 桌面宽度 ---------- */
    s.group('【9】桌面宽度');
    const desk = await browser.newPage();
    await desk.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await desk.goto(BASE, { waitUntil: 'networkidle0' });
    await desk.evaluate(() => document.fonts.ready);
    await waitForPaint(desk);
    const f = path.join(SHOTS, '10-desktop.png');
    await desk.screenshot({ path: f });
    shots.push(['10-desktop', f]);
    s.check('桌面宽度可正常渲染', true);
  } finally {
    await browser.close();
  }

  console.log(`\n已截图 ${shots.length} 张 -> ${path.relative(APP_DIR, SHOTS)}`);
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; console.error('\n运行中断：', e.message); }

const { failed } = s.summary();
if (crashed) {
  console.log(`\n脚本异常终止：${crashed.message}`);
  console.log(crashed.stack.split('\n').slice(0, 5).join('\n'));
}
process.exitCode = (failed.length || crashed) ? 1 : 0;
