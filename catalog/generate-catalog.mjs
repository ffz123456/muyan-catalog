/**
 * 画册生成验证 —— 第 2 步核心技术风险验证
 *
 * 目的：确认 pdf-catalog-generator + @react-pdf/renderer 能否满足中文家具画册。
 * 已知风险：@react-pdf/renderer 基于 pdfkit，默认字体不含 CJK 字形。
 *
 * 运行：node generate-catalog.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateProductCatalog } from 'pdf-catalog-generator';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, 'data', 'products.sample.json');
const OUT_DIR = path.join(HERE, 'out');
fs.mkdirSync(OUT_DIR, { recursive: true });

const sample = JSON.parse(fs.readFileSync(DATA, 'utf-8'));

/** 把本地图片读成 data URI —— 画册必须自包含，不能依赖远程图片。 */
function toDataUri(relPath) {
  const abs = path.join(HERE, relPath);
  if (!fs.existsSync(abs)) return null;
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return `data:image/${mime};base64,${buf.toString('base64')}`;
}

/** 把内部数据模型映射成库期望的字段名（库靠字段名识别渲染位置）。 */
function toLibraryProduct(p) {
  return {
    Title: p.name,
    Description: p.specs,
    Price: `¥${p.price.toLocaleString('zh-CN')}`,
    Image: toDataUri(p.image),
    // 以下为自定义字段，库会按字段名自动格式化标签
    品类: p.category,
    卖点: p.highlights,
    货期: p.stockStatus,
    编号: p.id,
  };
}

const products = sample.products.map(toLibraryProduct);
const missingImages = products.filter((p) => !p.Image).map((p) => p.编号);
if (missingImages.length) {
  console.warn(`警告：以下产品缺少图片，将使用占位图：${missingImages.join(', ')}`);
}

const templates = process.argv[2] ? [process.argv[2]] : ['template1', 'template2', 'template4'];

for (const template of templates) {
  const started = Date.now();
  try {
    const bytes = await generateProductCatalog({
      products,
      companyName: sample.meta.companyName,
      companyLogo: null,
      template,
    });

    const outFile = path.join(OUT_DIR, `catalog.${template}.pdf`);
    fs.writeFileSync(outFile, Buffer.from(bytes));
    console.log(`✓ ${template}  ${(bytes.length / 1024).toFixed(0)} KB  ${Date.now() - started}ms  -> ${path.relative(HERE, outFile)}`);
  } catch (err) {
    console.error(`✗ ${template} 失败：${err.message}`);
    console.error(err.stack?.split('\n').slice(1, 5).join('\n'));
  }
}

console.log('\n完成。');
