/**
 * 生成一个**大字报式**的存储探针，方便用截图直接读结果
 *
 * 为什么这么做：
 *   安卓上想把页面里的结果取出来很麻烦——
 *   小米浏览器没有可用的 DevTools socket，控制台也读不到。
 *   所以让页面**自己把结果显示成大号文字**，截图就能看清，
 *   不需要任何额外工具。
 *
 * 测什么（都是单机版能不能成立的前提）：
 *   1. 原生 IndexedDB 能不能建库、写、读
 *   2. PouchDB（单机版实际用的）能不能建库、写、读
 *   3. 单机版真正关心的：**存一个产品 → 刷新 → 还在不在**
 *
 * 用法：node tools/make-storage-probe.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const APP = path.join(import.meta.dirname, '..');
const OUT = path.join(APP, 'dist', '存储探测.html');
const POUCH = path.join(APP, 'public', 'vendor', 'pouchdb.min.js');
const pouch = await fs.readFile(POUCH, 'utf-8');

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>存储探测</title>
<style>
  body{margin:0;padding:18px;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
       background:#111;color:#eee;font-size:20px;line-height:1.6}
  h1{font-size:26px;margin:0 0 14px}
  .row{padding:12px 14px;margin-bottom:10px;border-radius:10px;font-weight:700;font-size:22px}
  .ok{background:#0d3d1f;color:#6ee7a0;border:2px solid #1a7f45}
  .bad{background:#4a1414;color:#ff9b9b;border:2px solid #a12b2b}
  .wait{background:#333;color:#bbb}
  .meta{font-size:16px;color:#999;margin-top:14px;word-break:break-all}
  .big{font-size:40px;text-align:center;padding:22px;border-radius:12px;margin:16px 0;font-weight:800}
</style></head><body>
<h1>存储能力探测</h1>
<div id="rows"></div>
<div class="meta" id="meta"></div>

<script>${pouch.replace(/\/\/# sourceMappingURL=.*$/m, '')}</script>
<script>
(function () {
  var rows = document.getElementById('rows');
  function add(id, label, state, detail) {
    var d = document.createElement('div');
    d.id = id;
    d.className = 'row ' + state;
    d.textContent = (state === 'ok' ? '✅ ' : state === 'bad' ? '❌ ' : '⏳ ') + label
      + (detail ? '  —— ' + detail : '');
    rows.appendChild(d);
  }

  /* --- 1. 原生 IndexedDB --- */
  function rawIDB() {
    return new Promise(function (resolve) {
      try {
        var req = indexedDB.open('__raw__', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('s'); };
        req.onerror = function () { resolve({ ok: false, why: String(req.error) }); };
        req.onblocked = function () { resolve({ ok: false, why: '被阻塞' }); };
        req.onsuccess = function () {
          var db = req.result;
          var tx = db.transaction('s', 'readwrite');
          tx.objectStore('s').put(42, 'k');
          tx.oncomplete = function () {
            var tx2 = db.transaction('s', 'readonly');
            var g = tx2.objectStore('s').get('k');
            g.onsuccess = function () {
              var ok = g.result === 42;
              try { db.close(); indexedDB.deleteDatabase('__raw__'); } catch (e) {}
              resolve({ ok: ok, why: ok ? '' : '值不对：' + g.result });
            };
            g.onerror = function () { resolve({ ok: false, why: '读失败' }); };
          };
          tx.onerror = function () { resolve({ ok: false, why: '写失败：' + String(tx.error) }); };
        };
      } catch (e) { resolve({ ok: false, why: '异常：' + e.message }); }
    });
  }

  /* --- 2. PouchDB（单机版实际用的） --- */
  function pouchTest() {
    return new Promise(function (resolve) {
      try {
        var db = new PouchDB('__probe__');
        db.put({ _id: 'p', v: 7 })
          .then(function () { return db.get('p'); })
          .then(function (b) { return db.destroy().then(function () { resolve({ ok: b.v === 7, why: '' }); }); })
          .catch(function (e) { resolve({ ok: false, why: (e && e.name) + ' / ' + (e && e.message) }); });
      } catch (e) { resolve({ ok: false, why: '异常：' + e.message }); }
    });
  }

  /**
   * --- 3. 关键：跨刷新能不能留住数据 ---
   *
   * 这才是单机版真正依赖的能力：今天存的产品，明天打开还在。
   * 做法：读一个标记文档；第一次运行写进去，刷新后如果能读到 → 通过。
   */
  function persistTest() {
    return new Promise(function (resolve) {
      var db = new PouchDB('__persist__');
      db.get('marker').then(function (doc) {
        // 已经存在 → 说明上次写的还在，持久化成立
        resolve({ ok: true, why: '第二次打开，读到上次写的标记（第 ' + doc.n + ' 次）', keep: true });
      }).catch(function () {
        db.put({ _id: 'marker', n: 1, at: Date.now() }).then(function () {
          resolve({ ok: true, why: '第一次运行，已写入标记 —— 请刷新页面再看', keep: false });
        }).catch(function (e) {
          resolve({ ok: false, why: '写入失败：' + e.name + ' / ' + e.message });
        });
      });
    });
  }

  Promise.all([rawIDB(), pouchTest(), persistTest()]).then(function (r) {
    add('r1', '原生 IndexedDB', r[0].ok ? 'ok' : 'bad', r[0].why);
    add('r2', 'PouchDB', r[1].ok ? 'ok' : 'bad', r[1].why);
    add('r3', '跨刷新保留数据', r[2].ok ? 'ok' : 'bad', r[2].why);

    var allOk = r[0].ok && r[1].ok && r[2].ok;
    var banner = document.createElement('div');
    banner.className = 'big ' + (allOk ? 'ok' : 'bad');
    banner.textContent = allOk ? '全部通过' : '有问题，看上面';
    rows.insertBefore(banner, rows.firstChild);

    document.getElementById('meta').textContent =
      '协议 ' + location.protocol + '　origin ' + location.origin
      + '　UA ' + navigator.userAgent.slice(0, 90);

    // 标题也带上结果，方便用 adb 读（虽然通常读不到）
    document.title = (allOk ? 'OK' : 'FAIL')
      + ' idb=' + (r[0].ok ? '1' : '0')
      + ' pouch=' + (r[1].ok ? '1' : '0')
      + ' persist=' + (r[2].ok ? (r[2].keep ? 'kept' : 'first') : '0');
  });
})();
</script>
</body></html>`;

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, html, 'utf-8');
console.log(`  ✓ 探针：${path.relative(APP, OUT)}  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB`);
