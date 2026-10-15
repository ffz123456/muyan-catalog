/* 旧浏览器运行时补丁 —— 目前为空。
 *
 * 曾经有 5 个（replaceAll / Array.at / structuredClone / Object.hasOwn / findLast），
 * 后来逐个核实发现**源码一个都没用到**，是死代码，已删除。
 * 加补丁的判断标准：旧内核没有、且浏览器端真的调用了。
 * 加完跑 tools/verify-legacy-compat.mjs 验证覆盖。 */
