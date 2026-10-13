/**
 * 数据目录 —— **唯一来源**
 *
 * 为什么单独成文件：
 *   原来 5 个模块各自写了一遍 `path.join(import.meta.dirname, '..', 'data')`。
 *   要支持"数据跟着程序包走"（便携版必需）就得改 5 处——
 *   漏一处，那个模块的数据就会悄悄写到包里别的位置，
 *   而且**不会报错**，只是重启后数据不见了。
 *
 * 打成一个 exe 分发时，代码在 exe 里、数据必须写在 exe 旁边，
 * 所以这里优先读环境变量 FS_DATA_ROOT（由启动壳设置）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 代码所在目录（app/server）。 */
const HERE = import.meta.dirname;

/**
 * 数据根目录。
 *
 * 优先级：
 *   1. `FS_DATA_ROOT`（便携版的启动壳会设成 exe 所在目录）
 *   2. 默认：代码旁边的 app/data（本机开发、Docker 部署都是这个）
 */
export const DATA_ROOT = process.env.FS_DATA_ROOT
  ? path.resolve(process.env.FS_DATA_ROOT)
  : path.join(HERE, '..');

export const DATA_DIR = path.join(DATA_ROOT, 'data');
export const ASSET_DIR = path.join(DATA_DIR, 'assets');
export const EXPORT_DIR = path.join(DATA_DIR, 'exports');
export const ORDERS_DIR = path.join(DATA_DIR, 'orders');

export const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const SALES_FILE = path.join(DATA_DIR, 'sales.json');
export const CURRENT_FILE = path.join(DATA_DIR, 'current-sales.json');

/** 临时文件目录（浏览器 profile、画册预览 HTML 等）。 */
export const TMP_DIR = path.join(DATA_DIR, '.tmp');

/** 确保目录存在。启动时调一次即可。 */
export function ensureDirsSync() {
  for (const d of [DATA_DIR, ASSET_DIR, EXPORT_DIR, ORDERS_DIR, TMP_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export const paths = {
  DATA_ROOT, DATA_DIR, ASSET_DIR, EXPORT_DIR, ORDERS_DIR, TMP_DIR,
  PRODUCTS_FILE, SETTINGS_FILE, SALES_FILE, CURRENT_FILE,
};
