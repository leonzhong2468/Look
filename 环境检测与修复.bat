@echo off
chcp 65001 >nul 2>&1
title Look - 环境检测与修复
cd /d "%~dp0"
echo.
echo   ============================================================
echo    Look   环境检测与修复
echo   ============================================================
echo.
echo   正在启动检测工具，请稍候...
echo   （如果窗口一闪就消失，说明系统禁用了 PowerShell 脚本执行）
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\doctor.ps1"
if errorlevel 1 (
  echo.
  echo   [!] 检测工具异常退出，错误码 %errorlevel%
  echo       可以手动运行： powershell -ExecutionPolicy Bypass -File "tools\doctor.ps1"
  echo.
  pause
)
