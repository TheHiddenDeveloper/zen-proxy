# zen-proxy

Use **OpenCode Zen's free models** — Ox Alpha (`x-preview-f-free`, 1M context), Big Pickle, and
the other `*-free` entries — from **Claude Code** and from **any OpenAI-compatible client**
(deepseek-harness, Cursor, Continue, …), **without an API key, account, or daily cap**.

One file, zero dependencies, Node 18+.

## The problem

Zen's free models are served at `https://opencode.ai/zen/v1/chat/completions` and work with
**no authentication at all**. That is also the catch: the endpoint returns
`401 Invalid API key` for *any* non-empty `Authorization` header — and almost every client
insists on sending one (pi-ai, the OpenAI SDK, LiteLLM, claude-code-router, …). Paste a
placeholder key and you get 401; leave it empty and the client refuses to start.

Claude Code has a second problem: it only speaks the Anthropic Messages API, and Zen serves
these models only in OpenAI chat-completions format.

## What the proxy does

```
Claude Code ──Anthropic /v1/messages──▶ zen-proxy ──OpenAI chat/completions, no auth header──▶ Zen
OpenAI-style client ──/v1/chat/completions──▶ zen-proxy ──(Authorization stripped, quirks fixed)──▶ Zen
```

| Route | What happens |
|---|---|
| `POST /v1/messages` | Full Anthropic ⇄ OpenAI translation: streaming events, tool definitions, `tool_use`/`tool_result` round-trips, system-prompt arrays, `cache_control` stripped, `reasoning_content` surfaced as thinking blocks, usage mapped |
| `POST /v1/messages/count_tokens` | Local estimate (Zen has no counting endpoint) |
| `POST /v1/chat/completions` | Transparent passthrough that drops the `Authorization` header and rewrites what Zen rejects: `developer` role → `system`, `max_completion_tokens` → `max_tokens`, `reasoning_effort` mapped onto the only accepted values `low`/`high`/`max` |
| `GET /v1/models` | Zen's catalogue, free models only by default (`MODELS=all` for everything), plus the `ox-alpha` alias |

The `/v1` prefix is optional and CORS is open, so browser-based clients work too.

## Quick start

```bash
git clone https://github.com/Dalailalama/zen-proxy
cd zen-proxy
node proxy.js          # listens on http://127.0.0.1:4040
```

Or use the launchers in `bin/` (start the proxy in the background if it isn't running):

| | Windows | macOS / Linux |
|---|---|---|
| Start / stop the proxy | `bin\zen-proxy.cmd` · `bin\zen-proxy.cmd stop` | `bin/zen-proxy.sh` · `bin/zen-proxy.sh stop` |
| Claude Code on Ox Alpha | `bin\claude-ox.cmd [claude args]` | `bin/claude-ox.sh [claude args]` |

Add `bin/` to your `PATH` to get `claude-ox` and `zen-proxy` as commands. On macOS/Linux run
`chmod +x bin/*.sh` once.

### Claude Code

```bash
claude-ox                      # interactive session on Ox Alpha
claude-ox -p "explain this repo"
claude-ox --permission-mode acceptEdits
```

`claude-ox` pins every model alias (`opus`, `sonnet`, `haiku`, subagents, background tasks) to
`ox-alpha` so nothing leaks to a paid endpoint, tells Claude Code the real 1M context window
(`CLAUDE_CODE_MAX_CONTEXT_TOKENS`), and leaves plain `claude` untouched — your normal login and
subscription keep working. Prefer a per-project setup? Copy
[`examples/claude-code-settings.json`](examples/claude-code-settings.json) into
`.claude/settings.local.json`.

Verified with Claude Code v2.1.205: tool calls (`Write`, `Read`, `Bash`), streaming, the
context-window display, and `--permission-mode auto` all work. Note that in auto mode the
"classifier" call is answered by Ox Alpha itself through the proxy — treat it as convenience, not
as Anthropic's safety classifier. `/model` offers an "Ox Alpha (Zen, free)" entry; any other
model name you type is passed through to Zen unchanged (`/model big-pickle`).

### deepseek-harness

The harness's LLM layer (pi-ai) cannot talk to Zen's free endpoint directly — it always sends an
`Authorization` header and uses the `developer` role / `max_completion_tokens`. Start `zen-proxy`,
then merge [`examples/deepseek-harness.settings.yaml`](examples/deepseek-harness.settings.yaml)
into `~/.dsh/settings.yaml` (or add a custom provider in **Settings → Models** with base URL
`http://127.0.0.1:4040/v1`, protocol `openai-completions`, any placeholder key, model
`x-preview-f-free`). Verified with deepseek-harness 0.1.1-rc.2, including the headless profile.

### Any OpenAI-compatible client

```
Base URL : http://127.0.0.1:4040/v1
API key  : anything non-empty (stripped before the request reaches Zen)
Model    : x-preview-f-free      (GET /v1/models lists the other free ones)
```

## Configuration

All via environment variables; defaults in brackets.

| Variable | Meaning |
|---|---|
| `PROXY_HOST` / `PROXY_PORT` | Bind address `[127.0.0.1]` / port `[4040]` |
| `UPSTREAM_URL` | OpenAI-compatible endpoint `[https://opencode.ai/zen/v1/chat/completions]` |
| `UPSTREAM_MODEL` | Model that `ox-alpha` and every `claude-*` id map to `[x-preview-f-free]` — point it at any other free Zen model when the stealth preview rotates |
| `UPSTREAM_API_KEY` | Leave empty for Zen's free models; set it to use a paid Zen key through the same proxy |
| `MODEL_ALIAS` | Name Claude Code uses `[ox-alpha]` |
| `REASONING_EFFORT` | `low` / `high` / `max`, sent when the client sends none (Ox Alpha cannot disable thinking) |
| `IMAGES` | `strip` `[default]` replaces image blocks with a text placeholder; `forward` sends them (Zen's free endpoint answers 503 after a long hang) |
| `MODELS` | `free` `[default]` or `all` for `GET /v1/models` |
| `DEBUG` | `1` dumps every request/response JSON to `<tmpdir>/zen-proxy/` |

## Tests

```bash
npm test
```

Starts the proxy on port 4041 and runs two live suites against Zen (network required): the
Anthropic translation (streaming framing, tool use both ways, tool results with images and stale
thinking blocks, `count_tokens`, error mapping) and the OpenAI passthrough (placeholder key
stripped, `developer` role, `max_completion_tokens`, streaming, tools, CORS).

## Known limits

- Images: Zen's free endpoint rejects them (503), so they are stripped by default.
- Zen's free endpoint occasionally answers 500/503 or an empty stream; the proxy retries those up to three times before surfacing a retryable error, so clients may see a pause rather than a failure.
- `count_tokens` is an estimate; real usage is reported on every response.
- Claude Code's cost display uses Anthropic prices — Zen charges nothing.
- Web search / fetch server tools are Anthropic-hosted and not available through a gateway.
- Stealth previews are temporary: the provider can rename, rate-limit, or withdraw the model at
  any time, and your prompts go to an anonymous third party. Don't send secrets or code you
  can't share.

## Why not just use OpenRouter?

You can — OpenRouter exposes the same model (`stealth/ox-alpha`) in Anthropic format, so Claude
Code works with only `ANTHROPIC_BASE_URL=https://openrouter.ai/api` and an OpenRouter key. This
proxy is for when you'd rather not create an account, or hit the free-tier request limits.

Not affiliated with OpenCode, Anthropic, or DeepSeek. MIT licensed.
