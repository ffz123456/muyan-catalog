@echo off
chcp 65001 >nul
title 停止家具开单工具

rem 停止服务。数据不会丢（都在 Docker 卷里）。

set "DEPLOY=%~dp0"
cd /d "%DEPLOY%"

echo.
echo   正在停止服务…
echo.

docker compose down
if errorlevel 1 (
    echo.
    echo   [错误] 停止失败。可能 Docker 没在运行，或服务本来就没启动。
    echo.
    pause
    exit /b 1
)

echo.
echo   [OK] 已停止。
echo.
echo   数据都保留着，下次运行「一键启动.bat」就能继续用。
echo.
echo   注意：不要执行 docker compose down -v
echo         那个 -v 会把数据一起删掉（订单、产品、账号全没）。
echo.
pause
