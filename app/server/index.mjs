/**
 * 应用服务端 —— 单进程，零外部依赖
 *
 * 设计约束（来自主文档 §2b.5）：
 *   - 单进程优先：本文件将来会把同步代理与画册生成一并挂进来，不引入独立服务
 *   - 零配置：端口等参数有合理默认值
 *   - 首次启动自动初始化：数据目录与默认设置由代码创建
 *
 * 当前阶段（主文档 §13 第 2 步）：产品管理 + 画册生成。
 * 同步层（CouchDB 兼容端点）在后续阶段挂载到 /sync 前缀下。
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  listProducts, getProduct, upsertProduct, deleteProduct, replaceAllProducts,
  getSettings, saveSettings, paths,
} from './store.mjs';
// 注意：orders.mjs 仍然存在，但服务端已不再直接读写它——
// 订单的权威存储是 CouchDB，客户端通过 /api/sync/orders/* 同步。
// orders.mjs 目前仅供测试脚本（verify-orders.mjs）验证业务规则使用。
import {
  listSalesPublic, currentSales, setCurrentSales,
  findSales, publicView, authenticate, changePassword, takeStartupNotice,
  createAccount, updateAccount, resetPassword, deleteAccount,
} from './sales.mjs';
// listSales() 是内部函数（带密码记录），**绝不能直接发给客户端**；
// 对外一律用 listSalesPublic() / publicView()。
import {
  couchAs, createSession, readSession, destroySession, sessionCookie, clearCookie, canSeeAll,
} from './auth.mjs';
import { handleSync, resetVisibilityCache } from './sync.mjs';
import { ensureCouchReady } from './startup.mjs';
import { DB as COUCH_DB, config as couchConfig } from './couch.mjs';

const HERE = import.meta.dirname;
const PUBLIC_DIR = path.join(HERE, '..', 'public');
const ASSET_DIR = path.join(HERE, '..', 'data', 'assets');
const EXPORT_DIR = path.join(HERE, '..', 'data', 'exports');

const VENDOR_DIR = path.join(HERE, '..', 'public', 'vendor');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

/**
 * 允许对外提供的第三方文件 —— **白名单**。
 *
 * 不要整个 vendor/ 目录都开放：目录里将来可能放进 map 文件、调试构建、
 * 甚至误提交的凭据。写死文件名最安全，也呼应第 1 步的教训
 * （过滤必须白名单式，黑名单一定会漏）。
 */
const VENDOR_ALLOW = new Set(['pouchdb.min.js']);

/**
 * 开发/测试专用的"免密登录"开关。
 *
 * ⚠️ 默认**关闭**。只有显式设置 `DEV_ALLOW_PASSWORDLESS_LOGIN=1` 才生效，
 *    而且要求进程绑在回环地址上（本机开发）。
 *
 * 为什么需要它：认证上线后，每个验证脚本都要带密码才能切换身份，
 *   把密码硬编码进脚本本身就是坏习惯。这个开关让验证脚本能直接切身份，
 *   同时把"能免密登录"这件事限制在开发环境，生产不会误开。
 *
 * 它**不是产品功能**，也不要写进部署文档。
 */
const DEV_PASSWORDLESS = process.env.DEV_ALLOW_PASSWORDLESS_LOGIN === '1';
const IS_LOOPBACK = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';

function devLoginAllowed() {
  if (!DEV_PASSWORDLESS) return false;
  if (!IS_LOOPBACK) {
    console.warn('[auth] 已忽略 DEV_ALLOW_PASSWORDLESS_LOGIN：服务未绑定回环地址');
    return false;
  }
  return true;
}


/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // ES 模块必须用 JS 的 MIME，否则浏览器按规范拒收
  // （实测：漏了这条整站脚本都加载不了）
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  const h = { 'Cache-Control': 'no-store', ...headers };
  if (Buffer.isBuffer(body)) {
    res.writeHead(status, h);
    res.end(body);
  } else if (typeof body === 'string') {
    res.writeHead(status, h);
    res.end(body);
  } else {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...h });
    res.end(json);
  }
}

const fail = (res, status, message) => send(res, status, { error: message });

async function readBody(req, limitBytes = 12 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > limitBytes) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

