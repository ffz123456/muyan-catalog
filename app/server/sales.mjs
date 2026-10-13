/**
 * 销售人员 —— 身份与归属的唯一来源
 *
 * `sales_id` 是订单的隔离键，所以**登录名就是归属名**，两者不能是两套东西。
 *
 * 认证方式（本次升级）：
 *   改为**密码登录**。在此之前是"选名字即进入"，任何人都能选别人的名字开单，
 *   而订单正是按这个名字隔离的——隔离可以被绕过，等于没有隔离。
 *
 * 首次使用：系统会为每个账号生成随机初始密码并标记"必须改密"，
 *   初始密码打印在服务端启动日志里（一次性），首次登录后强制修改。
 *   生产部署应改成由管理员在界面上重置。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { hashPassword, verifyPassword, needsPassword, generateInitialPassword } from './password.mjs';
import { DATA_DIR, SALES_FILE, CURRENT_FILE } from './datadir.mjs';

/** 内置账号。密码在首次初始化时随机生成。 */
const BUILTIN_SALES = [
  { name: 'admin', display: '管理者', admin: true },
  { name: 'alice', display: '销售 A' },
  { name: 'bob', display: '销售 B' },
];

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    /**
     * ⚠️ 损坏时**不要抛错让服务起不来**，而是备份证据 + 警告 + 当作缺失继续。
     *
     * 实测教训：current-sales.json 只是"记住上次用谁"的便利文件，
     * 在一次写入被打断后变成了一片空格，结果**整个服务启动失败**。
     * 一个非关键文件不该有这个能力。
     * 原子写入（写临时文件再 rename）能防住大部分情况，但进程被强杀时
     * 目标文件仍可能被替换成空内容，所以读取侧必须有兜底。
     */
    const bak = `${file}.corrupt-${Date.now()}`;
    try {
      await fs.rename(file, bak);
      console.warn(`[数据] ${path.basename(file)} 内容损坏，已备份为 ${path.basename(bak)} 并重建。原因：${err.message}`);
    } catch (e2) {
      console.warn(`[数据] ${path.basename(file)} 内容损坏且备份失败：${e2.message}`);
    }
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

/** 初始化时生成的初始密码，仅在启动日志里展示一次，不写入任何日志文件。 */
let startupNotice = [];

export function takeStartupNotice() {
  const n = startupNotice;
  startupNotice = [];
  return n;
}

/**
 * 读取销售人员（内部函数，**含密码记录，不可直接发给客户端**）。
 *
 * 首次调用会创建内置账号并生成随机初始密码。
 *
 * ⚠️ 用单一 promise 串行化：初始化涉及"文件不存在则创建 + 随机生成密码"，
 *    若两个调用并发进来（例如启动时 Promise.all 里同时取账号列表和当前账号），
 *    会各自创建一遍、后写的覆盖先写的，导致**打印出来的初始密码是失效的那一组**
 *    （实测踩过：日志里每个账号出现两个密码，第一个是错的）。
 */
let salesCache = null;

export function listSales() {
  if (!salesCache) {
    salesCache = loadOrInitSales().catch((err) => {
      salesCache = null;      // 失败后允许重试
      throw err;
    });
  }
  return salesCache;
}

/** 账号有变更（改密、增删）后调用，让下次读取重新加载。 */
export function invalidateSalesCache() {
  salesCache = null;
}

async function loadOrInitSales() {
  const doc = await readJson(SALES_FILE, null);
  if (doc === null) {
    const created = BUILTIN_SALES.map((s) => {
      const pw = generateInitialPassword();
      startupNotice.push({ name: s.name, display: s.display, password: pw });
      return {
        ...s,
        active: true,
        password: hashPassword(pw),
        must_change_password: true,
        created_at: new Date().toISOString(),
      };
    });
    await writeJsonAtomic(SALES_FILE, { sales: created });
    return created;
  }

  const sales = doc.sales ?? [];
  /**
   * 兼容旧数据，补齐后来才加的字段。
   *
   * 补 `active: true` 是**显式表达"未停用"**：
   * 判定逻辑本来就是"只有明确 false 才算停用"，所以功能上不补也对。
   * 但数据文件里看不出来就成了隐患——管理员打开文件排查时，
   * 分不清"这个账号是启用状态"还是"这个字段漏了"。
   */
  let patched = false;
  for (const s of sales) {
    if (needsPassword(s.password)) {
      const pw = generateInitialPassword();
      s.password = hashPassword(pw);
      s.must_change_password = true;
      startupNotice.push({ name: s.name, display: s.display, password: pw });
      patched = true;
    }
    if (s.active === undefined) { s.active = true; patched = true; }
  }
  if (patched) await writeJsonAtomic(SALES_FILE, { sales });
  return sales;
}

