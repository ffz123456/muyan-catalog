/**
 * 多图排版验证 —— 图片数量不设上限之后，画册还塞得进 A4 吗
 *
 * 为什么要专门测这个：
 *   画册每页固定 4 款，`.page` 用的是 `min-height`——
 *   内容超长会**静默撑高**，打印只取 A4 高度，**超出部分直接丢失且不报错**。
 *   这是这个项目踩过的坑（所以才有 assertLayout 逐页实测高度）。
 *
 *   加了"主图 + 小图条"之后卡片变高了，必须实测：
 *     0 张图   → 占位
 *     1 张图   → 没有小图条（最矮）
 *     2-4 张   → 有小图条（最高）
 *     5-20 张  → 小图条最多显示 4 张，高度**必须和不加时一样**
 *
 * 用法：node tools/verify-multi-image.mjs
 */
import path from 'node:path';
import { createSuite } from './assert-lib.mjs';

const APP = path.join(import.meta.dirname, '..');
const s = createSuite('多图排版验证');

async function main() {
  const { renderCatalogHtml } = await import('../server/render-catalog.mjs');
  const { launchBrowser } = await import('./browser.mjs');
  const { findBrowserExecutable } = await import('../server/browser.mjs');

  const { ASSET_DIR } = await import('../server/datadir.mjs');
  const fs = await import('node:fs/promises');

  // 造样例：图片数量拉到 20 张，验证小图条有上限
  const sample = await fs.readFile(path.join(APP, 'assets', 'sample-assets', 'sofa.png'));
  await fs.mkdir(ASSET_DIR, { recursive: true });

  const counts = [0, 1, 2, 4, 5, 12, 20];
  const products = [];
  for (let i = 0; i < counts.length; i++) {
    const imgs = [];
    for (let j = 0; j < counts[i]; j++) {
      const n = `mi_${i}_${j}.png`;
      await fs.writeFile(path.join(ASSET_DIR, n), sample);
      imgs.push(n);
    }
    products.push({
      id: `mi${i}`,
      name: `多图测试产品 ${counts[i]} 张`,
      category: '客厅 · 沙发',
      specs: '尺寸 2200×950×820mm，科技布，实木框架',
      highlights: '可拆洗 / 三年质保 / 现货',
      price: 4380,
      stockStatus: '现货',
      images: imgs,
    });
  }

  const settings = { companyName: '多图测试', tagline: '排版验证', contact: '138', validityDays: 30 };

  s.group('【1】生成画册');
  const html = await renderCatalogHtml({ products, settings, groupByCategory: false });
  s.check('能生成（图片数量不设上限也没报错）', html.length > 2000, `${html.length} 字符`);

  s.check('0 张图显示占位', html.includes('暂无图片'));
  s.check('多图的第 2 张进了小图条', html.includes('class="card-thumbs"'));

  /**
   * ⚠️ 数 class 时只数 **HTML 里用的**（`class="card-thumbs"`），
   *    不能数裸字符串 `card-thumbs`——CSS 里还有一条 `.card-thumbs {...}` 规则，
   *    那样会多算一次。我第一版就是这么写错的，结果断言数字对不上、
   *    报了 7 个（实际 5 个产品 + 1 条 CSS 规则 + 1 处别的匹配）。
   */
  const expectThumbs = counts.filter((c) => c >= 2).length;
  const thumbCount = (html.match(/class="card-thumbs"/g) ?? []).length;
  s.check(`有 ${expectThumbs} 款产品带小图条（图片数 ≥2）`, thumbCount === expectThumbs, `${thumbCount} 个`);

  const folded = (html.match(/class="thumbs-more"/g) ?? []).length;
  s.check('超过 4 张的多余部分被折叠', folded >= 1, `${folded} 处 +N 标记`);

  // 小图条里最多 4 张——再多在 A4 上糊成一团，看不清反而更糟
  const thumbImgs = (html.match(/<div class="card-thumbs">([\s\S]*?)<\/div>/g) ?? [])
    .map((b) => (b.match(/<img /g) ?? []).length);
  s.check('每款产品的小图不超过 4 张', thumbImgs.every((n) => n <= 4),
    thumbImgs.join('，'));

  /* ---------- 2. 逐页实测高度：这是关键 ---------- */
  s.group('【2】分页不溢出（打印不会丢内容）');
  const exe = findBrowserExecutable();
  if (!exe) {
    s.check('有浏览器可测高度', false, '找不到浏览器，无法实测——这一项不能跳过');
    return;
  }

  const puppeteerMod = await import('puppeteer-core').catch(() => null)
    ?? await import('puppeteer').catch(() => null);
  const puppeteer = puppeteerMod?.default ?? puppeteerMod;
  if (!puppeteer) {
    s.check('有 puppeteer 可测高度', false, '驱动不可用');
    return;
  }

  const { assertLayout, A4 } = await import('../server/render-catalog.mjs');
  const layout = await assertLayout(html, puppeteer, {
    launchOptions: { headless: true, executablePath: exe, args: ['--no-sandbox', '--disable-dev-shm-usage'] },
  });

  const bad = layout.pages.filter((p) => p.overflowing);
  s.check('每页都没超过 A4 高度', layout.ok,
    bad.length ? `${bad.length} 页溢出：${bad.map((b) => `第${b.page}页+${b.overflowPx}px`).join('，')}`
      : `${layout.pages.length} 页，最高 ${Math.max(...layout.pages.map((p) => p.heightPx))}px / A4 ${A4.H_PX}px`);

  // 报告最紧的那页，便于判断还有多少余量
  const tallest = layout.pages.reduce((a, b) => (b.heightPx > a.heightPx ? b : a), layout.pages[0]);
  s.info(`最紧的一页：第 ${tallest.page} 页 ${tallest.heightPx}px，余量 ${A4.H_PX - tallest.heightPx}px`);

  void launchBrowser;
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; console.error('\n运行中断：', e.message); }

const { failed } = s.summary();
if (crashed) {
  console.log(`\n脚本异常终止：${crashed.message}`);
  console.log(crashed.stack.split('\n').slice(0, 4).join('\n'));
}
process.exitCode = (failed.length || crashed) ? 1 : 0;
