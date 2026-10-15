/** 快速检查 buildIfStale 的"过期判断"是否正确。 */
const m = await import('../tools/build-web.mjs');

const first = await m.buildIfStale();
console.log(`  第一次：rebuilt=${first.rebuilt}${first.rebuilt ? ` (${first.ms} ms, ${first.files} 个文件)` : ''}`);

const second = await m.buildIfStale();
console.log(`  第二次：rebuilt=${second.rebuilt}${second.rebuilt ? ` (${second.ms} ms)` : '（源码没变 → 跳过，正确）'}`);

if (first.rebuilt && second.rebuilt) {
  console.log('  ✗ 每次都说要重建——过期判断失效了，会导致每次启动都白跑');
  process.exitCode = 1;
} else if (second.rebuilt) {
  console.log('  ✓ 第一次重建、第二次跳过，符合预期');
} else if (!first.rebuilt) {
  console.log('  · 两次都跳过（源码本来就比产物旧，正常）');
}