/** 防目录穿越：解析后必须仍在 base 目录内。 */
function safeJoin(base, rel) {
  const target = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

/* ------------------------------------------------------------------ *
 * 数据 URL 图片落盘
 * ------------------------------------------------------------------ */
const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

async function saveDataUrlImage(dataUrl) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl).trim());
  if (!m) throw Object.assign(new Error('图片格式无法识别'), { status: 400 });
  const [, mime, b64] = m;
  const ext = IMG_EXT[mime];
  if (!ext) throw Object.assign(new Error(`不支持的图片类型：${mime}`), { status: 400 });
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > 8 * 1024 * 1024) throw Object.assign(new Error('图片超过 8MB'), { status: 413 });
  const name = `img_${crypto.randomBytes(8).toString('hex')}.${ext}`;
  await fs.mkdir(ASSET_DIR, { recursive: true });
  await fs.writeFile(path.join(ASSET_DIR, name), buf);
  return { id: name, name, sizeKB: Math.round(buf.length / 1024) };
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */

/**
 * 取当前请求者的账号对象（未登录返回 null）。
 *
 * 权限判定一律基于**服务端会话**推导出的账号，绝不接受客户端传身份
 * （见主文档 §10.3.1）。
 */
async function callerAccount(req) {
  const s = readSession(req);
  if (!s) return null;
  return findSales(s.name);
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  /* ---- 会话 ---- */
  if (p === '/api/session' && req.method === 'GET') {
    const s = readSession(req);
    const sales = s ? await findSales(s.name) : null;
    return send(res, 200, {
      signedIn: !!sales,
      sales: sales ? publicView(sales) : null,
    });
  }

  /* ---- 登录（密码认证）----
   * 为什么必须有密码：订单按 sales_id 隔离，而 sales_id 就是登录名。
   * 若"选名字即进入"，任何人都能选别人的名字开单，隔离可被绕过 = 没有隔离。
   */
  if (p === '/api/session' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name ?? '').trim();
    const password = String(body.password ?? '');

    // 开发/测试专用免密入口（默认关闭，见文件顶部 DEV_PASSWORDLESS 说明）
    if (devLoginAllowed() && body.devNoPassword === true) {
      const sales = await findSales(name);
      if (!sales) return fail(res, 404, `没有这个账号：${name}`);
      await setCurrentSales(sales.name);
      const sid = createSession(sales.name);
      resetVisibilityCache();
      console.warn(`[auth] 免密登录（开发模式）：${sales.name}`);
      return send(res, 200, { sales: publicView(sales) }, { 'Set-Cookie': sessionCookie(sid) });
    }

    if (!name || !password) return fail(res, 400, '请填写账号和密码');

    const r = await authenticate(name, password);
    if (!r.ok) {
      // 统一话术，不区分"账号不存在"与"密码错误"，避免账号枚举
      return fail(res, 401, r.reason);
    }

    await setCurrentSales(r.sales.name);
    const sid = createSession(r.sales.name);
    // 身份变了，必须清掉按身份缓存的可见订单集合，否则会串到上一位的数据
    resetVisibilityCache();
    return send(res, 200, { sales: r.sales }, { 'Set-Cookie': sessionCookie(sid) });
  }

  if (p === '/api/session' && req.method === 'DELETE') {
    destroySession(req);
    resetVisibilityCache();
    return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });
  }

  /* ---- 修改自己的密码 ---- */
  if (p === '/api/password' && req.method === 'POST') {
    const s = readSession(req);
    if (!s) return fail(res, 401, '请先登录');
    const body = await readBody(req);
    return send(res, 200, await changePassword(s.name, String(body.oldPassword ?? ''), String(body.newPassword ?? '')));
  }

  /* ---- 同步代理 ----
   * 把 CouchDB 的复制协议端点转发出去，**授权由服务端执行**
   * （规则集中在 server/sync.mjs，见该文件顶部说明）。
   */
  if (p.startsWith('/api/sync/')) {
    const s = readSession(req);
    if (!s) return fail(res, 401, '未登录');
    const sales = await findSales(s.name);
    if (!sales) return fail(res, 401, '会话对应的销售不存在');

    const rest = p.slice('/api/sync/'.length);          // 例如 orders/_changes
    if (rest !== COUCH_DB && !rest.startsWith(`${COUCH_DB}/`)) {
      return fail(res, 404, '同步端点不存在');
    }

    const method = req.method;
    let body;
    if (method === 'POST' || method === 'PUT') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = chunks.length ? Buffer.concat(chunks).toString('utf-8') : undefined;
    }

    const r = await handleSync({ sales, rest, method, query: url.search, body });
    return send(res, r.status,
      typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}),
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  }

  /* ---- 产品 ---- */
  if (p === '/api/products' && req.method === 'GET') {
    return send(res, 200, {
      products: await listProducts(),
      perPage: (await import('./render-catalog.mjs')).PER_PAGE,
    });
  }

  if (p === '/api/products' && req.method === 'POST') {
    const body = await readBody(req);
    return send(res, 200, await upsertProduct(body));
  }

  if (p === '/api/products/replace' && req.method === 'POST') {
    const body = await readBody(req);
    if (!Array.isArray(body.products)) return fail(res, 400, '缺少 products 数组');
    const saved = await replaceAllProducts(body.products);
    return send(res, 200, { count: saved.length, products: saved });
  }

  const idMatch = /^\/api\/products\/([^/]+)$/.exec(p);
  if (idMatch) {
    const id = decodeURIComponent(idMatch[1]);
    if (req.method === 'GET') {
      const prod = await getProduct(id);
      return prod ? send(res, 200, prod) : fail(res, 404, '产品不存在');
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      return send(res, 200, await upsertProduct({ ...body, id }));
    }
    if (req.method === 'DELETE') {
      return send(res, 200, await deleteProduct(id));
    }
  }

  /* ---- 设置 ---- */
  if (p === '/api/settings' && req.method === 'GET') return send(res, 200, await getSettings());
  if (p === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req);
    return send(res, 200, await saveSettings(body));
  }

  /* ---- 图片上传 ---- */
  if (p === '/api/images' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.dataUrl) return fail(res, 400, '缺少 dataUrl');
    const saved = await saveDataUrlImage(body.dataUrl);
    return send(res, 200, saved);
  }

  /* ---- 销售账号列表 ----
   * 只返回公开字段（不含密码记录）。登录页用它列出可选账号。
   * ⚠️ 这里刻意**不再提供**"直接切换当前身份"的端点：
   *    那等于给了一个无需密码就能变成任何人的后门，会让按 sales_id 的隔离失效。
   *    换身份一律走 POST /api/session（需密码）。
   */
  if (p === '/api/sales' && req.method === 'GET') {
    const me = await callerAccount(req);
    const all = await listSalesPublic();

    /**
     * 未登录只能拿到"够登录用"的最小信息。
     *
     * 登录页需要列出账号名（否则用户不知道自己的登录名是什么），
     * 但**邮箱与是否管理员都属于不该给未登录者看的信息**。
     * 只有管理员登录后才返回完整资料（他用这个做账号管理）。
     *
     * ⚠️ 注意这里是**白名单式**构造对象，不是删字段。
     *    一开始我写的是"返回 sales 全量、未登录时只过滤列表"，
     *    结果 `current` 字段把完整账号对象（含 admin 标记）一起带出去了。
     *    白名单式天然不会漏——将来给账号加字段也不会意外泄露。
     */
    if (canSeeAll(me)) {
      const cur = await currentSales();
      return send(res, 200, { sales: all, current: cur, scope: 'admin' });
    }
    const minimal = all
      .filter((x) => x.active !== false)      // 停用的账号不出现在登录列表里
      .map((x) => ({ name: x.name, display: x.display }));
    return send(res, 200, { sales: minimal, current: null, scope: 'login' });
  }

  /* ---- 账号管理（仅管理员） ---- */
  if (p === '/api/sales' && req.method === 'POST') {
    const me = await callerAccount(req);
    if (!canSeeAll(me)) return fail(res, 403, '只有管理员能新建账号');
    const body = await readBody(req);
    return send(res, 200, await createAccount(body));
  }

  /**
   * 账号管理：/api/sales/<登录名> 与 /api/sales/<登录名>/reset-password
   *
   * ⚠️ 必须排除 `current` 这类**保留名**。
   *    历史上有一个免密切换身份的端点 `/api/sales/current`（已移除）。
   *    如果这里不排除，路径里那段会被当成"登录名叫 current 的账号"，
   *    于是返回 403「只有管理员能管理账号」——看起来像权限问题，
   *    实际上是路由把保留字当成了账号名（实测踩过）。
   *    返回 404 才是诚实的：这个端点已经不存在了。
   */
  const RESERVED_SALES_PATHS = new Set(['current']);
  const salesMatch = /^\/api\/sales\/([^/]+?)(\/reset-password)?$/.exec(p);
  if (salesMatch && !RESERVED_SALES_PATHS.has(salesMatch[1])) {
    const me = await callerAccount(req);
    if (!canSeeAll(me)) return fail(res, 403, '只有管理员能管理账号');
    const target = decodeURIComponent(salesMatch[1]);
    const isReset = !!salesMatch[2];

    if (isReset && req.method === 'POST') {
      return send(res, 200, await resetPassword(target));
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, await updateAccount(target, body));
    }
    if (req.method === 'DELETE') {
      return send(res, 200, await deleteAccount(target));
    }
  }

  /* ---- 订单：**已移除服务端本地读写端点** ----
   *
   * 第 4 步之后订单的权威存储是 CouchDB，客户端通过 /api/sync/orders/* 同步，
   * 所以这里不再提供 /api/orders 的 CRUD。
   *
   * 移除的两个理由（第二个是安全问题）：
   *   1. 它们读的是本地 JSON（app/data/orders/），而订单早已迁到 CouchDB，
   *      会返回与服务端权威副本不一致的数据。
   *   2. **它们没有会话校验**——未登录就能拉到订单列表，
   *      绕过了 /api/sync 上的授权。这是个真实的安全缺口，不是风格问题。
   *
   * 前端也已改为只读本地 PouchDB（见 public/syncdb.mjs）。
   */

  /* ---- 画册 ---- */
  if (p === '/api/catalog/preview' && req.method === 'POST') {
    const body = await readBody(req);
    const { renderCatalogHtml } = await import('./render-catalog.mjs');
    const products = body.productIds?.length
      ? (await listProducts()).filter((x) => body.productIds.includes(x.id))
      : await listProducts();
    const settings = { ...(await getSettings()), ...(body.settings ?? {}) };
    const html = await renderCatalogHtml({
      products, settings, assetDir: ASSET_DIR,
      groupByCategory: !!body.groupByCategory,
    });
    return send(res, 200, { html, count: products.length });
  }

  if (p === '/api/catalog/pdf' && req.method === 'POST') {
    const body = await readBody(req);
    const { renderCatalogHtml, renderCatalogPdf, assertLayout } = await import('./render-catalog.mjs');

    let puppeteer;
    try {
      puppeteer = (await import('puppeteer')).default;
    } catch {
      return fail(res, 501,
        '未安装 puppeteer，无法在服务端生成 PDF。' +
        '可改用「在浏览器中打印为 PDF」，或安装 puppeteer 依赖。');
    }

    const products = await listProducts();
    if (!products.length) return fail(res, 400, '没有产品，无法生成画册');
    const settings = { ...(await getSettings()), ...(body.settings ?? {}) };

    const html = await renderCatalogHtml({
      products, settings, assetDir: ASSET_DIR,
      groupByCategory: !!body.groupByCategory,
    });

    // 先断言分页不溢出，避免产出被静默裁掉内容的画册
    const layout = await assertLayout(html, puppeteer);
    if (!layout.ok) {
      const bad = layout.pages.filter((x) => x.overflowing);
      return send(res, 422, {
        error: `分页溢出：${bad.length} 页超过 A4 高度，打印会丢失内容`,
        hint: '请减少每页产品数，或缩短规格文字',
        pages: layout.pages,
      });
    }

    await fs.mkdir(EXPORT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outPath = path.join(EXPORT_DIR, `catalog-${stamp}.pdf`);
    const result = await renderCatalogPdf(html, puppeteer, outPath);
    const fileName = path.basename(result.pdfPath);
    return send(res, 200, {
      fileName,
      downloadUrl: `/exports/${encodeURIComponent(fileName)}`,
      sizeKB: result.sizeKB,
      pages: layout.pages.length,
      layout: layout.pages,
    });
  }

  return fail(res, 404, '接口不存在');
}

