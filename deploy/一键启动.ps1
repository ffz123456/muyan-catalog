# 木言 · 开单画册 —— Windows 一键启动
#
# 用法：右键「使用 PowerShell 运行」，或者双击 `一键启动.bat`。
#
# 它做什么：
#   1. 检查 Docker 是否装了、是否在运行
#   2. 生成配置（含随机 CouchDB 管理员密码）
#   3. 启动三个容器（数据库 / 应用 / HTTPS）
#   4. 等就绪后打开浏览器
#
# 为什么用 Docker 而不是打一个自带数据库的绿色包：
#   见 deploy/WINDOWS.md 里的说明——内置 CouchDB 的便携方案
#   在开发机上没能验证通过（Erlang 的 os_mon 端口程序起不来），
#   而 Docker 方案是本机完整实测过的。宁可给你一个验证过的。

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$DeployDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $DeployDir

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Ok($msg)   { Write-Host "  [OK] $msg"   -ForegroundColor Green }
function Warn($msg) { Write-Host "  [注意] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  [错误] $msg" -ForegroundColor Red }

Say ''
Say '  ┌─────────────────────────────────────────────┐' Cyan
Say '  │   木言 · 开单画册           │' Cyan
Say '  └─────────────────────────────────────────────┘' Cyan
Say ''

# ---------------------------------------------------------------- 检查 Docker
Say '  正在检查 Docker…'
$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
    Fail '没有找到 Docker。'
    Say ''
    Say '  这个程序需要 Docker Desktop 才能运行。'
    Say '  下载地址：https://www.docker.com/products/docker-desktop/'
    Say '  装好后启动 Docker Desktop，等托盘图标变绿，再运行本脚本。'
    Say ''
    Read-Host '  按回车键退出'
    exit 1
}
Ok "Docker 已安装（$($docker.Source)）"

# Docker 服务是否在跑
$ok = $false
try {
    $v = docker version --format '{{.Server.Version}}' 2>$null
    if ($LASTEXITCODE -eq 0 -and $v) { $ok = $true; Ok "Docker 服务运行中（$v）" }
} catch { }
if (-not $ok) {
    Fail 'Docker 装了，但服务没在运行。'
    Say ''
    Say '  请先启动 Docker Desktop（开始菜单里找），'
    Say '  等它的托盘图标不再转圈、变成稳定状态，再运行本脚本。'
    Say ''
    Read-Host '  按回车键退出'
    exit 1
}

# ---------------------------------------------------------------- 准备配置
if (-not (Test-Path (Join-Path $DeployDir '.env'))) {
    Say '  首次运行：正在生成配置…'

    # 随机管理员密码：22 位，去掉容易混淆的字符
    $alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'.ToCharArray()
    $pass = -join (1..22 | ForEach-Object { $alphabet | Get-Random })

    # 对外地址：优先用「能上外网的那块网卡」的地址，这样同事也能连。
    #
    # ⚠️ 不能随便取第一个非 127 的地址：装了 Docker Desktop 的机器上
    #    会有 WSL / Hyper-V 的虚拟网卡（形如 172.28.x.x），
    #    那些地址同事根本连不上。实测踩过——脚本给出了一个 172.28 开头的
    #    网址，用户照着发给同事，对方打不开。
    #
    # 判据：有默认网关的那块网卡，才是真正对外的网卡。
    $site = 'localhost'
    try {
        $best = Get-NetIPConfiguration -ErrorAction Stop |
            Where-Object {
                $_.IPv4DefaultGateway -and
                $_.NetAdapter.Status -eq 'Up' -and
                $_.IPv4Address.IPAddress -notlike '169.254.*'
            } |
            Select-Object -First 1
        if ($best) { $site = $best.IPv4Address.IPAddress }
    } catch { }

    $envContent = @"
# 由「一键启动」自动生成 $((Get-Date).ToString('yyyy-MM-dd HH:mm'))
# 这两项可以改：COUCHDB_ADMIN_PASS 是数据库密码（改完要 docker compose down -v 才生效）
# SITE_ADDRESS 决定 HTTPS 证书方式：填 IP 用内部证书，填域名自动申请可信证书

COUCHDB_ADMIN_USER=admin
COUCHDB_ADMIN_PASS=$pass
COUCHDB_DB=orders
SITE_ADDRESS=$site
HTTP_PORT=8080
HTTPS_PORT=8443
"@
    # UTF-8 无 BOM：带 BOM 会让 docker compose 读错第一个键
    [System.IO.File]::WriteAllText((Join-Path $DeployDir '.env'), $envContent, (New-Object System.Text.UTF8Encoding $false))
    Ok "已生成配置（对外地址：$site）"

    $pass | Set-Content -Path (Join-Path $DeployDir '管理员密码.txt') -Encoding UTF8
    Ok '管理员密码已存到 deploy\管理员密码.txt'
}

# ---------------------------------------------------------------- 启动
Say ''
Say '  正在启动服务（第一次要构建镜像，可能要几分钟）…' Cyan
docker compose up -d --build
if ($LASTEXITCODE -ne 0) {
    Fail '启动失败。请把上面的错误信息截图反馈。'
    Read-Host '  按回车键退出'
    exit 1
}

