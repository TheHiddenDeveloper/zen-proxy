#!/usr/bin/env sh
# claude-ox: Claude Code on Ox Alpha (OpenCode Zen's free stealth model, 1M context) - no account, no key.
# Starts the local zen-proxy if needed, then launches `claude` with every model alias pinned to it.
# All arguments are passed to claude, e.g.:   claude-ox.sh -p "explain this repo"
# Plain `claude` is untouched and keeps using your normal login.
PROXY_PORT="${PROXY_PORT:-4040}"
"$(dirname "$0")/zen-proxy.sh" >&2 || exit 1

ANTHROPIC_BASE_URL="http://127.0.0.1:$PROXY_PORT" \
ANTHROPIC_AUTH_TOKEN=zen-proxy \
ANTHROPIC_MODEL=ox-alpha \
ANTHROPIC_DEFAULT_OPUS_MODEL=ox-alpha \
ANTHROPIC_DEFAULT_SONNET_MODEL=ox-alpha \
ANTHROPIC_DEFAULT_HAIKU_MODEL=ox-alpha \
ANTHROPIC_DEFAULT_FABLE_MODEL=ox-alpha \
CLAUDE_CODE_SUBAGENT_MODEL=ox-alpha \
ANTHROPIC_CUSTOM_MODEL_OPTION=ox-alpha \
ANTHROPIC_CUSTOM_MODEL_OPTION_NAME="Ox Alpha (Zen, free)" \
CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000 \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
API_TIMEOUT_MS=600000 \
exec claude "$@"