/* ------------------------------------------------------------------ *
 * 静态文件
 * ------------------------------------------------------------------ */
async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);

  // 导出的 PDF
  if (rel.startsWith('/exports/')) {
    const file = safeJoin(EXPORT_DIR, rel.slice('/exports/'.length));
    if (!file) return fail(res, 403, '非法路径');
    try {
      const buf = await fs.readFile(file);
      return send(res, 200, buf, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(file))}"`,
      });
    } catch {
      return fail(res, 404, '文件不存在');
    }
  }

  // 第三方静态资源（白名单）
  if (rel.startsWith('/vendor/')) {
    const name = path.posix.basename(rel);
    if (!VENDOR_ALLOW.has(name)) return fail(res, 404, '资源不存在');
    try {
      const buf = await fs.readFile(path.join(VENDOR_DIR, name));
      return send(res, 200, buf, {
        'Content-Type': MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      });
    } catch {
      return fail(res, 404, `缺少 ${name}，请运行 node tools/vendor-pouchdb.mjs`);
    }
  }

  // 产品图片
  if (rel.startsWith('/assets/')) {
    const file = safeJoin(ASSET_DIR, rel.slice('/assets/'.length));
    if (!file) return fail(res, 403, '非法路径');
    try {
      const buf = await fs.readFile(file);
      return send(res, 200, buf, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=3600',
      });
    } catch {
      return fail(res, 404, '图片不存在');
    }
  }

  if (rel === '/') rel = '/index.html';
  const file = safeJoin(PUBLIC_DIR, rel);
  if (!file) return fail(res, 403, '非法路径');
  try {
    const buf = await fs.readFile(file);
    return send(res, 200, buf, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
  } catch {
    return fail(res, 404, '页面不存在');
  }
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (err) {
    const status = err.status ?? 500;
    if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, err);
    return fail(res, status, err.message);
  }
});