# ---------------------------------------------------------------- 等就绪
Say ''
Say '  正在等待服务就绪…'
$envMap = @{}
Get-Content (Join-Path $DeployDir '.env') | ForEach-Object {
    if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $envMap[$Matches[1]] = $Matches[2].Trim() }
}
$site = $envMap['SITE_ADDRESS']
$httpsPort = if ($envMap['HTTPS_PORT']) { $envMap['HTTPS_PORT'] } else { '443' }
$url = if ($httpsPort -eq '443') { "https://$site/" } else { "https://${site}:$httpsPort/" }

$ready = $false
for ($i = 0; $i -lt 40; $i++) {
    # 探测方式：问 Docker「容器里那个服务应答了吗」。
    #
    # 为什么不从宿主直接 HTTPS 探测：
    #   Windows 的 TLS 栈（schannel）在访问**自签证书 + 用 IP 当主机名**时
    #   会直接在握手阶段失败（SEC_E_INTERNAL_ERROR），
    #   连 `curl -k`（跳过校验）也救不回来。实测踩过：
    #   服务明明好好的，脚本却探测 60 次全失败，然后告诉用户"可能没起来"。
    #
    # 改成在容器**内部**探测：那里没有证书这层干扰，测的是真实的
    #   "应用是否已经开始应答"。Caddy 有没有起来另算——它起不来用户会从
    #   浏览器直接看出来，不需要脚本替他判断。
    $code = docker compose exec -T app node -e "fetch('http://127.0.0.1:8080/api/session').then(r=>process.stdout.write(String(r.status))).catch(()=>process.stdout.write('0'))" 2>$null
    if ($code -match '200') { $ready = $true; break }
    Start-Sleep -Seconds 3
    Write-Host '.' -NoNewline
}
Say ''

if (-not $ready) {
    Warn '服务好像还没完全起来。可以稍等一会儿再打开下面的网址。'
    Say '  查看日志：docker compose logs app'
} else {
    Ok '服务已就绪'
}

# 导出根证书：想彻底去掉浏览器警告的人需要它（装到设备的受信任根里）
Say ''
Say '  正在导出根证书…' Cyan
$crtPath = Join-Path $DeployDir 'caddy-root.crt'
# ⚠️ docker compose cp 会把进度信息写到 stderr，而 PowerShell 把子进程的 stderr
#    当成错误，会弹一大段红字吓到用户（命令其实是成功的）。
#    这里明确忽略 stderr，成败只看文件有没有落地。
$ErrorActionPreference = 'Continue'
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt $crtPath 2>&1 | Out-Null
$ErrorActionPreference = 'Stop'
if (Test-Path $crtPath) {
    Ok '已导出到 deploy\caddy-root.crt'
    Say '     双击它 → 安装证书 → 本地计算机 → 受信任的根证书颁发机构' DarkGray
    Say '     装完后浏览器就不再提示证书不受信任了' DarkGray
} else {
    Warn '暂时取不到根证书（Caddy 可能还在启动）。稍后重跑本脚本会补上。'
}

# 初始密码只在启动日志里出现一次，这里帮忙取出来
Say ''
Say '  正在读取初始密码…' Cyan
$logs = docker compose logs app 2>&1 | Out-String
if ($logs -match '首次运行，已生成初始密码') {
    Say ''
    Say '  ⚠️  各账号的初始密码（只显示这一次，请立即记下）：' Yellow
    ($logs -split "`n") | Where-Object { $_ -match '^\s*\S+\s+[a-z0-9]{10}\s+（' } | ForEach-Object {
        Say "      $($_.Trim())" White
    }
    Say ''
    Say '  首次登录后会要求修改密码。' Yellow
    $logs | Set-Content -Path (Join-Path $DeployDir '初始密码.txt') -Encoding UTF8
    Ok '也存到了 deploy\初始密码.txt'
} else {
    Say '  （这次没有新生成的密码——说明账号已存在。忘了密码请看下面。）'
}

# ---------------------------------------------------------------- 打开浏览器
Say ''
Say '  ─────────────────────────────────────────────' Cyan
Say "  可以使用了：  $url" White
Say ''
Say '  · 自己用：把上面的网址复制到浏览器'
Say '  · 同事用：把同一个网址发给他们（同一局域网内）'
Say ''
Say '  · 浏览器会提示「证书不受信任」——这是正常的：' Yellow
Say '      本机自己签的证书，不是从证书机构买的。' Yellow
Say '      点「高级」→「继续前往」就能用。' Yellow
Say '      想彻底去掉提示：把 deploy\caddy-root.crt 装到各台设备的' Yellow
Say '      「受信任的根证书颁发机构」里（详见 deploy\README.md）。' Yellow
Say ''
Say '  · 忘了密码：管理员在「设置」页里可以重置。' 
Say '  ─────────────────────────────────────────────' Cyan
Say ''

try {
    Start-Process $url
    Ok '已打开浏览器'
} catch {
    Warn "没能自动打开浏览器，请手动访问：$url"
}

Say ''
Say '  停止服务：运行「一键停止.bat」，或在 deploy 目录执行 docker compose down' DarkGray
Say ''
Read-Host '  按回车键关闭这个窗口（服务会继续在后台运行）'
