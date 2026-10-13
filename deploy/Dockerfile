# 家具经销商 · 电子画册与开单工具
#
# 设计要点：
#   1. **不复制整个仓库**，只带 app/ 与画册验证工程需要的部分，
#      镜像更小、启动更快。
#   2. **中文字体固定在镜像里**——画册生成依赖 CJK 字体，
#      若依赖宿主系统字体，缺字体的机器上画册会静默变成乱码
#      （与 pdf-catalog-generator 是同一类失败模式，见主文档 §12.4）。
#   3. 画册出 PDF 需要 Chromium；这里装系统的 chromium 包，
#      比让 puppeteer 自己下载更干净（可用 PUPPETEER_EXECUTABLE_PATH 指向它）。
#   4. 应用服务端本身**零 npm 依赖**，所以没有 npm install 步骤。

FROM node:24-bookworm-slim

# --- 系统依赖 ---------------------------------------------------------
# chromium     : 画册出 PDF
# fonts-noto-cjk: 中文字体（必须固定进镜像）
# tini         : 正确处理信号，容器能优雅退出
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      tini \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 让 puppeteer 用系统 chromium，不再自行下载
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /srv

# --- 应用代码（零依赖，直接拷） ---------------------------------------
COPY app/package.json ./app/package.json
COPY app/server ./app/server
COPY app/public ./app/public
COPY app/tools ./app/tools
# shared/ 是服务端与浏览器**共用**的逻辑（画册排版等）。
# 漏掉它会让画册接口直接 500 —— 实测踩过。
COPY app/shared ./app/shared

# 内置的示例图片素材（50 KB）。有了它，容器里执行种子数据也能种出带图的示例产品，
# 否则第一次打开会是空列表——对"不想学"的用户，空白页等于"这东西坏了"。
#
# ⚠️ 放在 assets/ 而不是 data/：data/ 会被数据卷挂载覆盖，
#    放在那里的文件在容器里看不见（实测踩过——素材"存在"但读不到）。
#    素材属于只读的代码资产，数据目录只放用户产生的内容。
COPY app/assets/sample-assets ./app/assets/sample-assets

# 两个 npm 依赖，都是**可选**的：
#   puppeteer-core : 服务端出画册 PDF（用系统 chromium，见上面的 ENV）
#   pouchdb        : 仅验证脚本 verify-real-couchdb.mjs 需要
# 服务端运行本身零依赖，所以即使这里装失败，应用照常可用
# （出 PDF 那条路会明确提示"未安装 puppeteer"并建议改用浏览器打印）。
RUN cd app && npm install --omit=dev --no-audit --no-fund puppeteer-core pouchdb 2>/dev/null || true

# --- 运行期目录（挂载卷覆盖） -----------------------------------------
RUN mkdir -p /srv/app/data

# 默认参数；可用环境变量覆盖
ENV PORT=8080 \
    HOST=0.0.0.0 \
    COUCHDB_URL=http://couchdb:5984 \
    COUCHDB_DB=orders

EXPOSE 8080

# tini 作为 1 号进程，保证 SIGTERM 能传到 node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "app/server/index.mjs"]