// 首次启动自动初始化数据目录（§2b.5 第 3 条：不让人手工建目录/写配置）
async function bootstrap() {
  await fs.mkdir(ASSET_DIR, { recursive: true });
  await fs.mkdir(EXPORT_DIR, { recursive: true });
  await getSettings();          // 不存在时返回默认值

  // 首次运行会为每个账号生成随机初始密码；这里打印一次（不写入任何日志文件）
  const [products, sales, cur] = await Promise.all([listProducts(), listSalesPublic(), currentSales()]);
  const initial = takeStartupNotice();

  // 同步层自检：等 CouchDB、建库、写设计文档。
  // 失败要明确报错并退出——同步不可用却装作可用，比直接失败更危险。
  let syncState = null;
  if (process.env.SKIP_SYNC_BOOTSTRAP === '1') {
    console.log('  ⚠️  已按 SKIP_SYNC_BOOTSTRAP=1 跳过同步层自检（仅用于离线开发）');
  } else {
    syncState = await ensureCouchReady({ log: (m) => console.log(m) });
  }

  console.log('');
  console.log('  家具经销商 · 电子画册与开单工具');
  console.log('  ────────────────────────────────────────');
  console.log(`  监听地址：  http://${HOST}:${PORT}`);
  console.log(`  产品：${products.length} 款    销售账号：${sales.length} 个`);
  console.log(`  数据目录：${paths.DATA_DIR}`);

  if (syncState) {
    console.log(`  同步枢纽：${couchConfig.base}  数据库 ${syncState.db}  CouchDB ${syncState.version}`);
  }

  if (initial.length) {
    console.log('');
    console.log('  ⚠️  首次运行，已生成初始密码（**只显示这一次，请立即记下**）：');
    for (const x of initial) {
      console.log(`        ${x.name.padEnd(8)} ${x.password}      （${x.display}）`);
    }
    console.log('     首次登录后会要求修改密码。');
    console.log('     这张表不会再次打印；忘了只能删掉 data/sales.json 重新初始化。');
  }

  if (cur) console.log(`\n  上次使用的账号：${cur.display ?? cur.name}（需密码登录）`);
  console.log('');
}

server.listen(PORT, HOST, () => {
  bootstrap().catch((e) => {
    console.error('\n启动失败：', e.message);
    process.exit(1);
  });
});
