@echo off
chcp 65001 >nul
title 家具经销商 · 电子画册与开单工具

rem 双击这个文件即可启动。
rem
rem 为什么用 .bat 包一层：
rem   Windows 默认不允许双击 .ps1（会被记事本打开而不是执行），
rem   而 .bat 可以双击。里面再调用 PowerShell 跑真正的逻辑。
rem   这样用户不需要改任何系统设置，也就不会碰到"执行策略"这类报错。

set "PS1=%~dp0一键启动.ps1"

if not exist "%PS1%" (
    echo.
    echo   [错误] 找不到 一键启动.ps1
    echo   请确认整个 deploy 文件夹是完整解压出来的。
    echo.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
if errorlevel 1 pause
