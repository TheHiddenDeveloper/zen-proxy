@echo off
setlocal
rem claude-ox: Claude Code on Ox Alpha (OpenCode Zen's free stealth model, 1M context) - no account, no key.
rem Starts the local zen-proxy if needed, then launches `claude` with every model alias pinned to it.
rem All arguments are passed to claude, e.g.:   claude-ox -p "explain this repo"
rem Plain `claude` is untouched and keeps using your normal login.
if "%PROXY_PORT%"=="" set PROXY_PORT=4040
if "%ZEN_PROXY_JS%"=="" set ZEN_PROXY_JS=%~dp0..\proxy.js

netstat -an | findstr /C:"127.0.0.1:%PROXY_PORT% " | findstr /C:"LISTENING" >nul
if not errorlevel 1 goto ready
echo [claude-ox] starting zen-proxy on 127.0.0.1:%PROXY_PORT% ...
powershell -NoProfile -Command "Start-Process node -ArgumentList '\"%ZEN_PROXY_JS%\"' -WindowStyle Minimized"
for /l %%i in (1,1,20) do (
  netstat -an | findstr /C:"127.0.0.1:%PROXY_PORT% " | findstr /C:"LISTENING" >nul && goto ready
  ping -n 2 127.0.0.1 >nul
)
echo [claude-ox] proxy did not come up - check the "zen-proxy (Ox Alpha)" window for errors.
exit /b 1

:ready
set ANTHROPIC_BASE_URL=http://127.0.0.1:%PROXY_PORT%
set ANTHROPIC_AUTH_TOKEN=zen-proxy
set ANTHROPIC_MODEL=ox-alpha
set ANTHROPIC_DEFAULT_OPUS_MODEL=ox-alpha
set ANTHROPIC_DEFAULT_SONNET_MODEL=ox-alpha
set ANTHROPIC_DEFAULT_HAIKU_MODEL=ox-alpha
set ANTHROPIC_DEFAULT_FABLE_MODEL=ox-alpha
set CLAUDE_CODE_SUBAGENT_MODEL=ox-alpha
set ANTHROPIC_CUSTOM_MODEL_OPTION=ox-alpha
set ANTHROPIC_CUSTOM_MODEL_OPTION_NAME=Ox Alpha (Zen, free)
set CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000
set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
set API_TIMEOUT_MS=600000
claude %*
