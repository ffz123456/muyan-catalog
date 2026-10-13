/**
 * 检查 HTML 里内嵌的 <script type="module"> 语法。
 *
 * 为什么需要：自检页/单文件版把 JS 内嵌在 HTML 里，
 * `node --check` 直接跑不了 HTML。语法错会让整个页面**静默无反应**——
 * 而"页面能显示但点了没反应"正是最难查的一类问题。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('  用法: node tools/check-inline-js.mjs <html文件...>');
  process.exit(1);
}

let bad = 0;
for (const f of files) {
  const html = fs.readFileSync(f, 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s+type="module")?\s*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .filter((s) => s.trim().length > 0);

  if (!scripts.length) {
    console.log(`  ⚠ ${path.basename(f)}：没有内嵌脚本`);
    continue;
  }

  let ok = true;
  scripts.forEach((code, i) => {
    const tmp = path.join(os.tmpdir(), `inline-${process.pid}-${i}.mjs`);
    fs.writeFileSync(tmp, code, 'utf8');
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    } catch (e) {
      ok = false;
      const msg = (e.stderr?.toString() ?? e.message).split('\n').slice(0, 6).join('\n      ');
      console.log(`  ✗ ${path.basename(f)} 第 ${i + 1} 段脚本语法错误：\n      ${msg}`);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  if (ok) {
    console.log(`  ✓ ${path.basename(f)}：${scripts.length} 段内嵌脚本语法正确`
      + `（共 ${scripts.reduce((n, s) => n + s.length, 0)} 字符）`);
  } else {
    bad++;
  }
}

process.exitCode = bad ? 1 : 0;
