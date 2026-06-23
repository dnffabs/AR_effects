@echo off
chcp 65001 >nul
title 双手 AR 维度裂隙 - 本地服务器
echo.
echo   正在启动本地服务器并打开浏览器...
echo   （如需停止，请关闭弹出的 PowerShell 窗口）
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-LocalServer.ps1"
if errorlevel 1 (
  echo.
  echo   启动失败，请查看上方错误信息。
  pause
)
