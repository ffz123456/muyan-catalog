/**
 * 浏览器启动的统一入口 —— 让验证脚本在本机与容器里都能跑。
 *
 * 为什么要抽出来：
 *   本机开发时装的是完整 `puppeteer`（自带那份 Chromium）；
 *   容器里为了让镜像可控，装的是 `puppeteer-core` +
 *   系统 `/usr/bin/chromium`（见 deploy/Dockerfile）。
 *   两个脚本各自硬编码一种布局，换环境就报模块找不到。
 *
 * 选择顺序：
 *   1. `puppeteer-core` + PUPPETEER_EXECUTABLE_PATH   （容器）
 *   2. `puppeteer`                                     （本机开发）
 *
 * 顺便统一了启动参数：容器里没有 /dev/shm 的足够空间，
 * 不加 --disable-dev-shm-usage 会随机崩。
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const APP_DIR = path.join(import.meta.dirname, '..');

/** 依次尝试多个 require 锚点，返回第一个能找到的模块。 */
function tryRequire(names) {
  const anchors = [
    path.join(APP_DIR, 'package.json'),                      // 容器：app/node_modules
    path.join(APP_DIR, '..', 'catalog', 'package.json'),     // 本机：catalog/node_modules
    path.join(APP_DIR, '..', 'sync', 'package.json'),        // 备选
  ];
  const tried = [];
  for (const name of names) {
    for (const a of anchors) {
      try {
        return { name, mod: createRequire(a)(name) };
      } catch (e) {
        tried.push(`${name} @ ${a}: ${e.code ?? e.message}`);
      }
    }
  }
  return { name: null, mod: null, tried };
}

/** 取得 puppeteer（core 或完整版）并启动浏览器。 */
export async function launchBrowser({ userDataDir } = {}) {
  const { mod: puppeteer, name } = tryRequire(['puppeteer-core', 'puppeteer']);
  if (!puppeteer) {
    throw new Error(
      '找不到 puppeteer 或 puppeteer-core。\n'
      + '  本机开发：cd catalog && npm install\n'
      + '  容器部署：镜像里已带，无需安装\n',
    );
  }

  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  const browser = await puppeteer.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    ...(userDataDir ? { userDataDir } : {}),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--font-render-hinting=none',
    ],
  });

  // 挂到返回值上，便于调用方在日志里说明用的是哪一种
  browser.__source = name;
  browser.__executable = executablePath ?? '(puppeteer 自带)';
  return browser;
}

export const browserInfo = () => ({
  source: process.env.PUPPETEER_EXECUTABLE_PATH ? 'puppeteer-core + 系统 Chromium' : 'puppeteer 自带',
});

/**
 * 以某个身份登录，自动在"免密入口"与"真实密码"之间选择。
 *
 * 为什么要这样：本机开发开着免密入口，容器部署（生产配置）是关的，
 * 脚本若写死一种，换个环境就断。密码从 `PW_<名字大写>` 环境变量取。
 *
 * @returns {{status:number, how:string, body:string}}
 */
export async function loginAs(page, name) {
  const envKey = `PW_${name.toUpperCase()}`;
  const password = process.env[envKey] ?? '';
  const r = await page.evaluate(async ({ n, pw }) => {
    const tryLogin = async (body) => {
      const res = await fetch(new URL('/api/session', location.origin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.text()).slice(0, 160) };
    };
    const dev = await tryLogin({ name: n, devNoPassword: true });
    if (dev.status === 200) return { ...dev, how: '免密入口' };
    if (!pw) return { ...dev, how: `免密入口（未提供 ${'PW_' + n.toUpperCase()}）` };
    const real = await tryLogin({ name: n, password: pw });
    return { ...real, how: '密码' };
  }, { n: name, pw: password });
  void envKey;
  return r;
}
