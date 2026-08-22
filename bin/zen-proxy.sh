#!/usr/bin/env sh
# zen-proxy: start the local proxy for OpenCode Zen's free models (no API key needed).
#   zen-proxy.sh          start it if nothing is listening on 127.0.0.1:$PROXY_PORT
#   zen-proxy.sh stop     stop it
# Clients:
#   OpenAI-compatible : http://127.0.0.1:4040/v1   (any placeholder API key; model x-preview-f-free)
#   Anthropic format  : http://127.0.0.1:4040      (model ox-alpha)  -- see claude-ox.sh
PROXY_PORT="${PROXY_PORT:-4040}"
ZEN_PROXY_JS="${ZEN_PROXY_JS:-$(cd "$(dirname "$0")/.." && pwd)/proxy.js}"
LOG="${ZEN_PROXY_LOG:-${TMPDIR:-/tmp}/zen-proxy.log}"
PIDFILE="${TMPDIR:-/tmp}/zen-proxy.pid"

listening() { node -e "require('net').connect($PROXY_PORT,'127.0.0.1').once('connect',()=>process.exit(0)).once('error',()=>process.exit(1))" 2>/dev/null; }

if [ "$1" = "stop" ]; then
  if [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null; then echo "[zen-proxy] stopped"; else pkill -f "$ZEN_PROXY_JS" 2>/dev/null && echo "[zen-proxy] stopped" || echo "[zen-proxy] not running"; fi
  rm -f "$PIDFILE"; exit 0
fi

if listening; then echo "[zen-proxy] already running on http://127.0.0.1:$PROXY_PORT"; exit 0; fi
echo "[zen-proxy] starting on http://127.0.0.1:$PROXY_PORT (log: $LOG) ..."
nohup node "$ZEN_PROXY_JS" >"$LOG" 2>&1 &
echo $! >"$PIDFILE"
i=0
while [ $i -lt 40 ]; do
  if listening; then echo "[zen-proxy] ready: OpenAI-compatible base URL http://127.0.0.1:$PROXY_PORT/v1  (model x-preview-f-free)"; exit 0; fi
  i=$((i+1)); sleep 0.5
done
echo "[zen-proxy] did not come up - see $LOG"; exit 1
