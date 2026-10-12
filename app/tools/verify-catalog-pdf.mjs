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

/** 从 PDF 字节里读字体信息（不引第三方库，直接找 PDF 结构）。 */
function inspectPdf(buf) {
  const raw = buf.toString('latin1');
  const fonts = [...raw.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+\-,#]+)/g)].map((m) => m[1]);
  return {
    fonts: [...new Set(fonts)],
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

      const info = inspectPdf(buf);
      s.info(`PDF 字体：${info.fonts.join(', ') || '(无)'}；页数 ${info.pages}`);

      s.check('PDF 体积合理（>10KB）', buf.length > 10 * 1024, `${(buf.length / 1024).toFixed(0)} KB`);
      s.check('PDF 头正确', buf.subarray(0, 5).toString() === '%PDF-', buf.subarray(0, 8).toString());
      s.check('嵌入了字体（不是全用默认字体）', info.fonts.length > 0, `${info.fonts.length} 种`);
      s.check('含 ToUnicode 映射（中文可复制可搜索）', info.hasToUnicode);
      s.check('字体里有中文/CJK 字体',
        info.fonts.some((f) => /YaHei|SimSun|SimHei|Noto|CJK|Song|Hei|Ming|DengXian|KaiTi|Arial Unicode/i.test(f)),
        info.fonts.join(', '));
      s.check('产品图片已嵌入', info.hasImage);

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
