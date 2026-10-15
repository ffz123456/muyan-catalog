/**
 * 画册渲染（服务端）—— 环境相关的部分
 *
 * 排版逻辑在 app/shared/catalog.mjs，浏览器端也用同一份。
 * 这里只做三件 Node 才能做的事：
 *   1. 把磁盘上的图片读成 data URI
 *   2. 分页溢出断言（开 Puppeteer 实测每页高度）
 *   3. 出 PDF
 *
 * 为什么必须有第 2 条：
 *   `.page` 用 min-height 时内容超长会静默撑高，打印只取 A4 高度、
 *   超出部分直接丢失。不做断言就会产出"看起来正常、实际缺内容"的画册。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { A4, PER_PAGE, renderCatalogHtml as renderShared } from '../shared/catalog.mjs';
import { ASSET_DIR, TMP_DIR } from './datadir.mjs';

export { A4, PER_PAGE };

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
};


/** 本地图片 -> data URI。画册必须自包含：发给客户后不依赖网络与服务器存活。 */
async function fileToDataUri(absPath) {
  const buf = await fs.readFile(absPath);
  const ext = path.extname(absPath).slice(1).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`不支持的图片格式：.${ext}（${path.basename(absPath)}）`);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * 服务端生成画册 HTML。
 *
 * 保持原有签名（assetDir 可选），内部把"读文件"包装成共享渲染器要的 resolveImage。
 */
export async function renderCatalogHtml({ products, settings, assetDir = ASSET_DIR, groupByCategory = false }) {
  const resolveImage = async (ref) => {
    if (!ref) return null;
    const abs = path.isAbsolute(ref) ? ref : path.join(assetDir, ref);
    try {
      return await fileToDataUri(abs);
    } catch (err) {
      // 缺图不应中断整本画册，但要让人知道是哪张
      console.warn(`  ⚠ 跳过图片（${path.basename(abs)}）：${err.message}`);
      return null;
    }
  };
  return renderShared({ products, settings, groupByCategory, resolveImage });
}

/**
 * 用 Puppeteer 实测每页高度，断言无溢出。
 * 返回 { ok, pages:[{page,heightPx,overflowPx,overflowing}] }
 *
 * `launchOptions` 由调用方传入（见 server/browser.mjs）：
 *   便携版需要显式指定浏览器路径，不能靠 puppeteer 自己找。
 */
export async function assertLayout(html, puppeteer, { writeDebugHtml, launchOptions = {} } = {}) {
  const USER_DATA = path.join(TMP_DIR, '.chrome-profile');
  await fs.rm(USER_DATA, { recursive: true, force: true });

  let htmlPath = writeDebugHtml;
  if (!htmlPath) {
    htmlPath = path.join(TMP_DIR, '.catalog-preview.html');
  }
  await fs.mkdir(path.dirname(htmlPath), { recursive: true });
  await fs.writeFile(htmlPath, html, 'utf-8');

  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: USER_DATA,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    ...launchOptions,
  });
  try {
    const page = await browser.newPage();
    await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => Promise.all(
      Array.from(document.images)
        .filter((im) => !im.complete)
        .map((im) => new Promise((r) => { im.onload = im.onerror = r; }))
    ));
    /**
     * ⚠️ **视口高度必须远大于 A4，不能就设成 A4 高度。**
     *
     * 原写法是 `height: A4.H_PX`（1123px），而 `.page` 用的是
     * `min-height: 297mm`。视口本身只有 1123px 时，
     * **内容超出也量不出来** —— 量到的永远是"正好 1123px、余量 0px"，
     * 于是断言永远通过。这是**假绿灯**，比不检查更危险：
     * 让人以为排版验证过了，其实什么都没验证。
     *
     * 实测踩到：6 款产品的画册三页全报"1123px、余量 0px"，
     * 看着整齐得不真实，实际上是被视口卡住了。
     *
     * 现在放开到 6000px（约 5 个 A4 高），内容有多少量多少。
     */
    await page.setViewport({ width: A4.W_PX, height: 6000, deviceScaleFactor: 1 });

    const pages = await page.evaluate((h) => Array.from(document.querySelectorAll('section.page')).map((el, i) => {
      const r = el.getBoundingClientRect();
      return {
        page: i + 1,
        heightPx: Math.round(r.height),
        overflowPx: Math.round(r.height - h),
        overflowing: r.height > h + 1,
      };
    }), A4.H_PX);

    return { ok: pages.every((p) => !p.overflowing), pages };
  } finally {
    await browser.close();
  }
}

/**
 * 出 PDF。
 *
 * ⚠️ 必须走 CDP Page.printToPDF 直写：page.pdf() 的流式回传在当前环境会
 *    报 Protocol error (IO.read)，实测不可用。
 */
export async function renderCatalogPdf(html, puppeteer, outPath, { previewDir, launchOptions = {} } = {}) {
  const USER_DATA = path.join(TMP_DIR, '.chrome-profile');
  await fs.rm(USER_DATA, { recursive: true, force: true });

  const htmlPath = path.join(TMP_DIR, '.catalog-preview.html');
  await fs.mkdir(path.dirname(htmlPath), { recursive: true });
  await fs.writeFile(htmlPath, html, 'utf-8');

  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: USER_DATA,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
    ...launchOptions,
  });
  try {
    const page = await browser.newPage();
    await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => Promise.all(
      Array.from(document.images)
        .filter((im) => !im.complete)
        .map((im) => new Promise((r) => { im.onload = im.onerror = r; }))
    ));
    await page.setViewport({ width: A4.W_PX, height: A4.H_PX, deviceScaleFactor: 2 });

    const client = await page.createCDPSession();
    const res = await client.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
      transferMode: 'ReturnAsBase64',
    });

    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, Buffer.from(res.data, 'base64'));

    // 顺手出预览图，便于人眼确认（可选）
    const shots = [];
    if (previewDir) {
      await fs.mkdir(previewDir, { recursive: true });
      const n = await page.evaluate(() => document.querySelectorAll('section.page').length);
      for (let i = 0; i < n; i++) {
        const el = (await page.$$('section.page'))[i];
        const f = path.join(previewDir, `page-${i + 1}.png`);
        await el.screenshot({ path: f });
        shots.push(f);
      }
    }

    return { pdfPath: outPath, sizeKB: Math.round((await fs.stat(outPath)).size / 1024), previews: shots };
  } finally {
    await browser.close();
  }
}
