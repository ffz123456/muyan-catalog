/**
 * 断言与测试输出 —— 避免"参数写反导致假通过"
 *
 * 教训：之前用 assert(cond, name) 的签名，调用时写成 assert(true, '初始化完成')，
 * 把字面量 true 当成名字，于是打印 "✓ true"，一切看起来都通过。
 * 现在改为显式分组 + 计数，任何一项失败都会体现在汇总里。
 */

export function createSuite(title) {
  const results = [];
  let currentGroup = '(未分组)';

  const out = {
    group(name) {
      currentGroup = name;
      console.log(`\n${name}`);
    },
    /** 核心断言：name 在前、条件在后，读起来就是一句话 */
    check(name, condition, detail = '') {
      const pass = !!condition;
      results.push({ group: currentGroup, name, pass, detail });
      console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
      return pass;
    },
    /** 仅记录一条信息，不计入通过率 */
    info(text) {
      console.log(`    ${text}`);
    },
    get failures() {
      return results.filter((r) => !r.pass);
    },
    summary() {
      const passed = results.filter((r) => r.pass).length;
      const total = results.length;
      console.log(`\n${'='.repeat(64)}`);
      console.log(`${title}`);
      console.log(`结果：${passed} / ${total} 项通过`);
      const failed = results.filter((r) => !r.pass);
      if (failed.length) {
        console.log('\n✗ 未通过：');
        for (const f of failed) console.log(`  [${f.group}] ${f.name}${f.detail ? '  — ' + f.detail : ''}`);
      } else {
        console.log('✓ 全部通过');
      }
      return { passed, total, failed };
    },
  };
  return out;
}
