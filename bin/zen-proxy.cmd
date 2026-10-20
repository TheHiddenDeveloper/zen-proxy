@echo off
setlocal
rem zen-proxy: start the local proxy for OpenCode Zen's free models (no API key needed).
rem   zen-proxy          start it if it isn't already listening on 127.0.0.1:%PROXY_PORT%
rem   zen-proxy stop     stop it
rem Clients:
rem   OpenAI-compatible : http://127.0.0.1:4040/v1   (any placeholder API key; model big-pickle)
rem   Anthropic format  : http://127.0.0.1:4040      (model ox-alpha)  -- see claude-ox.cmd
if "%PROXY_PORT%"=="" set PROXY_PORT=4040
if "%ZEN_PROXY_JS%"=="" set ZEN_PROXY_JS=%~dp0..\proxy.js

if /i "%~1"=="stop" (
  powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'zen-proxy*' } | Stop-Process -Force; Write-Host '[zen-proxy] stopped'"
  exit /b 0
)

netstat -an | findstr /C:"127.0.0.1:%PROXY_PORT% " | findstr /C:"LISTENING" >nul
if not errorlevel 1 (
  echo [zen-proxy] already running on http://127.0.0.1:%PROXY_PORT%
  exit /b 0
)
echo [zen-proxy] starting on http://127.0.0.1:%PROXY_PORT% ...
rem Start-Process (ShellExecute) so the proxy does NOT inherit this shell's stdio handles;
rem a plain `start` would keep any pipeline around this script open forever.
powershell -NoProfile -Command "Start-Process node -ArgumentList '\"%ZEN_PROXY_JS%\"' -WindowStyle Minimized"
for /l %%i in (1,1,20) do (
  netstat -an | findstr /C:"127.0.0.1:%PROXY_PORT% " | findstr /C:"LISTENING" >nul && goto ready
  ping -n 2 127.0.0.1 >nul
)
echo [zen-proxy] did not come up - check the "zen-proxy (Ox Alpha)" window for errors.
exit /b 1
:ready
echo [zen-proxy] ready: OpenAI-compatible base URL http://127.0.0.1:%PROXY_PORT%/v1  (model big-pickle)
