# 家具经销商 · 电子画册与开单工具

[![验证](https://github.com/OWNER/REPO/actions/workflows/verify.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/verify.yml)

> ⬆️ 发布到 GitHub 后，把 `OWNER/REPO` 换成你的仓库路径，徽章就会亮起来。

**给一家家具经销商自己部署的开单工具。** 一条命令起服务，销售用手机浏览器干活，零安装。

**不做 ERP。** 只做两件事：

1. **产品管理 + 电子画册生成** —— 拍照录入，一键产出 PDF 画册发给客户
2. **出单记录** —— 销售出单，**互相看不到对方的单**

## 它不是什么

- **不是多租户 SaaS** —— 一家公司自己部署一套，只有自己人用
- **不是 CRM** —— 系统不管理客户；客户只是订单上的文本，是销售自己的资源
- **不是渠道分销平台** —— "厂家"只是货源标签，不是系统使用者

## 一句话说清它解决什么

家具销售的痛点是：**给客户报价时拿不出像样的画册，出的单又散落在微信和纸上。**

这个工具把这两件事合成一件事：销售在手机上选货 → 自动算出报价 →
一键生成带图的 PDF 画册发给客户 → 客户有意向就直接开单。
**单子只存在这个销售自己名下**，别的销售看不到，成交价也不会外泄。

## 唯一的隔离需求

**把不同销售人员的出单区分开。** 仅此一项：

```
订单（order: / orderrev:）  按 sales_id 隔离   → 销售只看自己出的单，admin 看全部
产品等共享文档              全公司可见         → 不做隔离
```

> **授权在哪里执行**：在**服务端**（`app/server/sync.mjs`），不在 CouchDB。
> 实测确认靠 CouchDB 的 `userCtx` 行不通——同步全经过服务端代理，
> 而代理只能用一个账号连库。详见主文档 §10.3.4。

## 快速开始

需要 **Docker**。就四步：

```bash
cd deploy
cp .env.example .env          # 改掉里面的 COUCHDB_ADMIN_PASS
docker compose up -d
docker compose logs app       # 取初始密码（只打印一次）
```

然后浏览器打开 `https://<你的地址>`。

**HTTPS 由 Caddy 自动配好**：填 IP 用内部 CA（浏览器首次点一次信任），
填域名自动申请 Let's Encrypt 可信证书。

建库、建账号、写权限文档、装中文字体全部自动完成。

> ⚠️ **这一步不能省 HTTPS**：没有它，登录密码是明文过网的，密码认证等于白做。

完整步骤（端口冲突、证书警告、备份、排障）见
[`deploy/README.md`](deploy/README.md)。

## 装好之后怎么用

| 谁 | 做什么 |
|---|---|
| **管理员**（admin） | 设置页里新建销售账号、重置密码、停用离职人员 |
| **销售** | 登录 → 产品页拍照录入 → 开单选货 → 一键出画册 PDF 发客户 |

- 客户端是**浏览器**，销售只拿到一个网址。不用装 App
- 服务端 CouchDB 是**权威副本**，本地库只作缓存：手机被清理也不会丢单
- **断网也能开单**，恢复网络后自动补传，界面上明确标"未同步"

详见主文档 [§2b 部署简易性要求](docs/项目主文档.md)。

## 📖 项目文档

**唯一真相源：[`docs/项目主文档.md`](docs/项目主文档.md)**

所有设计决策、数据模型、技术选型、依赖实测结论、开工优先级都在其中。
本 README 只做导航，不重复内容——避免出现两份互相矛盾的说明。

各步的实测证据（含复现命令与环境踩坑）：

| 步骤 | 结论文档 |
|---|---|
| 第 1 步 过滤同步协议层 | [`sync/docs/第1步验证结论-过滤同步.md`](sync/docs/第1步验证结论-过滤同步.md) |
| 第 2 步 产品与画册 | [`app/docs/第2步验证结论-产品与画册.md`](app/docs/第2步验证结论-产品与画册.md) |
| 第 3 步 出单模块 | [`app/docs/第3步验证结论-出单模块.md`](app/docs/第3步验证结论-出单模块.md) |
| 第 4 步 出单隔离接入同步 | [`app/docs/第4步验证结论-出单隔离接入同步.md`](app/docs/第4步验证结论-出单隔离接入同步.md) |
| 附加 密码登录认证 | [`app/docs/认证验证结论-密码登录.md`](app/docs/认证验证结论-密码登录.md) |
| 附加 账号管理 | [`app/docs/账号管理验证结论.md`](app/docs/账号管理验证结论.md) |
| 第 6 步 一键部署 | [`app/docs/第6步验证结论-一键部署.md`](app/docs/第6步验证结论-一键部署.md) |
| 画册生成链路 | [`catalog/docs/画册链路验证结论.md`](catalog/docs/画册链路验证结论.md) |

这些都是主文档所引用的证据；**若不一致，以主文档为准**。
里面记录了**踩过的坑和判断错的地方**，不是"一切顺利"的流水账——
想改这个项目的人值得先看一遍。

## 已确认的关键决策

| 决策项 | 结论 |
|---|---|
| 项目许可 | **GPL-3.0** |
| 使用范围 | **同一家经销商公司内部**，非多租户 |
| 唯一的隔离规则 | **订单按 `sales_id` 过滤** —— 销售只看自己出的单，admin 看全部 |
| 授权执行点 | **服务端**（不是 CouchDB 的 `userCtx`，实测行不通） |
| 画册生成 | **Puppeteer + Chromium** —— `pdf-catalog-generator` 已实测证伪（中文乱码） |
| 出单模型 | 订单不可变 + 追加式修订 + `UNIQUE(order_id, version)` 原子冲突检测 |
| 删除语义 | **只允许软删除**（硬删会丢业务字段，实测确认） |
| 密码存储 | Node 内置 `scrypt` + 恒定时间比较，**零外部依赖** |
| 密码找回 | **管理员重置**（不做短信/邮件自助，理由见[账号管理结论](app/docs/账号管理验证结论.md) §7） |
| 兼容性基线 | iOS 15+ / Android 8+（待最终确认） |

## 目录结构

```
furniture-sales-tool/
├── LICENSE                        GPL-3.0
├── docs/
│   ├── 项目主文档.md              ★ 唯一真相源（设计决策、数据模型、实测结论）
│   └── _archive/                  早期评估，仅存档
├── deploy/                        ★ 部署（Docker Compose 三容器）
│   ├── README.md                      给装机的人看的傻瓜化指南
│   ├── docker-compose.yml             CouchDB + 应用 + Caddy(HTTPS)
│   ├── Dockerfile                     含 Chromium 与中文字体
│   └── Caddyfile                      HTTPS 与证书自动管理
├── app/                           应用主体（服务端零外部依赖，只要 Node）
│   ├── server/
│   │   ├── index.mjs                  HTTP 服务 + 路由
│   │   ├── sync.mjs                   ★ 授权执行点（销售只能读写自己的单）
│   │   ├── startup.mjs                启动自检（等 CouchDB、自动建库建账号）
│   │   ├── sales.mjs                  账号与身份
│   │   ├── password.mjs               scrypt 密码哈希
│   │   ├── auth.mjs                   会话
│   │   ├── store.mjs                  产品与设置
│   │   ├── orders.mjs                 订单业务规则（供测试）
│   │   └── render-catalog.mjs         画册渲染 + 分页断言 + PDF
│   ├── public/                        界面（手机优先）
│   │   ├── app.mjs syncdb.mjs style.css index.html
│   │   └── vendor/pouchdb.min.js      第三方构建（用 tools/vendor-pouchdb.mjs 生成）
│   ├── assets/sample-assets/          示例产品图（随镜像分发）
│   └── tools/                         七个验证脚本 + 初始化工具
├── catalog/                       画册链路验证工程（含失败方案的留存）
└── sync/                          过滤同步协议层验证工程
```

## 进度

```
第 0 步  前置决策                                    ✅ 已完成
第 1 步  PouchDB ↔ CouchDB 双向同步                   ✅ 已完成（22/22）
第 2 步  产品管理 + 画册生成                           ✅ 已完成
第 3 步  出单记录模块                                  ✅ 已完成（45/45）
第 4 步  出单隔离接入同步层                            ✅ 已完成（代理 23/23、端到端 20/20）
   附加  密码登录认证                                  ✅ 已完成（25/25）
   附加  账号管理（建号/重置/停用）                     ✅ 已完成（51/51）
第 5 步  数据迁移（把旧系统产品导进来）                 ⬜ 未开始（可选，手动录入已可用）
第 6 步  一键部署 + 自动 HTTPS                         ✅ 已完成
```

**全套验证共 239 项断言，当前全绿。** 每一条都是实测出来的，
过程与踩坑记录在各步的结论文档里（见下文"实测证据"）。

## 部署：一条命令

```bash
cd deploy
cp .env.example .env      # 改掉里面的 COUCHDB_ADMIN_PASS
docker compose up -d
docker compose logs app   # 取初始密码（只打印一次）
```

然后浏览器打开 `https://<你的地址>`。

**HTTPS 由 Caddy 自动配好**：填 IP 用内部 CA（浏览器首次点一次信任），
填域名自动申请 Let's Encrypt 可信证书。**这一步不能省**——没有 HTTPS，
登录密码是明文过网的，密码认证等于白做。

建库、建账号、写权限文档、装中文字体全部自动完成。

完整步骤（含端口冲突、证书警告、备份、排障）见
[`deploy/README.md`](deploy/README.md)。

## 本机开发（不用 Docker）

需要本机有一个 CouchDB（3.5 即可）。凭据放 `app/.env`，**不入库**。

```powershell
cd app
copy .env.example .env                                # 填 CouchDB 地址与管理员口令
node tools/seed-sample-data.mjs                       # 导入 5 款示例产品
$env:DEV_ALLOW_PASSWORDLESS_LOGIN='1'                 # 仅本机：允许验证脚本免密登录
node --env-file=.env server/index.mjs                 # 打开 http://127.0.0.1:8080
```

**首次启动会在日志里打印各账号的初始密码（只打印一次），首次登录后需修改。**

### 跑验证

七套脚本，共 **239 项断言**。任意一套失败都会打印具名原因。

```powershell
node tools/verify-auth.mjs                            # 认证         25 项
node tools/verify-accounts.mjs                        # 账号管理     51 项
node tools/verify-orders.mjs                          # 出单模块     45 项
node --env-file=.env tools/verify-real-couchdb.mjs     # 同步与隔离   22 项
node tools/verify-sync-proxy.mjs                      # 同步代理授权 23 项
node --env-file=.env tools/verify-e2e-sync.mjs         # 端到端同步   20 项
node --env-file=.env tools/ui-screenshot.mjs           # 界面         75 项
```

- `verify-auth.mjs` / `verify-accounts.mjs` 需要初始密码：
  从服务端启动日志取，用 `$env:PW_ADMIN="…"` 这类环境变量传入
- 界面与端到端脚本需要 Chromium（本机用 `catalog/` 里装的 puppeteer；
  容器里自动改用系统 Chromium，见 `tools/browser.mjs`）

> ⚠️ `verify-orders.mjs` 会清空本地订单数据后重建，**不要在正式数据上运行**。

## 数据流

```
销售浏览器
├── 本地 PouchDB (IndexedDB)   订单列表读这里，离线可用
│     └── _local/unsynced       待上行清单 → 列表上显示"未同步"
│   push / pull（必须用绝对 URL，见主文档 §10.3.4.2）
▼
服务端（会话认证：账号 + 密码，scrypt 哈希）
└── 同步代理 /api/sync/orders/*   授权在这里执行：销售只能读写自己的单
▼
CouchDB orders 库              权威副本：手机被清理也不丢单
```

## 已知限制

诚实列出，便于判断能不能上生产：

| 限制 | 影响 | 优先级 |
|---|---|---|
| **产品数据不参与多端同步** | 产品存在服务端本地文件；多实例部署时各自一份。**单实例部署无影响** | 🟠 |
| **登录失败无次数限制** | 理论上可暴力破解密码。内网部署风险较低 | 🟠 |
| **无操作审计日志** | 看不出"谁改了谁的账号" | 🟠 |
| 服务端出画册 PDF 未在容器实测 | 镜像里已带 Chromium；**「打印为 PDF」那条路径更可靠**，是给销售的默认路径 | 🟡 |
| 示例数据是程序画的示意图，不是真家具照片 | 只影响第一眼观感。换真照片只需替换 `app/assets/sample-assets/` | 🟡 |
| 账号不能改名 | 登录名就是订单归属，改名会让历史订单对不上。这是刻意的 | ✅ 设计如此 |
| 兼容性基线未最终确认 | 建议 iOS 15+ / Android 8+ | 🟡 |

完整的争议与技术债务登记见主文档 §16。

## 贡献

欢迎提 Issue 和 PR。这个项目有个明确的做事方式：

**所有结论都要有实测证据，不接受"看起来应该对"。**

- 每个功能都有对应的验证脚本（`app/tools/verify-*.mjs`），
  改完请跑一遍：`node tools/verify-xxx.mjs`
- 修 bug 时，**先写一条能复现它的断言**，再修。这样它能被永久盯住
- 结论文档里记录失败方案与判断错误，不是流水账——
  知道"什么行不通"和知道"什么行得通"一样重要

CI 会在每次推送时跑后端五套验证（见 `.github/workflows/verify.yml`）。

## 许可

[GPL-3.0](LICENSE)。

> 说明：项目曾计划复用 [Aam Digital](https://github.com/Aam-Digital/ndb-core) 的权限过滤层
> （GPL-3.0），但最终**没有采用**——实测发现同步全经过服务端代理后，
> CouchDB 的 `userCtx` 无法反映真实用户，于是改为服务端授权。
> 因此当前代码**不包含**第三方项目代码，GPL-3.0 是本项目主动选择的许可。

