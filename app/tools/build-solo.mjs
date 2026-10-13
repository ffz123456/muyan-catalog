/**
 * 把界面打包成**一个 HTML 文件**
 *
 * 目标：发给销售一个文件，存到手机上，点开就能用。
 * 不需要服务器、不需要网络、不需要装任何东西。
 *
 * 为什么不引 webpack/vite：
 *   1. 项目一直坚持"零外部依赖"，加一个几百 MB 的构建链不合适
 *   2. 需求很窄：把 5 个自家模块拼起来。不处理 npm 包、CSS 预处理、代码分割。
 *   3. 自己写能完全控制产物——出问题看得懂。
 *
 * ------------------------------------------------------------------
 * ⚠️ 做法上的一个关键教训（第一版就是这么错的）
 *
 *   一开始我用"给所有顶层标识符加前缀"的办法避免重名。
 *   结果漏掉了 `const { $, $$ } = ...` 这种**解构声明**，
 *   而 `$` / `$$` 在 app.mjs 和 syncdb.mjs 里都有 ——
 *   产物报 `Identifier '$' has already been declared`，整个应用起不来。
 *
 *   教训：靠正则枚举 JS 的声明形式是**列不全**的
 *   （解构、默认值、多声明一行、async generator…），
 *   漏一个就是运行时崩溃。
 *
 *   现在改成：**每个模块包进一个 IIFE，导出的名字作为对象返回。**
 *   这样模块内部的局部名字根本不需要改名，从根上避开这一类问题。
 *   被依赖的模块提前创建好"命名空间对象"，
 *   于是 `import * as sync from './syncdb.mjs'` 能原样变成 `const sync = …`
 *   —— 与原语义一一对应。
 *
 *   唯一的改名只剩：跨模块**重名导出**的键（如 backend 与 localdb 都导出
 *   listProducts）。那是对象属性，安全。
 * ------------------------------------------------------------------
 *
 * 解析器会在看不懂的写法上**报错退出**，绝不"猜着拼"——
 * 拼错了产物照样能跑，只是行为不对，极难查。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const APP = path.join(import.meta.dirname, '..');
const PUBLIC = path.join(APP, 'public');
const SHARED = path.join(APP, 'shared');
const OUT_DIR = path.join(APP, 'dist');

/** 要打包的模块，按依赖顺序（被依赖的在前）。 */
const MODULES = [
  { key: 'catalog', file: path.join(SHARED, 'catalog.mjs') },
  { key: 'localdb', file: path.join(PUBLIC, 'localdb.mjs') },
  { key: 'syncdb', file: path.join(PUBLIC, 'syncdb.mjs') },
  { key: 'backend', file: path.join(PUBLIC, 'backend.mjs') },
  { key: 'app', file: path.join(PUBLIC, 'app.mjs') },
];

const BY_FILE = new Map(MODULES.map((m) => [path.resolve(m.file), m.key]));

const problems = [];

/* ------------------------------------------------------------------ *
 * 1. 解析
 * ------------------------------------------------------------------ */

/**
 * 顶层声明与导出名。
 *
 * 这里**只用来收集"导出名"**（IIFE 要返回哪些键），
 * 不再靠它做改名——所以即使漏了某种声明形式，后果也只是"少导出一个名字"，
 * 而不会像第一版那样造成重名崩溃。
 */
const DECL_PATTERNS = [
  // export async function foo / export function foo / export class Foo
  /^export\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/,
  // export const foo = / export let foo = （含解构中的简单名）
  /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
];

/** 解构导出：export const { a, b: c } = … / export const [x, y] = … */
const DESTRUCT = /^export\s+(?:const|let|var)\s*([{[][\s\S]*?[}\]])\s*=/;

