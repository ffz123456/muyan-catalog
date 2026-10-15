/**
 * 诊断：单机版在 file:// 下 IndexedDB 到底能不能用
 *
 * 单机版全部数据都在本机 IndexedDB 里，所以这是它能不能成立的**前提**。
 * 上一版检查报了 "unknown"（异常没有 message），看不出原因，所以单独查。
 */
import path from 'node:path';
import { findBrowserExecutable } from '../server/browser.mjs';

const APP = path.join(import.meta.dirname, '..');
const OUT = path.join(APP, 'dist', '木言-单机版.html');
const exe = findBrowserExecutable();

const puppeteer = (await import('puppeteer-core')).default;
const browser = await puppeteer.launch({
  headless: true, executablePath: exe, args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror] ' + e.message));

await page.goto('file:///' + OUT.replace(/\\/g, '/'), { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 3000));

console.log('  环境自检');
const env = await page.evaluate(() => ({
  origin: location.origin,
  protocol: location.protocol,
  hasIndexedDB: typeof indexedDB,
  hasPouchDBGlobal: typeof window.PouchDB,
  hasPouchDBBare: typeof PouchDB,
  hasIDBFactory: typeof IDBFactory,
}));
for (const [k, v] of Object.entries(env)) console.log(`    ${k.padEnd(20)} ${v}`);

console.log('\n  直接用原生 IndexedDB 试（绕开 PouchDB）');
const raw = await page.evaluate(() => new Promise((resolve) => {
  try {
    const req = indexedDB.open('__rawprobe__', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('s');
    req.onerror = () => resolve({ ok: false, where: 'open', err: String(req.error) });
    req.onblocked = () => resolve({ ok: false, where: 'blocked' });
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('s', 'readwrite');
        tx.objectStore('s').put(42, 'k');
        tx.oncomplete = () => {
          const tx2 = db.transaction('s', 'readonly');
          const g = tx2.objectStore('s').get('k');
          g.onsuccess = () => { db.close(); indexedDB.deleteDatabase('__rawprobe__'); resolve({ ok: g.result === 42, got: g.result }); };
          g.onerror = () => resolve({ ok: false, where: 'get', err: String(g.error) });
        };
        tx.onerror = () => resolve({ ok: false, where: 'put', err: String(tx.error) });
      } catch (e) { resolve({ ok: false, where: 'tx', err: String(e) }); }
    };
  } catch (e) { resolve({ ok: false, where: 'throw', err: String(e) }); }
}));
console.log('    ' + JSON.stringify(raw));

console.log('\n  再用 PouchDB 试（和单机版同一条路）');
const pd = await page.evaluate(() => new Promise((resolve) => {
  const done = (o) => resolve(o);
  try {
    if (typeof window.PouchDB === 'undefined') return done({ ok: false, where: 'no-global' });
    const db = new window.PouchDB('__pdprobe__');
    db.put({ _id: 'probe', v: 42 }).then(() => db.get('probe')).then((back) => {
      return db.destroy().then(() => done({ ok: back.v === 42, got: back.v }));
    }).catch((e) => done({
      ok: false, where: 'pouch',
      name: e && e.name, msg: e && e.message, err: e && String(e),
    }));
  } catch (e) { done({ ok: false, where: 'throw', err: String(e) }); }
}));
console.log('    ' + JSON.stringify(pd, null, 2).split('\n').join('\n    '));

await browser.close();
