/**
 * 验证「服务端用浏览器命令行出画册 PDF」这条路
 *
 * 为什么不并进 verify-catalog-pdf.mjs：
 *   那个套件测的是 puppeteer 那条路（含分页溢出断言）。
 *   命令行这条路**没有**溢出断言——少一道防线要单独说清楚，
 *   不能混在一个"通过"里让人以为都测过了。
 *
 * 关心：
 *   1. 接口可用、返回下载地址
 *   2. PDF 能下下来、页数正确、是 A4
 *   3. **中文能还原**（不是乱码）
 *   4. **没有康熙部首**——容器里 Chromium 那条路有这个缺陷，
 *      这条走的是本机浏览器，必须确认没有
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createSuite } from './assert-lib.mjs';

const BASE = process.env.APP_URL || 'http://127.0.0.1:8080';
const OUT = path.join(import.meta.dirname, '..', 'data', 'pdf-cli-verify');

const s = createSuite('服务端命令行出 PDF 验证');

async function post(path_, body) {
  const res = await fetch(BASE + path_, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let parsed; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

/** 从 PDF 里还原字符（解 ToUnicode CMap）。 */
function extractChars(buf) {
  const raw = buf.toString('latin1');
  const chars = new Set();
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0 || end - start > 3_000_000) continue;
    for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
      try {
        const t = fn(buf.subarray(start, end)).toString('latin1');
        if (!/beginbfchar|beginbfrange/.test(t)) break;
        for (const mm of t.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]{4,})>/g)) {
          for (let i = 0; i + 4 <= mm[2].length; i += 4) {
            chars.add(String.fromCharCode(parseInt(mm[2].slice(i, i + 4), 16)));
          }
        }
        break;
      } catch { /* 换个解压方式 */ }
    }
  }
  return chars;
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });

  /* 先确认有产品可出画册 */
  const list = await (await fetch(`${BASE}/api/products`)).json();
  if (!list.products?.length) {
    console.log('\n  ⚠️  没有产品，无法测画册。请先运行 app/tools/seed-sample-data.mjs\n');
    process.exitCode = 1;
    return;
  }
  const names = list.products.map((p) => p.name).filter(Boolean);
  s.info(`产品 ${list.products.length} 款`);

  s.group('【1】接口');
  const cap = await (await fetch(`${BASE}/api/capabilities`)).json();
  s.check('服务端报告能出 PDF', cap?.serverPdf?.available === true,
    cap?.serverPdf?.available ? `驱动 ${cap.serverPdf.driver}` : cap?.serverPdf?.reason);
  if (cap?.serverPdf?.driver) {
    s.info(`驱动：${cap.serverPdf.driver}`
      + (cap.serverPdf.driver === 'cli' ? '（浏览器命令行，不需要 puppeteer）' : ''));
  }

  const made = await post('/api/catalog/pdf', { groupByCategory: false });
  s.check('生成成功', made.status === 200,
    `HTTP ${made.status}${made.status === 200 ? '' : '：' + JSON.stringify(made.body).slice(0, 160)}`);
  if (made.status !== 200) return;

  s.check('返回下载地址', typeof made.body?.downloadUrl === 'string', String(made.body?.downloadUrl));
  s.check('报告体积', made.body?.sizeKB > 0, `${made.body?.sizeKB} KB`);
  // 命令行那条路做不了逐页溢出断言——如实说出来，别让人以为检查过了
  s.check('如实标注是否做了分页断言',
    made.body?.layoutChecked === (made.body?.driver !== 'cli'),
    `driver=${made.body?.driver} layoutChecked=${made.body?.layoutChecked}`);

  s.group('【2】PDF 内容');
  const dl = await fetch(BASE + made.body.downloadUrl);
  s.check('下载地址可用', dl.status === 200, `HTTP ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());
  await fs.writeFile(path.join(OUT, 'catalog.pdf'), buf);

  s.check('是 PDF 文件', buf.subarray(0, 5).toString() === '%PDF-', buf.subarray(0, 8).toString());
  s.check('体积合理（>10KB）', buf.length > 10 * 1024, `${(buf.length / 1024).toFixed(0)} KB`);

  const raw = buf.toString('latin1');
  const pageCount = (raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  s.check('页数 ≥ 2（封面 + 目录）', pageCount >= 2, `${pageCount} 页`);

  // A4 判定：MediaBox 宽高应为 595×842 pt（±2）
  const boxes = [...raw.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)]
    .map((m) => [Number(m[1]), Number(m[2])]);
  const a4 = boxes.length > 0 && boxes.every(([w, h]) => Math.abs(w - 595) <= 3 && Math.abs(h - 842) <= 3);
  s.check('页面是 A4 尺寸', a4,
    boxes.length ? boxes.slice(0, 2).map((b) => b.join('×')).join(' / ') : '(未找到 MediaBox)');

  s.group('【3】中文');
  const chars = extractChars(buf);
  const cjk = [...chars].filter((c) => c.charCodeAt(0) >= 0x4e00 && c.charCodeAt(0) <= 0x9fff).length;
  s.check('能还原出汉字', cjk >= 20, `${cjk} 个汉字`);

  const hit = names.filter((n) => [...n].every((c) => chars.has(c)));
  s.check('能还原出画册里的产品名', hit.length >= Math.min(3, names.length),
    `${hit.length}/${names.length} 命中${hit.length ? '：' + hit.slice(0, 3).join('、') : ''}`);

  /**
   * 康熙部首检查（U+2E80–U+2FDF）。
   *
   * 容器里用 Chromium 生成时，「人白木几示寸」会被写成康熙部首，
   * 字形看着一样但复制/搜索失效。这条走本机浏览器，应当没有。
   */
  const kangxi = [...chars].filter((c) => {
    const cp = c.charCodeAt(0);
    return cp >= 0x2e80 && cp <= 0x2fdf;
  });
  s.check('没有把汉字写成康熙部首', kangxi.length === 0,
    kangxi.length ? `${kangxi.length} 个：${kangxi.slice(0, 10).join('')}` : '干净');

  s.check('产品图片已嵌入', /\/Subtype\s*\/Image/.test(raw));

  s.info(`PDF 已留存：${path.relative(path.join(import.meta.dirname, '..'), path.join(OUT, 'catalog.pdf'))}`);
}

let crashed = null;
try { await main(); } catch (e) { crashed = e; console.error('\n运行中断：', e.message); }

const { failed } = s.summary();
if (crashed) {
  console.log(`\n脚本异常终止：${crashed.message}`);
  console.log(crashed.stack.split('\n').slice(0, 4).join('\n'));
}
process.exitCode = (failed.length || crashed) ? 1 : 0;
