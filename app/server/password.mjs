/**
 * 密码哈希 —— 用 Node 内置 scrypt，不引入任何依赖
 *
 * 为什么要做这一层：
 *   在此之前登录是"选个名字即进入"，**任何人都能选别人的名字开单**，
 *   而订单正是按这个名字隔离的——隔离可以被绕过，等于没有隔离。
 *   报价与客户是销售各自的业务资源，必须凭密码才能进入。
 *
 * 存储格式（sales.json 里的 password 字段）：
 *   { algo: 'scrypt', N, r, p, salt, hash }
 * 绝不存明文，也绝不打印到日志。
 */
import crypto from 'node:crypto';

const N = 16384;      // CPU/内存代价
const r = 8;
const p = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

/** 生成密码记录。 */
export function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 6) {
    throw Object.assign(new Error('密码至少 6 位'), { status: 400 });
  }
  const salt = crypto.randomBytes(SALT_LEN);
  const hash = crypto.scryptSync(plain, salt, KEY_LEN, { N, r, p });
  return {
    algo: 'scrypt', N, r, p,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
  };
}

/**
 * 校验密码。用 timingSafeEqual 做恒定时间比较，避免按字符逐位试探。
 * 记录缺失或格式不对时一律返回 false，不抛错（避免泄露"这个账号存在"）。
 */
export function verifyPassword(plain, record) {
  if (!record || record.algo !== 'scrypt' || !record.salt || !record.hash) return false;
  if (typeof plain !== 'string' || !plain) return false;
  try {
    const salt = Buffer.from(record.salt, 'base64');
    const expected = Buffer.from(record.hash, 'base64');
    const actual = crypto.scryptSync(plain, salt, expected.length, {
      N: record.N ?? N, r: record.r ?? r, p: record.p ?? p,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** 该账号是否还没设过密码（需要引导设置）。 */
export function needsPassword(record) {
  return !record || record.algo !== 'scrypt';
}

/**
 * 生成一个随机初始密码（给人念得出来的形式，便于口头交接）。
 * 只在首次创建账号时用一次。
 */
export function generateInitialPassword() {
  // 去掉容易混淆的 0/O/1/l/I
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  return Array.from(bytes).map((b) => alphabet[b % alphabet.length]).join('');
}