function parseModule(key, file, src) {
  const lines = src.split('\n');
  const imports = [];
  const exportNames = new Set();
  const body = [];
  let inImport = false;
  let importBuf = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (inImport) {
      importBuf += ' ' + line.trim();
      if (/from\s+['"][^'"]+['"]\s*;?\s*$/.test(importBuf.trim())) {
        parseImport(importBuf.trim(), key, imports, i + 1);
        inImport = false; importBuf = '';
      }
      continue;
    }

    const t = line.trim();

    if (t.startsWith('import ')) {
      if (/from\s+['"][^'"]+['"]\s*;?\s*$/.test(t)) {
        parseImport(t, key, imports, i + 1);
      } else {
        inImport = true; importBuf = t;
      }
      continue;
    }

    // export { a, b as c }
    const br = /^export\s*\{([^}]*)\}/.exec(line);
    if (br) {
      for (const part of br[1].split(',')) {
        const bits = part.trim().split(/\s+as\s+/);
        const name = (bits[1] ?? bits[0]).trim();
        if (name) exportNames.add(name);
      }
      continue;
    }

    // export const { a, b } = …  → 收集解构里的名字
    const de = DESTRUCT.exec(line);
    if (de) {
      for (const part of de[1].replace(/[{}[\]]/g, ' ').split(',')) {
        const bits = part.trim().split(':');
        const name = (bits[1] ?? bits[0]).trim().split('=')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) exportNames.add(name);
      }
      // 去掉 export 前缀，声明本身留在模块里
      body.push(line.replace(/^export\s+/, ''));
      continue;
    }

    let matched = false;
    for (const re of DECL_PATTERNS) {
      const m = re.exec(line);
      if (m) { exportNames.add(m[1]); matched = true; break; }
    }
    if (matched) {
      body.push(line.replace(/^export\s+/, ''));
      continue;
    }

    if (/^export\s/.test(line)) {
      problems.push(`${path.basename(file)}:${i + 1} 不支持的导出写法：${t.slice(0, 60)}`);
      continue;
    }

    body.push(line);
  }

  // 没有 export 前缀但被导出的名字（export { x } 形式）这里已在 exportNames 里
  return { key, file, imports, exportNames, body };
}

