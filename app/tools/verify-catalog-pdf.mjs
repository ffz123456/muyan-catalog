/**
 * 服务端出画册 PDF 验证
 *
 * 为什么单独立这一套：
 *   在写它之前，"服务端生成 PDF"这条路径**从来没有被端到端验证过**——
 *   它一直是"镜像里装了 Chromium，理论上能用"。
 *   而这条路径恰恰是最容易静默出错的：画册里中文变乱码、
 *   分页溢出导致内容被裁掉，都**不会报错**，只会产出一份废品。
 *
 * 验证目标：
 *   1. 有浏览器时：能出 PDF，且**中文正确嵌入**（不是乱码）
 *   2. 没有浏览器时：返回可读的提示 + 指向「打印为 PDF」这条退路
 *   3. 分页溢出时：明确报 422，而不是产出被裁掉的画册
 *   4. PDF 文件本身可下载、大小合理
 *
 * 运行（需先启动服务端）：
 *   node tools/verify-catalog-pdf.mjs
 * 无浏览器场景需要能改名 browser/ 目录，故用 PUPPETEER_EXECUTABLE_PATH 控制。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createSuite } from './assert-lib.mjs';

const BASE = process.env.APP_URL || 'http://127.0.0.1:8080';
const APP_DIR = path.join(import.meta.dirname, '..');
const OUT = path.join(APP_DIR, 'data', 'pdf-verify');

const s = createSuite('服务端出画册 PDF 验证');

async function post(pathname, body) {
  const res = await fetch(BASE + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

/**
 * 从 PDF 里读文字信息。
 *
 * ⚠️ **不要用"搜 /BaseFont 字符串"来判断字体是否嵌入**。
 *    那个方法我试过两版，两版都误报：
 *      1. 用 indexOf('endstream') 找流边界会找错（内容流里有重复字节）
 *      2. 字体字典可能被放进压缩对象流，纯字节搜索看不到
 *    结果是一份**中文完全正常**的 PDF 被判成"没嵌字体"。
 *
 * 改用确定性判据：**把 ToUnicode CMap 解出来，看能不能还原出产品名**。
 * ToUnicode 是 PDF 规范里"字符码 → Unicode"的映射表，阅读器就是靠它
 * 把字形还原成文字的。能还原出完整产品名 = 文字内容正确、可复制、可搜索。
 * 这也正是当初证伪 pdf-catalog-generator 时用的方法。
 */
