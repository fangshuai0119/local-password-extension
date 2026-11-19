@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 本地明文密码服务 - 请勿关闭此窗口

echo ============================================
echo   本地明文密码服务启动器
echo   服务地址: http://127.0.0.1:8765
echo   关闭此窗口即停止服务
echo ============================================
echo.

where python >nul 2>nul
if %errorlevel%==0 (
    python server.py
    goto :end
)

where py >nul 2>nul
if %errorlevel%==0 (
    py -3 server.py
    goto :end
)

echo [错误] 未检测到 Python。
echo 请先安装 Python 3，并在安装时勾选 "Add Python to PATH"。

:end
echo.
pause