export async function saveSales(sales) {
  await writeJsonAtomic(SALES_FILE, { sales });
  invalidateSalesCache();
  return sales;
}

export async function findSales(name) {
  const sales = await listSales();
  return sales.find((s) => s.name === name) ?? null;
}

/* ------------------------------------------------------------------ *
 * 账号管理（只有管理员可用；权限判定在 server/index.mjs 做）
 * ------------------------------------------------------------------ */

/** 登录名规则：小写字母、数字、下划线、连字符；2–32 位。 */
const NAME_RE = /^[a-z0-9_-]{2,32}$/;

/** 极简校验：只挡明显错的，不做严格 RFC 校验（避免把能用的邮箱挡掉）。 */
const looksLikeEmail = (v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/**
 * 新建账号。只有管理员能调用。
 *
 * 返回里的 `initialPassword` **只出现这一次**：库里只存哈希，
 * 之后再也拿不回来。界面上要提示管理员当场记下或直接念给对方。
 *
 * 账号上**没有手机号字段**：本项目的密码找回走"管理员重置"，
 * 不做短信验证码（需要短信网关与企业资质，自部署场景不现实）。
 * 留一个用不上的字段只会让人困惑"这要填吗"。
 * （订单上的 `customer_phone` 是另一回事——那是客户联系方式，属订单内容。）
 */
export async function createAccount({ name, display, email, admin = false }) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!NAME_RE.test(n)) {
    throw Object.assign(new Error('登录名只能用 2–32 位小写字母、数字、下划线或连字符'), { status: 400 });
  }
  if (!looksLikeEmail(email)) throw Object.assign(new Error('邮箱格式不对'), { status: 400 });

  const sales = await listSales();
  if (sales.some((s) => s.name === n)) {
    throw Object.assign(new Error(`登录名「${n}」已被占用`), { status: 409 });
  }

  const pw = generateInitialPassword();
  const created = {
    name: n,
    display: String(display ?? '').trim() || n,
    admin: !!admin,
    active: true,
    email: String(email ?? '').trim() || null,
    password: hashPassword(pw),
    must_change_password: true,     // 首次登录强制改密
    created_at: new Date().toISOString(),
  };
  await saveSales([...sales, created]);
  return { account: publicView(created), initialPassword: pw };
}

/**
 * 修改账号资料（不改密码）。
 *
 * ⚠️ 有一条安全约束：**不能把最后一个可用管理员停用或降级**。
 *    否则一旦唯一的 admin 被改成普通销售，就再也没人能管理账号了，
 *    而且没有任何界面能救回来（只能手工改数据文件）。
 */
export async function updateAccount(name, patch = {}) {
  const sales = await listSales();
  const idx = sales.findIndex((s) => s.name === name);
  if (idx === -1) throw Object.assign(new Error('账号不存在'), { status: 404 });

  const cur = sales[idx];
  // 以 publicView 为基准：这样 `active` 在内部也始终是显式布尔值，
  // 不会出现"undefined 与 false 混用"的边界问题
  const next = { ...cur, ...publicView(cur) };

  if (patch.display !== undefined) next.display = String(patch.display).trim() || next.name;
  if (patch.email !== undefined) {
    if (!looksLikeEmail(patch.email)) throw Object.assign(new Error('邮箱格式不对'), { status: 400 });
    next.email = String(patch.email).trim() || null;
  }
  if (patch.admin !== undefined) next.admin = !!patch.admin;
  if (patch.active !== undefined) next.active = !!patch.active;

  // 安全约束：必须始终至少有一个"可用的管理员"
  const wouldLoseAdmin = (cur.admin && cur.active !== false)
    && (!next.admin || next.active === false);
  if (wouldLoseAdmin) {
    const otherAdmins = sales.filter((s, i) => i !== idx && s.admin && s.active !== false);
    if (!otherAdmins.length) {
      throw Object.assign(
        new Error('这是最后一个可用的管理员，不能停用或降级——否则没人能再管理账号'),
        { status: 400 },
      );
    }
  }

  const out = sales.map((s, i) => (i === idx ? next : s));
  await saveSales(out);
  return publicView(next);
}

/**
 * 管理员重置他人密码。
 *
 * 为什么必须有它：用户忘了密码时，如果没有这个功能，
 * 唯一的办法是删掉整个账号数据文件——那会把**所有账号**一起重置。
 *
 * 重置后强制改密，且新密码只在返回值里出现一次。
 */
export async function resetPassword(name) {
  const sales = await listSales();
  const idx = sales.findIndex((s) => s.name === name);
  if (idx === -1) throw Object.assign(new Error('账号不存在'), { status: 404 });

  const pw = generateInitialPassword();
  const next = {
    ...sales[idx],
    password: hashPassword(pw),
    must_change_password: true,
    password_reset_at: new Date().toISOString(),
  };
  await saveSales(sales.map((s, i) => (i === idx ? next : s)));
  return { account: publicView(next), temporaryPassword: pw };
}

