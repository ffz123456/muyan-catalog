/**
 * 内存与性能基准 —— 回答「用久了、图多了会不会卡」
 *
 * 为什么要写这个：这类问题**不能靠感觉答**。
 * "应该没问题"和"实测 200 款产品时内存涨到 800 MB"是完全不同的结论，
 * 而后者会直接决定要不要改架构。
 *
 * 关注的几条内存路径（先从代码里读出来的）：
 *   1. 启动时把 products.json 整个读进内存（无分页）
 *   2. 生成画册时**所有图片同时转成 data URI 并拼进一个大字符串**
 *   3. 服务端出 PDF 时，浏览器返回的 base64 再转回 Buffer
 *   4. 单机版导出备份时，所有图片转 data URI + JSON.stringify
 *
 * 其中 2 和 4 是**峰值**所在——它们会把"N 张图"同时变到内存里。
 *
 * 用法：node tools/bench-memory.mjs [产品数] [每款图片数]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const APP = path.join(import.meta.dirname, '..');

/**
 * ⚠️ 数据目录必须从 datadir.mjs 取，**不能自己拼 app/data**。
 *    第一版就是硬编码的，于是设了 FS_DATA_ROOT 之后
 *    写到了 app/data、读的是 <root>/data，读回来 0 款产品，
 *    报的还是"没有产品，无法生成画册"这种看不懂的错。
 *    这个项目为"数据目录只有一个来源"专门建了模块，别绕过它。
 */
const { DATA_DIR, ASSET_DIR, PRODUCTS_FILE: PRODUCTS } = await import('../server/datadir.mjs');

const N_PRODUCTS = Number(process.argv[2]) || 200;
const N_IMAGES = Number(process.argv[3]) || 2;

const ASSETS = ASSET_DIR;
const SAMPLE = path.join(APP, 'assets', 'sample-assets');

const mb = (n) => (n / 1024 / 1024).toFixed(1);
const rss = () => process.memoryUsage().rss;
const heap = () => process.memoryUsage().heapUsed;

/** 强制 GC（需要 --expose-gc；没有就退化为不回收）。 */
let gc = () => {};
try {
  if (global.gc) gc = global.gc;
  else {
    const v8 = require('node:v8');
    if (v8.setFlagsFromString) v8.setFlagsFromString('--expose-gc');
    if (global.gc) gc = global.gc;
  }
} catch { /* 没有就没有 */ }

