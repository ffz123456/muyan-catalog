/**
 * 检查仓库里的文本文件是不是合法 UTF-8。
 *
 * 为什么需要这个工具（这是本项目踩过的真实坑）：
 *
 *   在 Windows PowerShell 里用 `Add-Content` / `Out-File` / `>>` 追加**中文**内容时，
 *   默认走的是**系统 ANSI 代码页**（中文 Windows 上是 GBK），不是 UTF-8。
 *   结果文件变成"前半 UTF-8 + 后半 GBK"的混合体：
 *     · git 能读，diff 也正常
 *     · 编辑器看着大致像样
 *     · 但**严格按 UTF-8 解析就崩**，换编辑器或换机器可能显示成乱码
 *   我就是这样把 .gitignore 写坏的，而且**当时完全没察觉**。
 *
 *   正确做法：改文本文件一律用编辑工具（它们写 UTF-8），
 *   或者 Node 的 `fs.writeFile(..., 'utf-8')`。**不要用 PowerShell 重定向写含中文的文件。**
 *
 * 这个工具用来在提交前扫一遍，把这类问题挡在仓库外面。
 *
 * 用法：
 *   node tools/check-encoding.mjs <目录或文件...>
 */
import fs from 'node:fs';
import path from 'node:path';

/** 只检查这些扩展名（二进制文件跳过）。 */
const TEXT_EXT = new Set([
  '.mjs', '.js', '.cjs', '.json', '.md', '.html', '.css', '.yml', '.yaml',
  '.txt', '.cmd', '.bat', '.ps1', '.sh', '.gitignore', '.example', '.svg',
]);

/** 这些目录不扫。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'data', 'vendor', 'cache',
  '.npm-cache', '.puppeteer-cache', 'devtest', '_build',
]);

const decoder = new TextDecoder('utf-8', { fatal: true });

/** @returns {{ok:boolean, reason?:string, offset?:number}} */
function checkFile(file) {
  const buf = fs.readFileSync(file);
  if (buf.length === 0) return { ok: true };
  try {
    decoder.decode(buf);
    return { ok: true };
  } catch (e) {
    // 找出第一个出问题的位置，方便定位
    const m = /position (\d+)/.exec(e.message);
    return { ok: false, reason: e.message, offset: m ? Number(m[1]) : undefined };
  }
}

function* walk(target) {
  const st = fs.statSync(target);
  if (st.isFile()) { yield target; return; }
  for (const e of fs.readdirSync(target, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(path.join(target, e.name));
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (TEXT_EXT.has(ext) || e.name === '.gitignore') yield path.join(target, e.name);
    }
  }
}

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('  用法: node tools/check-encoding.mjs <目录或文件...>');
  process.exit(1);
}

let files = 0;
const bad = [];

for (const t of targets) {
  if (!fs.existsSync(t)) {
    console.error(`  ⚠ 不存在：${t}`);
    continue;
  }
  for (const f of walk(t)) {
    files++;
    const r = checkFile(f);
    if (!r.ok) bad.push({ f, ...r });
  }
}

if (bad.length) {
  console.error('');
  console.error(`  ✗ 发现 ${bad.length} 个非 UTF-8 文件（共检查 ${files} 个）：`);
  for (const b of bad) {
    console.error(`     ${b.f}${b.offset !== undefined ? `  （偏移 ${b.offset} 处开始）` : ''}`);
  }
  console.error('');
  console.error('  多半是用 PowerShell 的 Add-Content / Out-File / >> 追加过中文内容。');
  console.error('  请用编辑工具重写该文件，或删掉那几行后重新添加。');
  console.error('');
  process.exit(1);
}

console.log(`  ✓ ${files} 个文本文件全部是合法 UTF-8`);
