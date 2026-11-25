@echo off
chcp 65001 >nul 2>&1
title Look · 一键安装（使用版）
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo   ============================================================
echo    Look   一键安装（使用版）
echo   ============================================================
echo.
echo   这个脚本做四件事：
echo     1. 检查程序文件是否完整
echo     2. 检查运行环境（系统 / 权限 / 网络）
echo     3. 在桌面创建快捷方式
echo     4. 直接启动程序
echo.
echo   注意：本程序是绿色免安装版，不会写注册表、不会装系统服务。
echo.
pause
echo.

REM ---------- 1. 找程序 ----------
set "APPEXE="
for %%F in ("%~dp0*.exe") do (
  if not defined APPEXE set "APPEXE=%%~fF"
)
if not defined APPEXE (
  echo   [X] 当前目录没有 exe。
  echo       你可能只下载了源码仓库。请到 Releases 页面下载完整发布包，
  echo       解压后再运行本脚本。
  echo.
  pause
  exit /b 1
)
echo   [1/4] 找到主程序：!APPEXE!

if not exist "%~dp0icudtl.dat" (
  echo   [X] 缺少 icudtl.dat —— 解压不完整，请重新完整解压发布包。
  pause
  exit /b 1
)
if not exist "%~dp0resources\app\index.html" (
  echo   [X] 缺少 resources\app\index.html —— 解压不完整，请重新完整解压。
  pause
  exit /b 1
)

REM ---------- 2. 环境快检 ----------
echo.
echo   [2/4] 检查运行环境...
if exist "%~dp0tools\doctor.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\doctor.ps1" -Check
) else (
  echo         跳过（没有找到 tools\doctor.ps1）
)

REM ---------- 3. 桌面快捷方式 ----------
echo.
echo   [3/4] 创建桌面快捷方式...
set "LNK=%USERPROFILE%\Desktop\Look.lnk"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%');" ^
  "$s.TargetPath='!APPEXE!';" ^
  "$s.WorkingDirectory='%~dp0';" ^
  "$s.IconLocation='!APPEXE!,0';" ^
  "$s.Description='Look';" ^
  "$s.Save()" >nul 2>&1

if exist "%LNK%" (
  echo         已创建：%LNK%
) else (
  echo         [!] 快捷方式创建失败（不影响使用，直接双击 exe 也行）
)

REM ---------- 4. 启动 ----------
echo.
echo   [4/4] 正在启动程序...
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
start "" "!APPEXE!"

echo.
echo   ============================================================
echo    安装完成。
echo.
echo    · 桌面已生成快捷方式
echo    · 账号与配置在 userdata 目录（备份它就等于备份所有账号）
echo    · 出问题先双击「环境检测与修复.bat」
echo    · 文档在「文档」文件夹，看不懂就把它发给 AI
echo   ============================================================
echo.
timeout /t 8 >nul
exit /b 0
