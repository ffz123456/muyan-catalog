/**
 * 种子数据：导入一份示例产品与图片到 app/data/
 *
 * 为什么需要：工具第一次打开时应该是"有东西可看"的，而不是空列表。
 * 对不想学、不想看说明书的用户，空白页等于"这东西坏了"。
 *
 * 图片素材有三个来源，按顺序找：
 *   1. app/assets/sample-assets/ —— **随镜像分发**（容器部署用这个）
 *   2. app/data/sample-assets/   —— 本机开发
 *   3. ../catalog/assets/        —— 画册验证工程里的素材
 * 这样在只有 app/ 的容器里也能种出带图的示例数据。
 *
 * ⚠️ 容器里素材**不能**放在 data/ 下：那个目录会被数据卷挂载覆盖，
 *    镜像里放进去的文件在运行时看不见（实测踩过）。
 *
 * 运行：node tools/seed-sample-data.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const HERE = import.meta.dirname;
const APP_DIR = path.join(HERE, '..');
const CATALOG_DIR = path.join(APP_DIR, '..', 'catalog');

const ASSET_DIR = path.join(APP_DIR, 'data', 'assets');
const DATA_DIR = path.join(APP_DIR, 'data');
/** 随镜像分发的素材位置（不受数据卷影响） */
const BUILTIN_ASSETS = path.join(APP_DIR, 'assets', 'sample-assets');
/** 本机开发时可能在这里 */
const DEV_ASSETS = path.join(DATA_DIR, 'sample-assets');

/** 内置的产品样本数据。容器里没有 catalog/ 时用它。 */
const BUILTIN_PRODUCTS = [
  { name: '云舒三人布艺沙发', category: '客厅 · 沙发', price: 4380, image: 'sofa.png',
    specs: '尺寸 2200×950×820mm / 材质 科技布 · 高回弹海绵 / 框架 实木',
    highlights: '可拆洗 / 三年质保 / 含两个抱枕', stockStatus: '现货' },
  { name: '白蜡木实木茶几', category: '客厅 · 茶几', price: 1680, image: 'coffee-table.png',
    specs: '尺寸 1200×600×450mm / 材质 北美白蜡木 / 表面 木蜡油',
    highlights: '双层收纳 / 圆角防磕碰', stockStatus: '现货' },
  { name: '黑胡桃玻璃展示柜', category: '餐厅 · 边柜', price: 3260, image: 'curio-cabinet.png',
    specs: '尺寸 900×420×1800mm / 材质 黑胡桃实木 / 门板 钢化玻璃',
    highlights: '三层可调隔板 / 防倾倒设计', stockStatus: '定制 15 天' },
  { name: '橡木伸缩餐桌（一桌四椅）', category: '餐厅 · 餐桌椅', price: 5980, image: 'dining-set.png',
    specs: '尺寸 1400-1800×800×750mm / 材质 白橡木 / 伸缩 40cm',
    highlights: '可坐 4-6 人 / 含四把配套餐椅', stockStatus: '现货' },
  { name: '榉木落地衣帽架', category: '卧室 · 衣帽架', price: 458, image: 'coat-rack.png',
    specs: '尺寸 420×420×1750mm / 材质 榉木 / 承重 15kg',
    highlights: '八爪底座 / 免工具安装', stockStatus: '现货' },
];

const BUILTIN_META = {
  companyName: '示例家居',
  tagline: '2026 春季新品画册 · 全屋定制系列',
};

/** 找素材目录：优先随镜像分发的，其次开发位置的，最后画册验证工程 */
async function resolveAssetSource(fileName) {
  for (const dir of [BUILTIN_ASSETS, DEV_ASSETS, path.join(CATALOG_DIR, 'assets')]) {
    const p = path.join(dir, fileName);
    try {
      await fs.access(p);
      return p;
    } catch { /* 换下一个 */ }
  }
  return null;
}

/** 读样本数据：有 catalog 用它的，否则用内置的 */
async function loadSample() {
  try {
    const p = path.join(CATALOG_DIR, 'data', 'products.sample.json');
    const raw = JSON.parse(await fs.readFile(p, 'utf-8'));
    if (Array.isArray(raw.products) && raw.products.length) return raw;
  } catch { /* 用内置 */ }
  return { meta: BUILTIN_META, products: BUILTIN_PRODUCTS };
}

async function main() {
  const sample = await loadSample();

  await fs.mkdir(ASSET_DIR, { recursive: true });

  const products = [];
  let missingImages = 0;
  for (const p of sample.products) {
    // 文件名可能在 p.image（catalog 格式）或 p.image（内置格式），统一处理
    const imgName = path.basename(p.image ?? '');
    const srcImg = imgName ? await resolveAssetSource(imgName) : null;

    let newName = null;
    if (srcImg) {
      const ext = path.extname(srcImg);
      newName = `img_${crypto.randomBytes(8).toString('hex')}${ext}`;
      try {
        await fs.copyFile(srcImg, path.join(ASSET_DIR, newName));
      } catch (err) {
        console.warn(`  ⚠ 图片复制失败（${p.name}）：${err.message}`);
        newName = null;
      }
    }
    if (!newName) {
      missingImages++;
      console.warn(`  ⚠ 找不到图片素材：${imgName || '(未指定)'}（${p.name}）`);
    }

    const now = new Date().toISOString();
    products.push({
      id: `p_${crypto.randomBytes(6).toString('hex')}`,
      name: p.name,
      category: p.category ?? '未分类',
      specs: p.specs ?? '',
      highlights: p.highlights ?? '',
      price: Number(p.price) || 0,
      stockStatus: p.stockStatus ?? '现货',
      supplier: '广东佛山厂',
      images: [newName],
      created_at: now,
      updated_at: now,
    });
  }

  await fs.writeFile(
    path.join(DATA_DIR, 'products.json'),
    JSON.stringify({ products }, null, 2),
    'utf-8',
  );

  await fs.writeFile(
    path.join(DATA_DIR, 'settings.json'),
    JSON.stringify({
      companyName: sample.meta?.companyName ?? BUILTIN_META.companyName,
      tagline: sample.meta?.tagline ?? BUILTIN_META.tagline,
      logo: null,
      contact: '电话 138-0000-0000 · 微信 linshi-jiaju',
      currency: 'CNY',
      priceNote: '含税',
      validityDays: 30,
    }, null, 2),
    'utf-8',
  );

  console.log(`✓ 已导入 ${products.length} 款产品`);
  if (missingImages) console.log(`  （其中 ${missingImages} 款没有图片素材，画册里会显示"暂无图片"）`);
  console.log(`  产品数据：${path.relative(APP_DIR, path.join(DATA_DIR, 'products.json'))}`);
  console.log(`  图片目录：${path.relative(APP_DIR, ASSET_DIR)}`);
}

main().catch((e) => {
  console.error('导入失败：', e.message);
  process.exit(1);
});
