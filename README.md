[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-dawgog-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/dawgog) https://buymeacoffee.com/dawgog

# zen-proxy

Use **OpenCode Zen's free models** — Big Pickle and the other `*-free` entries — from **Claude
Code** and from **any OpenAI-compatible client** (deepseek-harness, Cursor, Continue, …),
**without an API key or account**. If you also have a **Claude Pro or Max subscription**, the same
proxy serves every model that subscription includes, to any client that speaks the Anthropic
Messages API — no extra key, no second process.

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

A Claude subscription has a different problem: the models are reachable only with the OAuth session
the `claude` CLI created, and Anthropic only accepts that session from something that identifies
itself as Claude Code. The proxy handles both.

## What the proxy does

```
Claude Code ──Anthropic /v1/messages──▶ zen-proxy ──Anthropic /v1/messages, Pro OAuth─────▶ Anthropic
Claude Code ──Anthropic /v1/messages──▶ zen-proxy ──OpenAI chat/completions, no auth header──▶ Zen
OpenAI-style client ──/v1/chat/completions──▶ zen-proxy ──(Authorization stripped, quirks fixed)──▶ Zen
```

`claude-*` model ids take the subscription route and everything else takes the Zen route, so one
proxy can serve both at once.

| Route | What happens |
|---|---|
| `POST /v1/messages` | For `claude-*` models: passthrough to Anthropic's Messages API on your Claude Pro/Max OAuth session (`CLAUDE_PRO=1`, the default). Injects the Claude Code identity block and beta header, refreshes the token when it expires, and streams SSE unchanged. For every other model: full Anthropic ⇄ OpenAI translation — streaming events, tool definitions, `tool_use`/`tool_result` round-trips, system-prompt arrays, `cache_control` stripped, `reasoning_content` surfaced as thinking blocks, usage mapped |
| `POST /v1/messages/count_tokens` | Local estimate (neither upstream has a counting endpoint) |
| `POST /v1/chat/completions` | Transparent passthrough that drops the `Authorization` header and rewrites what Zen rejects: `developer` role → `system`, `max_completion_tokens` → `max_tokens`, `reasoning_effort` mapped onto the only accepted values `low`/`high`/`max`. For free models it also builds the OpenCode request shape (session headers, core tools, forced stream) and re-joins the SSE reply for non-streaming callers. `claude-*` ids are refused here — use `/v1/messages` |
| `GET /v1/models` | Zen's catalogue, free models only by default (`MODELS=all` for everything), plus the `ox-alpha` alias and the Claude subscription's models |

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
git clone https://github.com/TheHiddenDeveloper/zen-proxy
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
| Claude Code on Claude Pro | `bin\claude-pro.cmd [claude args]` | — |

Add `bin/` to your `PATH` to get `claude-ox`, `claude-pro` and `zen-proxy` as commands. On
macOS/Linux run `chmod +x bin/*.sh` once. Both launchers start the proxy for you, so you usually
don't need to start it separately.

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
placeholder API key (it is stripped before the request reaches Zen). Anthropic-style clients use
`http://127.0.0.1:4040` and point `/v1/messages` at it — with model `ox-alpha` for the free Zen
route, or any `claude-*` id for your subscription.

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

#### Claude Pro / Max (your own subscription)

If the `claude` CLI is signed in to a Pro or Max account, the proxy serves that subscription to
every Anthropic-speaking client. It reads the OAuth session from
`~/.claude/.credentials.json`, so there is nothing to configure and no key to copy:

```bash
claude                           # sign in once, if you have not already
claude-pro                       # interactive session on Claude Opus 5.5
claude-pro -p "explain this repo"
claude-pro --model claude-opus-4-8
```

`claude-pro` sets `ANTHROPIC_BASE_URL` to the proxy and maps the `opus` / `sonnet` / `haiku` /
`fable` aliases onto the 5.5 line, so `/model opus` and friends do the obvious thing.
`CLAUDE_PRO_MODEL` changes the default (e.g. `set CLAUDE_PRO_MODEL=claude-sonnet-5-5`). Any
`--model` you pass explicitly still wins, including every id in `GET /v1/models`.

The proxy adds two things Anthropic requires for subscription inference and clients generally do
not send: a first system block containing exactly
`You are Claude Code, Anthropic's official CLI for Claude.`, and the `claude-code-20250219` beta.
Without both, OAuth requests are answered with a misleading `429 rate_limit_error` even though the
account is fine. Claude Code sends both itself, so the proxy's copy is a no-op there. The access
token is refreshed in-process and written back to `.credentials.json`, so the CLI and the proxy
never fight over an expired token.

For **deepseek-harness**, the same session is available through pi-ai's native Anthropic protocol.
Add this provider next to `opencode` in `~/.dsh/profiles/<profile>/cordis.patch.yml` (or merge
[`examples/deepseek-harness.settings.yaml`](examples/deepseek-harness.settings.yaml)):

