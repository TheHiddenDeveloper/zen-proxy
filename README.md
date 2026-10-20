[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-dawgog-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/dawgog) https://buymeacoffee.com/dawgog

# zen-proxy

Use **OpenCode Zen's free models** — Big Pickle and the other `*-free` entries — from **Claude
Code** and from **any OpenAI-compatible client** (deepseek-harness, Cursor, Continue, …),
**without an API key or account**.

One file, zero dependencies, Node 18+.

## The problem

Zen's free models are served at `https://opencode.ai/zen/v1/chat/completions` and accept the
**anonymous key** `Bearer public` — no real API key needed. The catch is that since September 2026
the free tier only serves requests that look like they come from an OpenCode agent session: the
`opencode/x.y.z` User-Agent, a canonical `ses_*` session id with the `x-opencode-*` correlation
headers, and an agent-shaped body (streaming + usage + the core `bash`/`edit`/`glob`/`grep`/`read`
tools). Every third-party client — pi-ai, the OpenAI SDK, LiteLLM, claude-code-router, … — sends
none of that and gets a `403 FreeTierError`. So the proxy
re-synthesizes the full OpenCode request shape for free models: it sets `Authorization: Bearer
public`, injects the session headers and any missing core tools, forces the request streaming, and
re-joins the SSE response back into a single JSON reply when you asked for a non-streaming answer.
A real Zen key takes over automatically if you set `UPSTREAM_API_KEY`.

Claude Code has a second problem: it only speaks the Anthropic Messages API, and Zen serves these
models only in OpenAI chat-completions format.

## What the proxy does

```
Claude Code ──Anthropic /v1/messages──▶ zen-proxy ──OpenAI chat/completions, no auth header──▶ Zen
OpenAI-style client ──/v1/chat/completions──▶ zen-proxy ──(Authorization stripped, quirks fixed)──▶ Zen
```

| Route | What happens |
|---|---|
| `POST /v1/messages` | Full Anthropic ⇄ OpenAI translation: streaming events, tool definitions, `tool_use`/`tool_result` round-trips, system-prompt arrays, `cache_control` stripped, `reasoning_content` surfaced as thinking blocks, usage mapped |
| `POST /v1/messages/count_tokens` | Local estimate (Zen has no counting endpoint) |
| `POST /v1/chat/completions` | Transparent passthrough that drops the `Authorization` header and rewrites what Zen rejects: `developer` role → `system`, `max_completion_tokens` → `max_tokens`, `reasoning_effort` mapped onto the only accepted values `low`/`high`/`max`. For free models it also builds the OpenCode request shape (session headers, core tools, forced stream) and re-joins the SSE reply for non-streaming callers |
| `GET /v1/models` | Zen's catalogue, free models only by default (`MODELS=all` for everything), plus the `ox-alpha` alias |

The `/v1` prefix is optional and CORS is open, so browser-based clients work too.

## Setup

### Requirements

- **Node.js 18 or newer** (`node --version` to check) — that's the only thing you need to install.
- Outbound HTTPS access to `opencode.ai`. No API key, account, or subscription.
- Optional: **Claude Code** if you want the Anthropic `/v1/messages` route; any OpenAI-compatible
  client works without it.

There are **no dependencies**, so there is no `npm install` step. The whole proxy is `proxy.js`.

### 1. Get the code

```bash
git clone https://github.com/Dalailalama/zen-proxy
cd zen-proxy
```

No git? Download the ZIP from the repository page and unpack it. Keep `proxy.js` next to the
`bin/` folder — the launchers find it through a relative path.

### 2. Start the proxy

Foreground, easiest to watch (Ctrl+C stops it):

```bash
node proxy.js            # http://127.0.0.1:4040
```

Or use the launchers, which start the proxy in the background only if it is not already running:

| | Windows | macOS / Linux |
|---|---|---|
| Start / stop the proxy | `bin\zen-proxy.cmd` · `bin\zen-proxy.cmd stop` | `bin/zen-proxy.sh` · `bin/zen-proxy.sh stop` |
| Claude Code on Ox Alpha | `bin\claude-ox.cmd [claude args]` | `bin/claude-ox.sh [claude args]` |

Add `bin/` to your `PATH` to get `claude-ox` and `zen-proxy` as commands. On macOS/Linux run
`chmod +x bin/*.sh` once. `claude-ox` starts the proxy for you, so you usually don't need to start
it separately.

Both start commands are idempotent — running one a second time is a no-op instead of a port clash.

### 3. Verify it works

```bash
curl http://127.0.0.1:4040/health
curl http://127.0.0.1:4040/v1/models
```

The first should return `{"ok":true,...}` and the second a list of the free models Zen serves
right now. Then send one real completion through the OpenAI route:

```bash
curl http://127.0.0.1:4040/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer anything" \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"say pong"}]}'
```

On Windows PowerShell, `curl` is an alias for `Invoke-WebRequest`; use `curl.exe` (Windows 10+)
for the commands above, or paste the JSON into `Invoke-RestMethod`.