async function main() {
  console.log('');
  console.log(`  基准：${N_PRODUCTS} 款产品 × 每款 ${N_IMAGES} 张图`);
  console.log('  ────────────────────────────────────────');

  /* ---------- 准备素材：把示例图复制成很多份 ---------- */
  await fs.mkdir(ASSETS, { recursive: true });
  const samples = (await fs.readdir(SAMPLE)).filter((f) => f.endsWith('.png'));
  if (!samples.length) {
    console.error('  ✗ 找不到示例素材，先跑 node tools/seed-sample-data.mjs');
    process.exit(1);
  }
  const sampleBuf = await fs.readFile(path.join(SAMPLE, samples[0]));
  console.log(`  单张素材：${samples[0]}  ${mb(sampleBuf.length)} MB`);

  /* ---------- 准备素材：把示例图放大到接近真实压缩后的体积 ----------
   *
   * ⚠️ 第一版我"把 PNG 字节拼接后截断、存成 .jpg"——
   *    那不是合法 JPEG，浏览器解不出来，**渲染出的 HTML 里根本没有图**。
   *    体积对了、内存数字也"看起来对"，但测的是错的东西。
   *
   *    现在：直接复制真实的示例 PNG（合法图片），
   *    通过拼接得到接近目标体积的**真实可解码**文件。
   *    扩展名与内容一致（.png）。
   */
  const TARGET_KB = Number(process.env.TARGET_IMG_KB) || 300;
  const per = Math.max(1, Math.round(TARGET_KB * 1024 / sampleBuf.length));

  const products = [];
  const t0 = Date.now();

  console.log(`  目标单张体积：约 ${TARGET_KB} KB（示例图 ${(sampleBuf.length / 1024).toFixed(0)} KB × ${per}）`);

  for (let i = 0; i < N_PRODUCTS; i++) {
    const images = [];
    for (let j = 0; j < N_IMAGES; j++) {
      const name = `bench-${i}-${j}.png`;
      const f = path.join(ASSETS, name);
      let buf = Buffer.alloc(0);
      for (let k = 0; k < per; k++) buf = Buffer.concat([buf, sampleBuf]);
      await fs.writeFile(f, buf);
      images.push(name);
    }
    products.push({
      id: `p_bench${String(i).padStart(4, '0')}`,
      name: `基准产品 ${i + 1}`,
      category: ['客厅', '餐厅', '卧室', '书房'][i % 4],
      specs: '尺寸 2000×900×800mm，实木框架，可拆洗',
      highlights: '三年质保 / 现货 / 可定制',
      price: 1000 + i * 37,
      stockStatus: i % 3 === 0 ? '定制 15 天' : '现货',
      supplier: '基准货源',
      images,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  await fs.writeFile(PRODUCTS, JSON.stringify({ products }, null, 2), 'utf-8');
  const genMs = Date.now() - t0;

  const productsSize = (await fs.stat(PRODUCTS)).size;
  const assetsSize = (await fs.readdir(ASSETS)).length;
  let assetsBytes = 0;
  for (const f of await fs.readdir(ASSETS)) {
    assetsBytes += (await fs.stat(path.join(ASSETS, f))).size;
  }

  console.log('');
  console.log('  【磁盘占用】');
  console.log(`    图片文件：${assetsSize} 个，共 ${mb(assetsBytes)} MB`);
  console.log(`    产品元数据 products.json：${(productsSize / 1024).toFixed(0)} KB`);
  console.log(`    合计：${mb(assetsBytes + productsSize)} MB`);
  console.log(`    （造数据耗时 ${genMs} ms）`);

  gc();
  const rss0 = rss();
  const heap0 = heap();

  /* ---------- 1. 启动：读 products.json ---------- */
  const { listProducts } = await import('../server/store.mjs');
  const t1 = Date.now();
  const loaded = await listProducts();
  const loadMs = Date.now() - t1;
  gc();
  const rss1 = rss();
  const heap1 = heap();

  console.log('');
  console.log('  【启动 / 读产品列表】');
  console.log(`    产品数：${loaded.length}`);
  console.log(`    耗时：${loadMs} ms`);
  console.log(`    常驻内存(RSS)：${mb(rss0)} → ${mb(rss1)} MB   （+${mb(rss1 - rss0)}）`);
  console.log(`    堆(heapUsed)：${mb(heap0)} → ${mb(heap1)} MB   （+${mb(heap1 - heap0)}）`);
  console.log(`    每款产品元数据平均：${Math.round(productsSize / loaded.length)} 字节`);

  /* ---------- 2. 渲染画册：所有图片转 data URI ---------- */
  const { renderCatalogHtml } = await import('../server/render-catalog.mjs');
  const settings = { companyName: '基准公司', tagline: '内存测试', contact: '138', validityDays: 30 };

  let peakRss = rss();
  const timer = setInterval(() => { const r = rss(); if (r > peakRss) peakRss = r; }, 20);

  const t2 = Date.now();
  const html = await renderCatalogHtml({ products: loaded, settings, groupByCategory: false });
  const htmlMs = Date.now() - t2;
  clearInterval(timer);

  gc();
  const rss2 = rss();
  const heap2 = heap();

  console.log('');
  console.log('  【生成画册 HTML】← 这是内存峰值所在');
  console.log(`    耗时：${htmlMs} ms`);
  console.log(`    HTML 体积：${mb(html.length)} MB（${(html.length / 1024 / 1024).toFixed(2)}）`);
  console.log(`    常驻内存(RSS)：${mb(rss1)} → ${mb(rss2)} MB   （+${mb(rss2 - rss1)}）`);
  console.log(`    过程中峰值 RSS：${mb(peakRss)} MB   （比渲染前 +${mb(peakRss - rss1)}）`);
  console.log(`    堆(heapUsed)：${mb(heap1)} → ${mb(heap2)} MB   （+${mb(heap2 - heap1)}）`);

  /* ---------- 3. 页面数 ---------- */
  const pages = (html.match(/<section class="page"/g) ?? []).length;
  console.log(`    画册页数：${pages} 页（每页 4 款）`);

  /* ---------- 4. 模拟"单机版导出备份"的内存形状 ---------- */
  // 备份会把每张图变成 data URI（base64 比原始大 33%），再 JSON.stringify 一次
  const totalImgBytes = assetsBytes;
  const b64 = totalImgBytes * 4 / 3;
  const json = b64 * 1.05;                     // JSON 里的其他字段与转义
  console.log('');
  console.log('  【单机版导出备份的内存估算】');
  console.log(`    图片原始：${mb(totalImgBytes)} MB`);
  console.log(`    转成 data URI（base64 ×4/3）：${mb(b64)} MB`);
  console.log(`    JSON.stringify 再翻一倍：峰值约 ${mb(json * 2)} MB`);
  console.log('    ⚠️ 这一步会同时持有"原始 + base64 + JSON 字符串"三份');

  /* ---------- 结论 ---------- */
  console.log('');
  console.log('  ────────────────────────────────────────');
  const verdict = peakRss - rss1;
  console.log(`  渲染画册的峰值增量：${mb(verdict)} MB`);
  if (verdict > 500) console.log('  ⚠️ 偏高，产品数再多会出问题');
  else if (verdict > 200) console.log('  🟡 需要注意，但几百款产品内还行');
  else console.log('  ✅ 在合理范围');
  console.log('');
}

await main();
