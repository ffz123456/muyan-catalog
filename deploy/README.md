# 部署指南

**对装机的人来说，只有四步。** 建库、建账号、写权限文档、装中文字体全部自动完成。

---

## 一、你需要什么

| 项 | 要求 |
|---|---|
| 一台机器 | Windows / Linux / NAS 都行，能装 Docker |
| Docker | 已装并启动（`docker --version` 能出结果） |
| 端口 | 默认用 80 与 443；被占用时可改成别的（见下文） |
| 磁盘 | 1 GB 以上（镜像约 700 MB） |

**不需要**自己装 Node、CouchDB、数据库、字体——全在容器里。

---

## 二、四步装完

### 第 1 步：拿到项目并准备配置

```bash
cd furniture-sales-tool/deploy
copy .env.example .env          # Linux/macOS 用 cp
```

打开 `.env`，**至少改这两个**：

```ini
# CouchDB 管理员密码 —— 改成你自己的强密码
COUCHDB_ADMIN_PASS=change-me-please

# 对外访问地址 —— 决定 HTTPS 证书方式
SITE_ADDRESS=localhost
```

`SITE_ADDRESS` 怎么填：

| 你的场景 | 填什么 | HTTPS 证书 |
|---|---|---|
| 本机试用 | `localhost` | 自动生成内部证书，浏览器首次需点"继续" |
| **局域网部署（最常见）** | 本机局域网 IP，如 `192.168.1.10` | 同上 |
| 有公网域名 | `orders.example.com` | 自动申请 Let's Encrypt **可信**证书，浏览器不报错 |

### 第 2 步：启动

```bash
docker compose up -d
```

第一次会构建镜像，约 2–5 分钟。之后启动只需几秒。

### 第 3 步：取初始密码

**每个销售账号的初始密码只打印一次**，启动日志里有：

```bash
docker compose logs app
```

找这段：

```
⚠️  首次运行，已生成初始密码（**只显示这一次，请立即记下**）：
      admin    xxxxxxxxxx      （管理者）
      alice    yyyyyyyyyy      （销售 A）
      bob      zzzzzzzzzz      （销售 B）
```

（上面是**格式示例**。实际密码由系统随机生成，每个部署都不一样。）

**立刻记下来。** 这张表不会再打印。忘了只能删掉数据卷重新初始化（会清空所有数据）。

### 第 4 步：打开使用

浏览器访问 `https://<SITE_ADDRESS>`（用了非标准端口就带上，如 `https://192.168.1.10:8443`）。

- **首次访问**：若 `SITE_ADDRESS` 是 IP 或 localhost，浏览器会警告证书不受信任。
  这是因为用的是内网自签证书。点「高级」→「继续前往」即可。
  想彻底去掉警告，把 Caddy 的根证书装到各台设备上（见下文第五节）。
- 用上面记下的账号密码登录，**首次登录会要求改密码**。
- 给销售的就是**这个网址**。他们不需要装任何东西。

---

## 三、日常运维

```bash
docker compose ps                 # 看状态
docker compose logs -f app        # 跟日志（排障用）
docker compose restart app        # 重启应用
docker compose down               # 停止（数据保留在卷里）
docker compose up -d              # 再启动
```

**数据在哪**：都在 Docker 卷里（`couchdb-data` 订单、`app-data` 产品与账号）。
`docker compose down` 不会删数据。**只有 `docker compose down -v` 才会删**，别手滑。

**备份**：备份这两个卷即可。

```bash
docker run --rm -v deploy_couchdb-data:/data -v %CD%:/backup alpine \
  tar czf /backup/couchdb-$(date +%Y%m%d).tar.gz -C /data .
```

---

## 四、端口被占用怎么办

NAS 上 80/443 常被别的服务占了。在 `.env` 里改：

```ini
HTTP_PORT=8080
HTTPS_PORT=8443
```

然后访问 `https://<地址>:8443`。HTTP 会自动跳转到这个端口，不用额外配。

---

## 五、去掉浏览器的证书警告（可选）

`SITE_ADDRESS` 是 IP 时，Caddy 用内部 CA 签发证书，浏览器不认。三种处理：

1. **最简单**：每次点「高级 → 继续」。内网自用可以接受。
2. **装根证书**：从 Caddy 容器导出根证书，装到各台设备上。
   ```bash
   docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
   ```
   把这文件发给各台设备，双击安装到「受信任的根证书颁发机构」。
3. **有域名就用域名**：填了公网域名后 Caddy 会自动申请可信证书，什么都不用做。

> ⚠️ **不要为了省事关掉 HTTPS。** 登录密码是明文过网的，
> 没有 HTTPS 的话，密码认证等于白做。

---

## 六、这套东西由哪几个容器组成

| 容器 | 作用 | 对外端口 |
|---|---|---|
| `fs-couchdb` | 订单的权威副本（CouchDB） | 不暴露，仅内网 |
| `fs-app` | 服务端 + 界面 + 同步代理（**授权在这里执行**） | 不暴露，仅内网 |
| `fs-caddy` | HTTPS 反代，自动管证书 | 80 / 443 |

**只有 Caddy 对外**。CouchDB 与应用都在 Docker 内网里，
外面连不上——减少暴露面。

---

## 七、排障

| 现象 | 原因与处理 |
|---|---|
| 打开是「无法连接」 | 容器没起来。`docker compose ps` 看状态、`docker compose logs` 看错误 |
| 证书警告去不掉 | 正常（内网自签）。见第五节 |
| 忘了初始密码 | 只能重置：`docker compose down`，删掉 `app-data` 卷，重新 `up`。**会清空产品与账号** |
| 销售看不到自己以前的单 | 确认他用的是自己的账号（订单按账号隔离） |
| 同步一直显示"未同步" | 看 `docker compose logs app`。多半是 CouchDB 连不上 |
| 画册生成失败 | 服务端出 PDF 需要 Chromium，镜像里已带。若报错看日志里的具体原因 |

---

## 八、部署前检查清单

- [ ] `COUCHDB_ADMIN_PASS` 已改成强密码（不是默认值）
- [ ] `SITE_ADDRESS` 填的是销售实际会访问的地址
- [ ] **HTTPS 能正常打开**（不是 HTTP）
- [ ] 初始密码已记录，且各销售已完成首次改密
- [ ] 已知晓备份方式（备份 `couchdb-data` 与 `app-data` 两个卷）

---

## 九、当前版本的已知限制

诚实列出，便于你判断能不能上生产：

| 限制 | 影响 |
|---|---|
| **产品数据不支持多端同步** | 产品存在服务端本地文件；一处修改不会同步到其他部署实例。单实例部署无影响 |
| 无登录失败限流 | 理论上可暴力破解密码。内网风险较低 |
| 管理员不能重置他人密码 | 忘了密码只能重置整个 `app-data` 卷 |
| 销售账号增删需改数据文件 | 界面里没有账号管理 |
| 没有数据迁移工具 | 从旧小程序导入产品仍是手工活（第 5 步，未做） |