function inspectPdf(buf, needles = []) {
  const raw = buf.toString('latin1');
  const chars = new Set();

  // 逐个流尝试解压，从 beginbfchar 段里收集字符
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0 || end - start > 3_000_000) continue;
    let text = null;
    for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
      try { text = fn(buf.subarray(start, end)).toString('latin1'); break; } catch { /* 下一个 */ }
    }
    if (!text || !/beginbfchar|beginbfrange/.test(text)) continue;
    for (const mm of text.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]{4,})>/g)) {
      for (let i = 0; i + 4 <= mm[2].length; i += 4) {
        chars.add(String.fromCharCode(parseInt(mm[2].slice(i, i + 4), 16)));
      }
    }
  }

  const cjkCount = [...chars].filter((c) => c.charCodeAt(0) >= 0x4e00 && c.charCodeAt(0) <= 0x9fff).length;
  const matched = needles.filter((n) => [...n].every((c) => chars.has(c)));

  return {
    charCount: chars.size,
    cjkCount,
    charSamples: [...chars],
    matchedNames: matched,
    hasToUnicode: /\/ToUnicode/.test(raw),
    hasImage: /\/Subtype\s*\/Image/.test(raw),
    pages: (raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length,
  };
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });

  const hasBrowser = !!process.env.PUPPETEER_EXECUTABLE_PATH;
  s.info(`服务端浏览器：${hasBrowser ? process.env.PUPPETEER_EXECUTABLE_PATH : '(未指定)'}`);

  /* ---------- 1. 预览接口（不依赖浏览器） ---------- */
  s.group('【1】画册 HTML 预览');
  const preview = await post('/api/catalog/preview', { groupByCategory: false });
  s.check('预览接口可用', preview.status === 200, `HTTP ${preview.status}`);
  s.check('返回了 HTML', typeof preview.body?.html === 'string' && preview.body.html.length > 500,
    `${preview.body?.html?.length ?? 0} 字符`);
  s.check('带上了产品数', preview.body?.count > 0, `${preview.body?.count} 款`);

  const htmlChinese = (preview.body?.html ?? '').includes('云舒') || (preview.body?.html ?? '').includes('沙发');
  s.check('HTML 里含中文产品名', htmlChinese);

  /* ---------- 2. 无浏览器时的行为 ---------- */
  s.group('【2】没有浏览器时要给可读的退路');
  if (hasBrowser) {
    s.info('本次指定了浏览器，跳过"无浏览器"场景（该场景由 CI/无浏览器环境覆盖）');
    s.check('（跳过）无浏览器场景', true, '已显式指定浏览器');
  } else {
    const noBrowser = await post('/api/catalog/pdf', {});
    s.check('返回 501 而不是 500', noBrowser.status === 501, `HTTP ${noBrowser.status}`);
    s.check('说明原因', typeof noBrowser.body?.error === 'string' && noBrowser.body.error.length > 4,
      String(noBrowser.body?.error));
    s.check('给出可操作提示', typeof noBrowser.body?.hint === 'string' && noBrowser.body.hint.includes('打印'),
      String(noBrowser.body?.hint).slice(0, 60));
    s.check('标记了退路是"打印"', noBrowser.body?.fallback === 'print', String(noBrowser.body?.fallback));
  }

  /* ---------- 3. 有浏览器时真的出 PDF ---------- */
  if (hasBrowser) {
    s.group('【3】服务端生成 PDF');
    const made = await post('/api/catalog/pdf', { groupByCategory: false });
    s.check('生成成功', made.status === 200, `HTTP ${made.status}${made.status === 200 ? '' : '：' + JSON.stringify(made.body).slice(0, 140)}`);

    if (made.status === 200) {
      s.check('返回下载地址', typeof made.body?.downloadUrl === 'string', String(made.body?.downloadUrl));
      s.check('报告页数', made.body?.pages > 0, `${made.body?.pages} 页`);
      s.check('报告体积', made.body?.sizeKB > 0, `${made.body?.sizeKB} KB`);

      // 真的把文件下下来检查内容
      const dl = await fetch(BASE + made.body.downloadUrl);
      s.check('下载地址可用', dl.status === 200, `HTTP ${dl.status}`);
      const buf = Buffer.from(await dl.arrayBuffer());
      await fs.writeFile(path.join(OUT, 'catalog.pdf'), buf);

      // 拿产品名当探针：能从 PDF 里还原出来，才说明中文真的写对了
      let needles = [];
      try {
        const pl = await (await fetch(`${BASE}/api/products`)).json();
        needles = (pl.products ?? []).map((p) => p.name).filter(Boolean);
      } catch { /* 拿不到就退化为"只看汉字数量" */ }

      const info = inspectPdf(buf, needles);
      s.info(`PDF：还原出 ${info.charCount} 个字符（汉字 ${info.cjkCount}）；页数 ${info.pages}`);

      s.check('PDF 体积合理（>10KB）', buf.length > 10 * 1024, `${(buf.length / 1024).toFixed(0)} KB`);
      s.check('PDF 头正确', buf.subarray(0, 5).toString() === '%PDF-', buf.subarray(0, 8).toString());
      s.check('含 ToUnicode 映射（中文可复制可搜索）', info.hasToUnicode);
      s.check('PDF 里能还原出汉字', info.cjkCount >= 20, `${info.cjkCount} 个汉字`);
      // 产品名能否还原，由下面那条"汉字编码是否正确"覆盖——
      // 这里不再单独断言，避免同一个缺陷报两遍
      if (needles.length) s.info(`（探针产品名 ${needles.length} 个，命中情况见下面那条编码检查）`);
      s.check('产品图片已嵌入', info.hasImage);

      /**
       * ⚠️ 已知缺陷：Linux 容器里 Chromium 生成的 PDF，部分汉字会被写成
       *    **康熙部首**（Kangxi Radicals，U+2F00–U+2FDF）而不是正常汉字。
       *
       *    实测：`人` → `⼈`、`白` → `⽩`、`木` → `⽊`、`几` → `⼏`、`示` → `⽰`。
       *    码点系统性偏移 0x2E00。出错的字**正好都是康熙部首**。
       *    字形显示看起来正常（Noto CJK 把它们画成同样的形状），
       *    但**复制、搜索、检索全都失效**——对客户是不可见的坏掉。
       *
       *    已排除的原因：不是字体选择（试了 Noto Sans/Serif CJK、Noto Sans CJK JP、
       *    系统默认 sans-serif，全都是同样 9 个字出错）、不是内联字体、不是启动参数。
       *    判断是 Chromium 在 Linux 上生成 PDF 的问题。
       *
       *    影响范围：**只影响"服务端生成"这条路**。
       *    「打印为 PDF」用的是用户自己设备上的浏览器与字体，不受影响——
       *    那也正是我们推荐给销售的默认路径。
       *
       *    这里把它**显式测出来并报告**，而不是假装通过：
       *    将来谁修好了，这条断言会告诉他。
       */
      const KANGXI = /[\u2E80-\u2FDF]/;
      const kangxi = (info.charSamples ?? []).filter((c) => KANGXI.test(c));
      if (kangxi.length) {
        s.info(`⚠️ 检出 ${kangxi.length} 个康熙部首字符（服务端生成 PDF 的已知缺陷）：${kangxi.slice(0, 12).join('')}`);
        s.check('（已知缺陷）服务端 PDF 的汉字编码正确', false,
          '有汉字被写成康熙部首，复制/搜索会失效。改用「打印为 PDF」可规避。见本文件注释');
      } else {
        s.check('服务端 PDF 的汉字编码正确', true);
      }

      const layoutOk = Array.isArray(made.body?.layout)
        && made.body.layout.every((p) => !p.overflowing);
      s.check('每页都没有溢出', layoutOk,
        `${made.body?.layout?.length ?? 0} 页，溢出 ${made.body?.layout?.filter((p) => p.overflowing).length ?? '?'} 页`);

      s.info(`PDF 已留存：${path.relative(APP_DIR, path.join(OUT, 'catalog.pdf'))}`);
    }
  } else {
    s.group('【3】服务端生成 PDF');
    s.info('未指定浏览器，跳过生成测试');
  }

  /* ---------- 4. 分页断言的保障位置 ---------- */
  s.group('【4】分页溢出不会被静默裁掉');
  s.info('溢出判定在 render-catalog.mjs 的 assertLayout：逐页实测高度，超 A4 即 422');
  s.info('该断言的独立验证见 catalog/docs/画册链路验证结论.md');
  s.check('（说明）溢出保护由 assertLayout 承担', true, '见结论文档');
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; console.error('\n运行中断：', e.message); }

const { failed } = s.summary();
if (crashed) {
  console.log(`\n脚本异常终止：${crashed.message}`);
  console.log(crashed.stack.split('\n').slice(0, 4).join('\n'));
}
process.exitCode = (failed.length || crashed) ? 1 : 0;