function parseImport(stmt, fromKey, imports, lineNo) {
  const m = /^import\s+(?:\*\s+as\s+(\w+)|\{([^}]*)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/.exec(stmt);
  if (!m) {
    problems.push(`${path.basename(fromKey)}:${lineNo} 看不懂的 import：${stmt.slice(0, 60)}`);
    return;
  }
  const [, starName, braces, defName, spec] = m;
  imports.push({ fromSpec: spec, starName: starName ?? null, braces: braces ?? null, defName: defName ?? null });
}

/* ------------------------------------------------------------------ *
 * 2. 生成：每个模块包进 IIFE
 * ------------------------------------------------------------------ */

const NS = (key) => `ns_${key}`;            // 模块命名空间对象
const P = (key, name) => `${key}__${name}`; // 跨模块重名导出时的别名

function generate(parsed) {
  const byKey = new Map(parsed.map((p) => [p.key, p]));
  const chunks = [];

  /* 先声明所有命名空间对象：模块之间可能互相引用，顺序上要都能拿到 */
  chunks.push('/* ---- 模块命名空间（先建好，供互相引用）---- */');
  for (const p of parsed) chunks.push(`var ${NS(p.key)} = {};`);

  /* 统计跨模块重名的导出，给它们生成唯一别名 */
  const exportOwner = new Map();     // 导出名 -> 第一个拥有它的模块
  for (const p of parsed) {
    for (const n of p.exportNames) {
      if (!exportOwner.has(n)) exportOwner.set(n, p.key);
    }
  }

  for (const p of parsed) {
    const deps = [];

    /* import 变成局部常量，指向已建好的命名空间对象 */
    for (const im of p.imports) {
      const target = resolveImport(p.file, im.fromSpec);
      if (!target) {
        problems.push(`${path.basename(p.file)} 引用了不在打包清单里的模块：${im.fromSpec}`);
        continue;
      }
      const targetMod = byKey.get(target);
      if (!targetMod) continue;

      if (im.starName) {
        deps.push(`  const ${im.starName} = ${NS(target)};`);
      } else if (im.braces) {
        for (const part of im.braces.split(',')) {
          const bits = part.trim().split(/\s+as\s+/);
          const src4 = bits[0].trim();
          const alias = (bits[1] ?? bits[0]).trim();
          if (!alias) continue;
          /**
           * 具名导入：如果这个名字在多个模块里都存在，
           * 直接 ns.foo 可能与"别名"语义不一致，所以单独取一个常量。
           */
          deps.push(`  const ${alias} = ${NS(target)}.${src4};`);
        }
      } else if (im.defName) {
        deps.push(`  const ${im.defName} = ${NS(target)}.default ?? ${NS(target)};`);
      }
    }

    /* 模块体本身**一个字都不改**（除了已去掉 export 前缀） */
    const body = p.body.join('\n');

    /* 导出：把导出的名字挂到命名空间对象上 */
    const assigns = [];
    for (const n of p.exportNames) {
      /**
       * 跨模块重名时（backend 与 localdb 都导出 listProducts），
       * 后者会在命名空间对象上覆盖前者——所以额外挂一个带前缀的别名，
       * 需要精确引用时可以用。
       */
      if (exportOwner.get(n) !== p.key) {
        assigns.push(`  ${NS(p.key)}.${P(p.key, n)} = ${n};`);
      }
      assigns.push(`  ${NS(p.key)}.${n} = ${n};`);
    }

    chunks.push(`\n/* ================= ${path.basename(p.file)} ================= */`);
    chunks.push(`(function () {\n${deps.join('\n')}${deps.length ? '\n' : ''}${body}\n${assigns.join('\n')}\n})();`);
  }

  return chunks.join('\n');
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const abs = path.resolve(path.dirname(fromFile), spec);
  return BY_FILE.get(abs) ?? null;
}

/* ------------------------------------------------------------------ *
 * 3. 组装
 * ------------------------------------------------------------------ */

async function assemble(bundledJs) {
  const html = await fs.readFile(path.join(PUBLIC, 'index.html'), 'utf-8');
  const css = await fs.readFile(path.join(PUBLIC, 'style.css'), 'utf-8');
  // PouchDB 是 UMD，挂在全局；内联它，避免依赖外部文件
  const pouch = await fs.readFile(path.join(PUBLIC, 'vendor', 'pouchdb.min.js'), 'utf-8');

  let out = html;
  const repl = (re, to) => {
    if (!re.test(out)) problems.push(`index.html 里找不到要替换的位置：${re}`);
    out = out.replace(re, to);
  };

  repl(/<link[^>]*href="\/style\.css"[^>]*>/, () => `<style>\n${css}\n</style>`);
  repl(
    /<script src="\/vendor\/pouchdb\.min\.js"><\/script>/,
    // 去掉 sourceMappingURL，否则浏览器会去找 .map 文件报 404
    () => `<script>\n${pouch.replace(/\/\/# sourceMappingURL=.*$/m, '')}\n</script>`,
  );
  repl(/<script type="module" src="\/app\.mjs"><\/script>/, () => `<script>\n${bundledJs}\n</script>`);

  return out;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const parsed = [];
for (const m of MODULES) {
  const src = await fs.readFile(m.file, 'utf-8');
  parsed.push(parseModule(m.key, m.file, src));
}

const bundleJs = generate(parsed);

if (problems.length) {
  console.error('\n  ✗ 打包失败：');
  for (const p of problems) console.error('     ' + p);
  console.error('\n  不要"猜着拼"——拼错了产物照样能跑，只是行为不对。');
  console.error('  请调整源码写法，或扩展 tools/build-solo.mjs。\n');
  process.exit(1);
}

const banner = `/* 单人模式单文件版 —— 由 tools/build-solo.mjs 生成，请勿手工修改
 *
 * 用法：把这个文件发到手机上，用浏览器打开即可。
 * 数据存在这台设备的浏览器里，不需要服务器、不需要网络。
 *
 * ⚠️ 数据只在浏览器里：清理浏览器数据 / 换手机会丢。
 *    请定期在「设置」里导出备份。
 */
`;

await fs.mkdir(OUT_DIR, { recursive: true });
const finalHtml = await assemble(banner + bundleJs);
const outFile = path.join(OUT_DIR, '家具开单-单机版.html');
await fs.writeFile(outFile, finalHtml, 'utf-8');

const kb = (n) => `${Math.round(n / 1024)} KB`;
console.log('');
console.log('  ✓ 打包完成');
console.log(`    产物: ${path.relative(APP, outFile)}`);
console.log(`    大小: ${kb(Buffer.byteLength(finalHtml))}`);
console.log(`    模块: ${parsed.map((p) => `${p.key}(${p.exportNames.size})`).join(' → ')}`);
console.log('');
console.log('  验证：node tools/verify-solo-bundle.mjs');
console.log('');
