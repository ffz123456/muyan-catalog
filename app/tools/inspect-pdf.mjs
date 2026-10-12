/**
 * 判定画册 PDF 里的中文是否**真的可提取**。
 *
 * 为什么用这个判据，而不是"找 /BaseFont"：
 *   我先后写了两版"搜 BaseFont"的检查，两版都出过误判——
 *   一次是因为流边界找错，一次是因为字体字典在压缩对象流里。
 *   自制 PDF 解析器本身成了 bug 来源，不可信。
 *
 * 换成确定性的判据：
 *   把 PDF 里所有 ToUnicode CMap 解出来，看**能不能还原出产品名**。
 *   ToUnicode 是 PDF 规范里"字符码 → Unicode"的映射表，
 *   浏览器/阅读器就是靠它把字形还原成文字的。
 *   能还原出完整产品名 = 文字内容正确、可复制、可搜索。
 *
 *   再配合"文件里确实有字体数据"作为辅助判据。
 *
 * 这正是当初证伪 pdf-catalog-generator 时用的判据
 * （它 0/5 产品名匹配，判定为乱码）。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2] || 'data/pdf-verify/catalog.pdf';
const buf = fs.readFileSync(file);
const raw = buf.toString('latin1');

console.log(`  文件: ${file}`);
console.log(`  大小: ${(buf.length / 1024).toFixed(0)} KB`);

/* ---- 1. 把所有 ToUnicode CMap 解出来，还原成字符集 ---- */
const chars = new Set();
const codes = [];

const re = /stream\r?\n/g;
let m;
while ((m = re.exec(raw)) !== null) {
  const start = m.index + m[0].length;
  const end = raw.indexOf('endstream', start);
  if (end < 0) continue;
  const chunk = buf.subarray(start, end);

  let text = null;
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
    try { text = fn(chunk).toString('latin1'); break; } catch { /* 继续 */ }
  }
  if (!text || !/beginbfchar|beginbfrange/.test(text)) continue;

  // beginbfchar: <srcCode> <dstUnicode>
  for (const mm of text.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
    const hex = mm[2];
    // 目标通常是 UTF-16BE，可能多字符
    for (let i = 0; i + 4 <= hex.length; i += 4) {
      const cp = parseInt(hex.slice(i, i + 4), 16);
      if (cp > 0) { chars.add(String.fromCharCode(cp)); codes.push(cp); }
    }
  }
  // beginbfrange: <lo> <hi> <dstStart>
  for (const mm of text.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
    const lo = parseInt(mm[1], 16); const hi = parseInt(mm[2], 16); const dst = parseInt(mm[3], 16);
    for (let c = lo; c <= Math.min(hi, lo + 200); c++) {
      chars.add(String.fromCharCode(dst + (c - lo)));
    }
  }
}

const all = [...chars].join('');
const cjk = [...chars].filter((c) => c.charCodeAt(0) >= 0x4e00 && c.charCodeAt(0) <= 0x9fff);

console.log(`  还原出 ${chars.size} 个字符，其中中日韩汉字 ${cjk.length} 个`);
console.log(`  汉字样本: ${cjk.slice(0, 40).join('')}`);

/* ---- 2. 用示例数据里的产品名做匹配 ---- */
const NEEDLES = ['云舒三人布艺沙发', '白蜡木实木茶几', '黑胡桃玻璃展示柜', '橡木伸缩餐桌', '榉木落地衣帽架'];
const hit = NEEDLES.filter((n) => [...n].every((c) => chars.has(c)));
console.log('');
console.log(`  与示例产品名逐字匹配: ${hit.length}/${NEEDLES.length}`);
if (hit.length) console.log(`    命中: ${hit.join('、')}`);

/* ---- 3. 辅助判据：文件里有没有字体程序 ---- */
const hasFontProgram = /FontFile2|FontFile3|FontFile\b/.test(raw);
const hasFontObj = /\/Type\s*\/Font/.test(raw) || /\/BaseFont/.test(raw);
console.log('');
console.log(`  文件里出现 /Font 或 /BaseFont: ${hasFontObj}`);
console.log(`  文件里出现 FontFile（字形程序）: ${hasFontProgram}`);

/* ---- 判定 ---- */
const ok = hit.length >= 4 && cjk.length >= 20;
console.log('');
console.log('  ── 判定 ──');
console.log(`  ${ok ? '✓ 中文内容正确' : '✗ 中文内容有问题'}`);
if (!ok) {
  console.log('     PDF 里还原不出产品名，说明文字没有正确编码。');
  console.log('     这种 PDF 在别的机器上会显示成乱码或方块。');
}
process.exitCode = ok ? 0 : 1;
