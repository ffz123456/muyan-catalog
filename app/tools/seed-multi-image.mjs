/**
 * 造假数据：不同图片数量的产品，用来验多图排版。
 *
 * 图片数量覆盖：0 / 1 / 2 / 4 / 5 / 12 / 20
 *   0 张 → 占位
 *   1 张 → 没有小图条（最矮）
 *   2-4 张 → 有小图条（最高）
 *   5-20 张 → 小图条只显示 4 张，高度必须和不加时一样
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ASSET_DIR, PRODUCTS_FILE } from '../server/datadir.mjs';

const APP = path.join(import.meta.dirname, '..');
const sample = await fs.readFile(path.join(APP, 'assets', 'sample-assets', 'sofa.png'));

const counts = [0, 1, 2, 4, 5, 12, 20];
const products = [];

await fs.mkdir(ASSET_DIR, { recursive: true });

for (let i = 0; i < counts.length; i++) {
  const imgs = [];
  for (let j = 0; j < counts[i]; j++) {
    const n = `mi_${i}_${j}.png`;
    await fs.writeFile(path.join(ASSET_DIR, n), sample);
    imgs.push(n);
  }
  products.push({
    id: `mi${i}`,
    name: `多图测试产品 ${counts[i]} 张图`,
    category: '客厅 · 沙发',
    specs: '尺寸 2200×950×820mm，科技布，实木框架',
    highlights: '可拆洗 / 三年质保 / 现货',
    price: 4380,
    stockStatus: '现货',
    supplier: '测试货源',
    images: imgs,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

await fs.writeFile(PRODUCTS_FILE, JSON.stringify({ products }, null, 2), 'utf-8');

console.log(`  ✓ 造了 ${products.length} 款产品`);
console.log(`    图片数：${counts.join(' / ')}`);
console.log(`    产品数据：${PRODUCTS_FILE}`);
console.log(`    图片目录：${ASSET_DIR}`);
