@echo off
chcp 65001 >nul 2>&1
title Look · 一键安装（开发版）
cd /d "%~dp0"

echo.
echo   ============================================================
echo    Look   一键安装（开发版）
echo   ============================================================
echo.
echo   这个脚本会：
echo     1. 检查 Node.js / npm
echo     2. 安装唯一开发依赖 electron
echo     3. 把源码就绪后直接启动（npm start）
echo.
echo   如果你只是想用软件，请用「一键安装（使用版）.bat」，
echo   或直接双击发布包里的 exe。
echo.
pause
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   [X] 没检测到 Node.js。
  echo.
  echo       请先安装 Node.js 18 或更高版本： https://nodejs.org/
  echo       安装时勾选「Add to PATH」，装完重开这个窗口再试。
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set "NODEVER=%%v"
echo   [1/3] Node.js 版本：!NODEVER!

echo.
echo   [2/3] 安装依赖（只会装 electron，大约 100-300 MB，看网速）...
echo.
cd /d "%~dp0src"
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo   [!] npm install 失败。常见原因：
  echo       - 网络问题：设置 npm 镜像
  echo         npm config set registry https://registry.npmmirror.com
  echo       - 权限问题：不要放在 C:\Program Files 下
  echo       - 代理问题：关掉代理再试
  echo.
  pause
  exit /b 1
)

echo.
echo   [3/3] 启动程序...
echo.
call npm start
exit /b 0
