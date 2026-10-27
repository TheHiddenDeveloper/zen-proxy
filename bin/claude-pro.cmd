@echo off
setlocal
rem claude-pro: Claude Code on your Claude Pro subscription, routed through zen-proxy.
rem The proxy holds the Pro OAuth session from ~/.claude/.credentials.json, refreshes it as it ages,
rem and injects the Claude Code identity block that Anthropic requires for subscription inference.
rem Opus/Sonnet/Haiku aliases map to the 5.5 line, so `/model opus|sonnet|haiku` just works.
rem Any explicit --model still wins, including ids the proxy catalog lists (claude-opus-4-8, ...).
rem Plain `claude` is untouched and keeps using your normal login.
if "%PROXY_PORT%"=="" set PROXY_PORT=4040
if "%ZEN_PROXY_JS%"=="" set ZEN_PROXY_JS=%~dp0..\proxy.js

netstat -an | findstr /C:"127.0.0.1:%PROXY_PORT% " | findstr /C:"LISTENING" >nul
if not errorlevel 1 goto ready
echo [claude-pro] starting zen-proxy on 127.0.0.1:%PROXY_PORT% ...
powershell -NoProfile -Command "Start-Process node -ArgumentList '\"%ZEN_PROXY_JS%\"' -WindowStyle Minimized"
for /l %%i in (1,1,20) do (
  netstat -an | findstr /C:"127.0.0.1:%PROXY_PORT% " | findstr /C:"LISTENING" >nul && goto ready
  ping -n 2 127.0.0.1 >nul
)
echo [claude-pro] proxy did not come up - check the zen-proxy window for errors.
exit /b 1

:ready
set ANTHROPIC_BASE_URL=http://127.0.0.1:%PROXY_PORT%
set ANTHROPIC_AUTH_TOKEN=zen-proxy
if "%CLAUDE_PRO_MODEL%"=="" set CLAUDE_PRO_MODEL=claude-opus-5-5
set ANTHROPIC_MODEL=%CLAUDE_PRO_MODEL%
set ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5-5
set ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5-5
set ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-5-5
set ANTHROPIC_DEFAULT_FABLE_MODEL=claude-fable-5-1
set CLAUDE_CODE_SUBAGENT_MODEL=claude-haiku-5-5
set CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000
set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
set API_TIMEOUT_MS=600000
claude %*
