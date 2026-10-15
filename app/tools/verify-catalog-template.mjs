/**
 * 画册模板功能验证：封面 Logo、分类分节、页码、有效期
 *
 * 这几项代码里都有，但"代码在"不等于"真的生效"——
 * 比如 Logo 传进去了却因为 CSS 高度为 0 而看不见，
 * 或者分节时某个品类被漏掉。所以逐项验渲染结果。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSuite } from './assert-lib.mjs';
import { renderCatalogHtml, PER_PAGE } from '../server/render-catalog.mjs';
import { ASSET_DIR } from '../server/datadir.mjs';

const s = createSuite('画册模板功能');

const noImg = async () => null;

/* ---------- 造数据：三个品类，数量刻意不等 ---------- */
const products = [
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `a${i}`, name: `沙发 ${i + 1}`, category: '客厅 · 沙发',
    specs: '尺寸', highlights: '现货', price: 4000 + i, stockStatus: '现货', images: [],
  })),
  ...Array.from({ length: 2 }, (_, i) => ({
    id: `b${i}`, name: `餐桌 ${i + 1}`, category: '餐厅 · 餐桌',
    specs: '尺寸', highlights: '现货', price: 3000 + i, stockStatus: '现货', images: [],
  })),
  {
    id: 'c0', name: '书桌 1', category: '书房 · 书桌',
    specs: '尺寸', highlights: '定制', price: 2000, stockStatus: '定制 15 天', images: [],
  },
];

const baseSettings = {
  companyName: '林氏家居', tagline: '全屋定制', contact: '138-0000-0000 · 微信 linshi', validityDays: 30,
};

/* ------------------------------------------------------------------ */
s.group('【1】封面 Logo');
{
  // 造一个真 PNG 当 logo（不用假字节：假图在浏览器里根本显示不出来）
  const { findBrowserExecutable } = await import('../server/browser.mjs');
  const sampleBuf = await fs.readFile(path.join(import.meta.dirname, '..', 'assets', 'sample-assets', 'sofa.png'));
  const logoName = 'test-logo.png';
  await fs.mkdir(ASSET_DIR, { recursive: true });
  await fs.writeFile(path.join(ASSET_DIR, logoName), sampleBuf);

  const withLogo = await renderCatalogHtml({
    products, settings: { ...baseSettings, logo: logoName }, resolveImage: noImg,
  });
  s.check('有 logo 时封面上出现 <img class="cover-logo">',
    /<img class="cover-logo" src="data:image\/png;base64,/.test(withLogo),
    '必须是内嵌的 data URI —— 画册要自包含，不能引用外部文件');
  s.check('logo 不是空 src', !/cover-logo" src=""/.test(withLogo));

  const withoutLogo = await renderCatalogHtml({ products, settings: baseSettings, resolveImage: noImg });
  s.check('没有 logo 时不出现那个 img（不留空框）',
    !/cover-logo/.test(withoutLogo.replace(/\.cover-logo\s*\{[^}]*\}/, '')),
    'CSS 规则里的选择器不算，要看 HTML 里有没有用');

  // logo 取不到时不能把整本画册搞崩
  const badLogo = await renderCatalogHtml({
    products, settings: { ...baseSettings, logo: '不存在的文件.png' }, resolveImage: noImg,
  });
  s.check('logo 文件缺失时画册照样生成（不留白框、不报错）',
    badLogo.includes('林氏家居') && !/cover-logo" src/.test(badLogo));
}

s.group('【2】分类分节');
{
  const grouped = await renderCatalogHtml({
    products, settings: baseSettings, groupByCategory: true, resolveImage: noImg,
  });

  s.check('三个品类都出现在页眉里',
    grouped.includes('客厅 · 沙发') && grouped.includes('餐厅 · 餐桌') && grouped.includes('书房 · 书桌'));

  // 5 款沙发 → 2 页（4 + 1），第二页标题要标"续"
  s.check('超过一页的品类标「（续）」', grouped.includes('客厅 · 沙发（续）'),
    '5 款沙发 = 2 页，第二页应该标续');

  /**
   * ⚠️ 数页面时**不能**写 `<section class="page"`。
   *    封面是 `<section class="page cover">`，属性值后面不是引号，
   *    那个正则数不到封面 —— 我第一版就是这么写的，两处断言都少了 1。
   *    正确做法是数 `class="page`（不带收尾引号），或者直接数网格。
   */
  const countPages = (html) => (html.match(/class="page[\s"]/g) ?? []).length;

  // 分节时每节各自起页：沙发 2 页 + 餐桌 1 页 + 书桌 1 页 = 4 页 + 封面
  s.check('每节各自起页（不跨节混排）', countPages(grouped) === 5,
    `封面 + 4 页产品 = 5，实际 ${countPages(grouped)}`);

  // 不分节时：8 款 → 2 页
  const flat = await renderCatalogHtml({
    products, settings: baseSettings, groupByCategory: false, resolveImage: noImg,
  });
  s.check('不分节时按数量连续排', countPages(flat) === 3,
    `封面 + 2 页 = 3，实际 ${countPages(flat)}`);
  s.check('不分节时页眉写「产品目录」', flat.includes('产品目录'));
}

s.group('【3】封面信息');
{
  const html = await renderCatalogHtml({
    products, settings: baseSettings, resolveImage: noImg,
  });
  s.check('封面有公司名', html.includes('林氏家居'));
  s.check('封面有标语', html.includes('全屋定制'));
  s.check('封面有联系方式', html.includes('138-0000-0000'));
  s.check('封面标了共几款', html.includes(`共 ${products.length} 款`));
  s.check('封面有报价有效期', /报价有效期至/.test(html),
    '有效期是"报价凭证"的一部分，不能省');

  // 不设有效期时不该出现那行
  const noValid = await renderCatalogHtml({
    products, settings: { ...baseSettings, validityDays: 0 }, resolveImage: noImg,
  });
  s.check('不设有效期时不显示那一行', !/报价有效期至/.test(noValid));
}

s.group('【4】页眉页脚');
{
  const html = await renderCatalogHtml({ products, settings: baseSettings, resolveImage: noImg });
  s.check('每页页脚有公司名', (html.match(/class="foot"/g) ?? []).length > 0);
  s.check('页眉注明"价格含税"', html.includes('价格含税'),
    '含税与否是成交时要紧的信息');
  s.check('页眉有生成时间', /生成于/.test(html));
}

s.group('【5】特殊字符不会破坏 HTML');
{
  const nasty = await renderCatalogHtml({
    products: [{
      id: 'x', name: '<script>alert(1)</script>', category: '客厅 & 沙发',
      specs: '尺寸 "2200" <b>', highlights: 'a/b', price: 100, stockStatus: '现货', images: [],
    }],
    settings: { ...baseSettings, companyName: '<b>坏公司</b>', tagline: 'a & b' },
    resolveImage: noImg,
  });
  s.check('产品名里的标签被转义（不会执行）',
    !nasty.includes('<script>alert(1)</script>'), '必须转义成 &lt;script&gt;');
  s.check('公司名里的标签被转义', !nasty.includes('<b>坏公司</b>'));
  s.check('& 号被转义', nasty.includes('&amp;'));
}

const { failed } = s.summary();
process.exitCode = failed.length ? 1 : 0;