```yaml
claude:
  displayName: Claude Pro (via zen-proxy)
  api: anthropic-messages          # posts to baseURL + /v1/messages
  baseURL: http://127.0.0.1:4040   # no /v1 here — pi-ai appends it
  headers:
    Authorization: Bearer zen-proxy-placeholder   # keeps pi-ai's auth check happy
  defaultContextWindow: 1000000
  defaultMaxTokens: 128000
  models:
    - id: claude-opus-5-5
      name: Claude Opus 5.5
    - id: claude-sonnet-5-5
      name: Claude Sonnet 5.5
    - id: claude-haiku-5-5
      name: Claude Haiku 5.5
```

Then pick `claude/claude-opus-5-5` in Settings → Models, or set `agent-default-model` to it. The
placeholder header is never forwarded to Anthropic; the proxy replaces it with the OAuth token.

Verified with Claude Code v2.1.311 and deepseek-harness 0.1.1-rc.2 (headless profile): non-stream
and streamed replies, tool calls and tool results, and token refresh (forcing `expiresAt` into the
past rewrites both tokens while preserving every other key the CLI stores in that file).

#### deepseek-harness

The harness's LLM layer (pi-ai) cannot talk to Zen's free endpoint directly — it always sends an
`Authorization` header and uses the `developer` role / `max_completion_tokens`. Start `zen-proxy`,
then merge [`examples/deepseek-harness.settings.yaml`](examples/deepseek-harness.settings.yaml)
into your profile (`~/.dsh/profiles/<profile>/cordis.patch.yml` on current builds, otherwise
`~/.dsh/settings.yaml`). It registers an `opencode` provider (`api: openai-completions`, base URL
`http://127.0.0.1:4040/v1`, placeholder key in `headers`, the `compat` switches Zen needs) and the
`claude` provider from the section above, and lists every free model Zen serves right now — Big
Pickle, JEV 1.13, DeepSeek V4 Flash, Muse Spark 1.3/1.2, Mimo V2.5, Ling 3.0 Flash, Nemotron 3/3.5
(the current `*-free` set; `GET /v1/models` shows what's live, and Ox Alpha `x-preview-f-free` has
rotated out). Switch models by changing `agent-default-model` or in **Settings → Models**. Or add
the provider by hand with base URL `http://127.0.0.1:4040/v1`, protocol `openai-completions`, any
placeholder key. Verified with deepseek-harness 0.1.1-rc.2, including the headless profile and a
Claude subscription turn with tool calls.

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
| `claude_route_requires_messages_api` | A client is POSTing a `claude-*` model to `/v1/chat/completions`. Those models only exist on the Anthropic Messages route — configure the client with `api: anthropic-messages` and base URL `http://127.0.0.1:4040` (no `/v1`) |
| `503` "Claude Pro route unavailable" | The proxy cannot read the OAuth session. Run plain `claude` once to sign in, then check `CLAUDE_CREDENTIALS` if the file lives elsewhere |
| `429 rate_limit_error` on every `claude-*` request, but plain `claude` works | This is Anthropic's response when the request does not look like Claude Code. The proxy injects the required identity block and `claude-code-20250219` beta; a 429 here means an outdated proxy build, or genuinely bursty traffic — wait a minute and retry |
| `429` only occasionally under rapid testing | Anthropic's OAuth limiter is tighter than the API-key one. Space out parallel test runs |
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
| `UPSTREAM_MODEL` | Model that `ox-alpha` maps to `[big-pickle]` — point it at any other free Zen model when the lineup changes. `claude-*` ids do **not** land here; they take the Claude Pro route |
| `UPSTREAM_API_KEY` | Leave empty for Zen's free models (`Bearer public` is sent); set it to use a paid Zen key through the same proxy |
| `MODEL_ALIAS` | Name Claude Code uses for the Zen route `[ox-alpha]` |
| `REASONING_EFFORT` | `low` / `high` / `max`, sent when the client sends none (these models cannot disable thinking) |
| `IMAGES` | `strip` `[default]` replaces image blocks with a text placeholder; `forward` sends them (Zen's free endpoint answers 503 after a long hang) |
| `MODELS` | `free` `[default]` or `all` for `GET /v1/models` |
| `CLAUDE_PRO` | `1` `[default]` serves `claude-*` models from your Claude Pro/Max subscription; `0` disables the route and sends `claude-*` back to Zen like any other alias |
| `CLAUDE_CREDENTIALS` | OAuth session file `[~/.claude/.credentials.json]` — the one the `claude` CLI writes |
| `CLAUDE_API_URL` | Upstream Messages endpoint `[https://api.anthropic.com/v1/messages]` |
| `CLAUDE_USER_AGENT` | User-Agent sent to Anthropic `[claude-cli/2.1.311 (external, cli)]`; bump it if Anthropic starts rejecting OAuth requests from old builds |
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
