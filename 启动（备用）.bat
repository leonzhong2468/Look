@echo off
chcp 65001 >nul 2>&1
title 启动（备用）
cd /d "%~dp0"

echo.
echo   ============================================================
echo    Look  -  备用启动
echo   ============================================================
echo.
echo   1) 先清掉可能被注入的环境变量（会导致程序当 node 跑、不建窗口）
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
set "ELECTRON_NO_ATTACH_CONSOLE=1"

echo   2) 检查主程序是否存在...
set "APPEXE="
for %%F in ("%~dp0*.exe") do (
  if not defined APPEXE set "APPEXE=%%~fF"
)
if not defined APPEXE (
  echo.
  echo   [X] 当前目录没有 exe，请确认解压完整。
  echo.
  pause
  exit /b 1
)
echo       找到：%APPEXE%

if not exist "%~dp0icudtl.dat" (
  echo.
  echo   [X] 缺少 icudtl.dat —— 解压不完整，请重新解压整个文件夹。
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0resources\app\index.html" (
  echo.
  echo   [X] 缺少 resources\app\index.html —— 解压不完整，请重新解压。
  echo.
  pause
  exit /b 1
)

echo   3) 启动程序（本窗口会在程序退出后关闭）
echo.
start "" "%APPEXE%"
if errorlevel 1 (
  echo   [X] 启动失败，试试运行「环境检测与修复.bat」看具体原因。
  pause
  exit /b 1
)

timeout /t 3 >nul
echo   已发出启动指令。如果 10 秒内没有窗口出现，请运行「环境检测与修复.bat」。
timeout /t 5 >nul
exit /b 0
