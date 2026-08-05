@echo off
setlocal DisableDelayedExpansion

set "PROJECT_ROOT=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%.codex\start-verboo.ps1" %*
exit /b %ERRORLEVEL%