/**
 * 删除账号。
 *
 * ⚠️ 只删账号本身，**不动他名下的订单**——订单是经营凭证。
 *    删掉账号后那些订单仍在库里，只是没人能登录查看，需要管理员处置。
 */
export async function deleteAccount(name) {
  const sales = await listSales();
  const target = sales.find((s) => s.name === name);
  if (!target) throw Object.assign(new Error('账号不存在'), { status: 404 });

  const remaining = sales.filter((s) => s.name !== name);
  if (!remaining.length) throw Object.assign(new Error('至少要保留一个账号'), { status: 400 });
  if (target.admin && !remaining.some((s) => s.admin && s.active !== false)) {
    throw Object.assign(new Error('这是最后一个管理员，不能删除'), { status: 400 });
  }

  await saveSales(remaining);
  return { deleted: name, ordersKept: true };
}

/**
 * 校验账号密码。
 * @returns {{ok:true, sales:object} | {ok:false, reason:string}}
 */
export async function authenticate(name, password) {
  const sales = await listSales();
  const found = sales.find((s) => s.name === name);
  if (!found) return { ok: false, reason: '账号或密码不正确' };
  if (!verifyPassword(password, found.password)) {
    return { ok: false, reason: '账号或密码不正确' };
  }
  /**
   * 停用的账号不能登录。
   *
   * 顺序很重要：**先验密码再看是否停用**。
   * 反过来的话，用"账号已停用"这条提示就能试出哪些账号存在。
   * 现在停用账号的提示与密码错误不同，但只有**已经知道正确密码**的人
   * 才会看到它——这个信息泄露是必要代价，否则被停用的人会一头雾水。
   */
  if (found.active === false) {
    return { ok: false, reason: '这个账号已停用，请联系管理员' };
  }
  return { ok: true, sales: publicView(found) };
}

/** 修改自己的密码。必须先验证旧密码。 */
export async function changePassword(name, oldPassword, newPassword) {
  const sales = await listSales();
  const idx = sales.findIndex((s) => s.name === name);
  if (idx === -1) throw Object.assign(new Error('账号不存在'), { status: 404 });
  const s = sales[idx];

  if (!verifyPassword(oldPassword, s.password)) {
    throw Object.assign(new Error('原密码不正确'), { status: 403 });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    throw Object.assign(new Error('新密码至少 6 位'), { status: 400 });
  }
  if (newPassword === oldPassword) {
    throw Object.assign(new Error('新密码不能与原密码相同'), { status: 400 });
  }

  // 复制一份再改：listSales() 返回的是缓存引用，
  // 直接改会把"未落盘的中间状态"留在缓存里
  const next = sales.map((x, i) => (i === idx
    ? {
      ...x,
      password: hashPassword(newPassword),
      must_change_password: false,
      password_changed_at: new Date().toISOString(),
    }
    : x));
  await saveSales(next);
  return publicView(next[idx]);
}

/** 对外视图：绝不把密码记录发给客户端。 */
export function publicView(s) {
  if (!s) return null;
  const { password, ...rest } = s;
  void password;
  /**
   * `active` 一律显式给布尔值。
   * 判定逻辑本来就是"只有明确 false 才算停用"，
   * 所以 undefined 与 true 等价；但对客户端来说，
   * 拿到 undefined 就得自己猜默认值，容易各写一套。
   */
  return { ...rest, active: rest.active !== false };
}

export async function listSalesPublic() {
  const sales = await listSales();
  return sales.map(publicView);
}

/** 当前登录的销售（服务端"记住上次"用；权限判定一律以会话为准）。 */
export async function currentSales() {
  const sales = await listSales();
  const cur = await readJson(CURRENT_FILE, null);
  if (cur?.name) {
    const found = sales.find((s) => s.name === cur.name);
    if (found) return publicView(found);
  }
  return publicView(sales[0]) ?? null;
}

export async function setCurrentSales(name) {
  const found = await findSales(name);
  if (!found) throw Object.assign(new Error(`没有这个销售：${name}`), { status: 404 });
  await writeJsonAtomic(CURRENT_FILE, { name: found.name, since: new Date().toISOString() });
  return publicView(found);
}

/**
 * 解析订单归属。
 *
 * ⚠️ 只接受服务端认证身份。`explicit` 参数保留是为了兼容既有调用点，
 *    但**不再被信任**——客户端能传的名字一律忽略。
 */
export async function resolveSalesId(explicit) {
  void explicit;
  const cur = await currentSales();
  if (!cur) throw Object.assign(new Error('没有可用的销售账号'), { status: 400 });
  return cur.name;
}

export const paths = { SALES_FILE, CURRENT_FILE };