If that returns a normal chat completion, you are done — the proxy works. Continue with the client
you actually want to use.

### 4. Point a client at it

Every client needs the same two things: base URL `http://127.0.0.1:4040/v1` and a non-empty
placeholder API key (it is stripped before the request reaches Zen). The Anthropic-style clients
use `http://127.0.0.1:4040` with model `ox-alpha` instead.

#### Claude Code

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

#### deepseek-harness

The harness's LLM layer (pi-ai) cannot talk to Zen's free endpoint directly — it always sends an
`Authorization` header and uses the `developer` role / `max_completion_tokens`. Start `zen-proxy`,
then merge [`examples/deepseek-harness.settings.yaml`](examples/deepseek-harness.settings.yaml)
into `~/.dsh/settings.yaml`. It registers an `opencode` provider (`api: openai-completions`,
base URL `http://127.0.0.1:4040/v1`, placeholder key in `headers`, the `compat` switches Zen needs)
and lists every free model Zen serves right now — Big Pickle, JEV 1.13, DeepSeek V4 Flash, Muse
Spark 1.3/1.2, Mimo V2.5, Ling 3.0 Flash, Nemotron 3/3.5 (the current `*-free` set; `GET /v1/models`
shows what's live, and Ox Alpha `x-preview-f-free` has rotated out). Switch models by changing
`agent-default-model` or in **Settings → Models**. Or add the provider by hand with base URL
`http://127.0.0.1:4040/v1`, protocol `openai-completions`, any placeholder key. Verified with
deepseek-harness 0.1.1-rc.2, including the headless profile.

#### Any OpenAI-compatible client

```
Base URL : http://127.0.0.1:4040/v1
API key  : anything non-empty (stripped before the request reaches Zen)
Model    : big-pickle           (any id from GET /v1/models, e.g. the *-free ones)
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE` / port 4040 busy | Something else (often an older proxy) owns the port. Stop it or start with `PROXY_PORT=4050 node proxy.js` and use that port everywhere. |
| `403 FreeTierError` from Zen | The emulated OpenCode session shape is stale. First update the repo (`git pull`); if it persists, the `opencode/x.y.z` token in the proxy's User-Agent needs bumping to a current release. |
| CORS error or connection refused in a browser client | CORS is open on the proxy. Use the URL exactly as shown (`http://127.0.0.1:4040`, not `https`); the proxy binds IPv4 only, so `localhost` fails on machines that resolve it to `::1`. |
| `401` from your client before any request | Most clients refuse to start with an empty key. Use any placeholder such as `zen-proxy` or `public`. |
| Requests hang, then `500`/`503` | Zen's free endpoint does this occasionally; the proxy retries three times. Retry the prompt before debugging the proxy. |
| Image prompts fail | Free Zen rejects images. Leave `IMAGES=strip` (the default); the proxy replaces them with a text placeholder. |
| `claude-ox` or `zen-proxy` not found | `bin/` is not on your `PATH`, or (macOS/Linux) the scripts are not executable — run `chmod +x bin/*.sh`. |
| Proxy died after closing the terminal | You started it with `node proxy.js` in the foreground. Use the background launcher, or run it under a service manager. |
| Want to see the raw traffic | Start with `DEBUG=1`; request/response JSON is written under `<tmpdir>/zen-proxy/`. |

## Configuration

All via environment variables; defaults in brackets.

| Variable | Meaning |
|---|---|
| `PROXY_HOST` / `PROXY_PORT` | Bind address `[127.0.0.1]` / port `[4040]` |
| `UPSTREAM_URL` | OpenAI-compatible endpoint `[https://opencode.ai/zen/v1/chat/completions]` |
| `UPSTREAM_MODEL` | Model that `ox-alpha` and every `claude-*` id map to `[big-pickle]` — point it at any other free Zen model when the lineup changes |
| `UPSTREAM_API_KEY` | Leave empty for Zen's free models (`Bearer public` is sent); set it to use a paid Zen key through the same proxy |
| `MODEL_ALIAS` | Name Claude Code uses `[ox-alpha]` |
| `REASONING_EFFORT` | `low` / `high` / `max`, sent when the client sends none (these models cannot disable thinking) |
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
- Zen's free tier only serves requests shaped like an OpenCode agent session; the proxy synthesizes
  that shape (session headers, core tools, streaming), which depends on details Zen may change
  again. If you hit `403 FreeTierError`, the opencode version token in the emulated User-Agent may
  need bumping to match current `opencode` releases.

## Why not just use OpenRouter?

You can — OpenRouter speaks Anthropic format and routes to many of the same models, so Claude
Code works with only `ANTHROPIC_BASE_URL=https://openrouter.ai/api` and an OpenRouter key. This
proxy is for when you'd rather not create an account, or hit the free-tier request limits.

Not affiliated with OpenCode, Anthropic, or DeepSeek. MIT licensed.
