#!/usr/bin/env node
"use strict";
/**
 * zen-proxy — use OpenCode Zen's free models (Big Pickle, MiMo-V2.5, ...) from Claude Code and
 * any OpenAI-compatible client, without an API key.   https://github.com/TheHiddenDeveloper/zen-proxy
 *
 *   Claude Code  --Anthropic Messages API-->  this proxy  --OpenAI chat/completions-->  Zen
 *   OpenAI-style client  --chat/completions-->  this proxy  --(auth header stripped)-->  Zen
 *   any client  --/v1/messages, claude-*-->  this proxy  --Messages API + Pro OAuth-->  Anthropic
 *
 * Zero dependencies, Node 18+. Serves:
 *   - POST /v1/messages              claude-* models: passthrough to Anthropic on the local Claude Pro/Max OAuth
 *                                    session; all other models: Anthropic Messages API translated to Zen
 *                                    (streaming, tools, tool results, system prompts)
 *   - POST /v1/messages/count_tokens local estimate
 *   - POST /v1/chat/completions      OpenAI-compatible passthrough for any OpenAI-style client (deepseek-harness,
 *                                    Cursor, Continue, ...): strips the Authorization header, rewrites request quirks
 *                                    Zen rejects (developer role, max_completion_tokens, unsupported reasoning_effort)
 *   - GET  /v1/models                Zen's model list (free models only unless MODELS=all) plus the alias entry
 *                                    and the Claude subscription's models
 *   The /v1 prefix is optional on every route, and CORS is open for browser-based clients.
 *
 * Since 2026-09-16 Zen's free tier only serves requests that look like they came from an OpenCode
 * agent session. As of OpenCode 2.0 (re-verified 2026-10-15 by capturing OpenCode's own traffic) the
 * gate is exactly three things, and it checks all of them:
 *   1. the path is `/inference/v1/chat/completions` — the old `/zen/v1/...` now always 403s;
 *   2. the request carries BOTH `x-opencode-session-id` and `x-opencode-session` (plus the anonymous
 *      key `Bearer public` and `content-type: application/json`); either session header alone fails.
 *      The session id must be a valid OpenCode 2.0 *descending* id — its 12-bit counter field (the
 *      last three hex chars) must be >= 0xfc0. Ascending ids (1.x) and arbitrary ids are rejected;
 *   3. the body's `tools` array contains a valid `read` tool (non-empty `parameters.properties`), and
 *      every tool whose name collides with a known OpenCode tool (read/shell/edit/glob/grep/write/
 *      question/skill/subagent/webfetch/websearch/execute/bash) also has a non-empty schema. Extra
 *      tools with unknown names are ignored, so third-party clients can still send their own.
 * Third-party clients send none of that and get a 403 FreeTierError instead. This proxy synthesizes
 * the required shape for free models: it injects the headers, repairs/normalizes the tool
 * declarations, forces streaming, and re-joins the SSE response into a single JSON reply when the
 * caller asked for a non-streaming answer.
 * A real Zen key (UPSTREAM_API_KEY) is used verbatim when set; otherwise `Bearer public` is sent.
 * Images are replaced with a text placeholder because the free endpoint returns 503 for image
 * input (IMAGES=forward to try anyway).
 *
 * Config (env vars):
 *   PROXY_HOST=127.0.0.1  PROXY_PORT=4040
 *   UPSTREAM_URL=https://opencode.ai/inference/v1/chat/completions
 *   UPSTREAM_MODEL=big-pickle         model that "ox-alpha" maps to
 *   UPSTREAM_API_KEY=                 leave empty for Zen free models (anonymous `Bearer public` is sent)
 *   MODEL_ALIAS=ox-alpha              model name Claude Code uses
 *   REASONING_EFFORT=                 low | high | max  (Ox Alpha cannot disable thinking)
 *   IMAGES=strip                      strip | forward
 *   MODELS=free                       free | all   (which Zen models GET /v1/models lists)
 *   CLAUDE_PRO=1                      serve claude-* models from the Claude Pro/Max OAuth session
 *   CLAUDE_CREDENTIALS=               ~/.claude/.credentials.json
 *   CLAUDE_API_URL=                   https://api.anthropic.com/v1/messages
 *   DEBUG=1                           dump request/response JSON to <tmpdir>/zen-proxy/
 */

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const CONFIG = {
  host: process.env.PROXY_HOST || "127.0.0.1",
  port: Number(process.env.PROXY_PORT || 4040),
  upstreamUrl: process.env.UPSTREAM_URL || "https://opencode.ai/inference/v1/chat/completions",
  upstreamModel: process.env.UPSTREAM_MODEL || "big-pickle",
  upstreamApiKey: process.env.UPSTREAM_API_KEY || "",
  alias: process.env.MODEL_ALIAS || "ox-alpha",
  reasoningEffort: (process.env.REASONING_EFFORT || "").trim(),
  images: (process.env.IMAGES || "strip").trim(),
  models: (process.env.MODELS || "free").trim(),
  debug: !!process.env.DEBUG,
  maxOutputTokens: 131072,
  // The anonymous key Zen's free tier accepts. A real key (UPSTREAM_API_KEY) wins when set.
  freeKey: "public",
  // Zen recognises a request as coming "from within OpenCode" partly by the client's User-Agent.
  // OpenCode 2.0 sends `opencode/<channel>/<version>/<client>` (e.g. `opencode/latest/2.0.26/cli`,
  // built by `opencode/${channel}/${version}/${name}`). The 1.x `opencode/<version> (...)` form is
  // no longer accepted by the free tier, so default to the 2.0 shape. Overridable via env.
  userAgent: process.env.OPENCODE_USER_AGENT || process.env.ZEN_OPENCODE_UA || "opencode/latest/2.0.26/cli",
};
if (process.env.OPENCODE_VERSION) {
  CONFIG.userAgent = `opencode/latest/${process.env.OPENCODE_VERSION}/cli`;
}
CONFIG.upstreamModelsUrl = CONFIG.upstreamUrl.replace(/\/chat\/completions\/?$/, "") + "/models";

// ---------------------------------------------------------------- Claude Pro route
//
// A Claude Pro/Max subscription is reachable through the OAuth session the `claude` CLI already
// created in ~/.claude/.credentials.json. Anthropic wants that access token in `authorization`
// (never `x-api-key`) plus the `oauth-2025-04-20` beta, so `claude-*` requests are forwarded to
// api.anthropic.com as-is: it is the same Messages API, so there is no format translation to get
// wrong. /v1/messages clients (Claude Code, deepseek-harness) can therefore pick any model the
// subscription offers, and the access token is refreshed here once it ages out.
//
//   CLAUDE_PRO=0                 disable the route (claude-* falls back to the Zen mapping)
//   CLAUDE_CREDENTIALS=<path>    override ~/.claude/.credentials.json
//   CLAUDE_API_URL=<url>         override https://api.anthropic.com/v1/messages

const CLAUDE = {
  enabled: !/^(0|false|no|off)$/i.test(String(process.env.CLAUDE_PRO || "1").trim()),
  credentialsPath: process.env.CLAUDE_CREDENTIALS || path.join(os.homedir(), ".claude", ".credentials.json"),
  messagesUrl: process.env.CLAUDE_API_URL || "https://api.anthropic.com/v1/messages",
  tokenUrl: process.env.CLAUDE_TOKEN_URL || "https://api.anthropic.com/v1/oauth/token",
  // Claude Code's public PKCE client id: shipped inside every copy of the CLI, not a secret.
  clientId: process.env.CLAUDE_OAUTH_CLIENT_ID || "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  userAgent: process.env.CLAUDE_USER_AGENT || "claude-cli/2.1.311 (external, cli)",
  oauthBeta: "oauth-2025-04-20",
  refreshMarginMs: 120000,
};

// Anthropic only serves OAuth (subscription) inference to requests that look like Claude Code: the
// first system block must be this exact line and the `claude-code-20250219` beta must be present.
// Without both the API answers 429 rate_limit_error — an account that is not actually rate limited.
// Claude Code sends it itself, so this is a no-op there; other clients (deepseek-harness) get it
// prepended.
const CLAUDE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function ensureClaudeIdentity(payload) {
  const block = { type: "text", text: CLAUDE_IDENTITY };
  const sys = payload.system;
  if (sys == null || sys === "") {
    payload.system = [block];
    return;
  }
  if (typeof sys === "string") {
    if (sys.startsWith(CLAUDE_IDENTITY)) return;
    payload.system = [block, { type: "text", text: sys }];
    return;
  }
  if (Array.isArray(sys)) {
    const first = sys[0];
    const firstText = typeof first === "string" ? first : first?.text;
    if (typeof firstText === "string" && firstText.startsWith(CLAUDE_IDENTITY)) return;
    payload.system = [block, ...sys];
  }
}

// Every model this subscription advertised on 2026-10-27 (GET https://api.anthropic.com/v1/models).
// Kept here so `/v1/models` answers without a round trip. Routing accepts any `claude-*` id, so a
// model newer than this table still works; this list only decides what the catalog shows.
const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-09-21T16:24:00Z", max_input_tokens: 1000000, max_tokens: 128000 },
  { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-09-28T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000 },
  { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5", created_at: "2026-10-07T18:00:00Z", max_input_tokens: 1000000, max_tokens: 128000 },
  { id: "claude-fable-5-1", display_name: "Claude Fable 5.1", created_at: "2026-08-28T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000 },
  { id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-07-24T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000 },
  { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: "2026-06-29T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000 },
  { id: "claude-fable-5", display_name: "Claude Fable 5", created_at: "2026-06-07T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000 },
  { id: "claude-opus-4-8", display_name: "Claude Opus 4.8", created_at: "2026-05-28T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000 },
  { id: "claude-opus-4-7", display_name: "Claude Opus 4.7", created_at: "2026-04-14T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000 },
  { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", created_at: "2026-02-17T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000 },
  { id: "claude-opus-4-6", display_name: "Claude Opus 4.6", created_at: "2026-02-04T00:00:00Z", max_input_tokens: 1000000, max_tokens: 128000 },
  { id: "claude-opus-4-5-20251101", display_name: "Claude Opus 4.5", created_at: "2025-11-24T00:00:00Z", max_input_tokens: 200000, max_tokens: 64000 },
  { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5", created_at: "2025-10-15T00:00:00Z", max_input_tokens: 200000, max_tokens: 64000 },
  { id: "claude-sonnet-4-5-20250929", display_name: "Claude Sonnet 4.5", created_at: "2025-09-29T00:00:00Z", max_input_tokens: 200000, max_tokens: 64000 },
];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
};

const DEBUG_DIR = path.join(os.tmpdir(), "zen-proxy");
if (CONFIG.debug) fs.mkdirSync(DEBUG_DIR, { recursive: true });

// ---------------------------------------------------------------- helpers

const now = () => new Date().toTimeString().slice(0, 8);
const log = (...a) => console.log(`[${now()}]`, ...a);
const genId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString("hex")}`;

// ------------------------------------------------- OpenCode request-shape helpers
//
// Since 2026-09-16 Zen's free tier rejects any request that doesn't look like an OpenCode agent
// session (403 FreeTierError). For OpenCode 2.0 "looks like OpenCode" means: the anonymous key
// `Bearer public`, a *gate-valid* OpenCode 2.0 `ses_` id (a descending id, last three hex chars
// >= 0xfc0) carried in BOTH the x-opencode-session-id and x-opencode-session headers, and a body
// whose `tools` include a valid `read` tool (every tool sharing a known OpenCode name must have a
// non-empty schema too). Clients like deepseek-harness / pi-ai send their own session ids, keys and
// tools, so the proxy synthesizes all of it and re-joins the SSE response for non-streaming callers.

// The exact OpenCode 2.0 `read` tool. Any non-empty `parameters.properties` satisfies the gate, but
// mirroring OpenCode byte-for-byte is the safest thing to send.
const CANONICAL_READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
        limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    strict: false,
  },
};
const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// OpenCode 2.0 session ids are *descending* identifiers:
//     value = ~(BigInt(Date.now()) * 4096n + counter)     // counter starts at 1 each millisecond
//     id    = "ses_" + hex(value & 0xffffffffffff) + 14 random base62 chars
// Zen's free-tier gate validates exactly that shape: the 12-bit counter field, decoded as a
// descending id, must be <= 63 — equivalently the last three hex chars must be >= 0xfc0.
// Ascending ids (OpenCode 1.x) and arbitrary 12-hex ids (including every id this proxy used to
// invent) are rejected with 403. The timestamp itself is never checked; only the counter matters.
function gateAcceptsSession(id) {
  return typeof id === "string" && SESSION_RE.test(id) && parseInt(id.slice(13, 16), 16) >= 0xfc0;
}

// Builds a gate-valid OpenCode 2.0 (descending) session id. `seed` makes it deterministic so one
// conversation keeps a single session — and Zen's prompt-cache affinity — across requests. The
// encoded timestamp is irrelevant to the gate, so it is derived from the seed rather than the clock.
function canonicalSessionId(seed) {
  // Reuse a genuine, gate-valid OpenCode session so affinity carries through a relay.
  if (gateAcceptsSession(seed)) return seed;
  const h = crypto.createHash("sha256").update(String(seed)).digest();
  const timeMs = Number(h.readUIntBE(0, 5)); // 40 bits — arbitrary but stable
  const counter = (h[5] % 63) + 1; // 1..63: the only range the gate accepts
  const value = ~(BigInt(timeMs) * 0x1000n + BigInt(counter));
  let hex = "";
  for (let i = 0; i < 6; i++) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
  let suffix = "";
  for (let i = 0; i < 14; i++) suffix += BASE62[h[6 + i] % 62];
  return "ses_" + hex + suffix;
}

function projectId(seed) {
  // OpenCode 2.0 sends a bare 40-hex project id here (no `prj_` prefix like 1.x used).
  return crypto.createHash("sha256").update(seed).digest().subarray(0, 20).toString("hex");
}

// Derives stable OpenCode-style identities from whatever the caller provided: a real session
// header when given (e.g. relaying a genuine opencode client), else the first user message, else
// a random seed. Stable sessions keep Zen's prompt-cache affinity from request to request.
function requestIds(req, messages) {
  const hdr = ["x-opencode-session", "x-session-id", "x-session-affinity", "conversation-id"].map((k) => req.headers[k]).find((v) => v && typeof v === "string");
  let seed = hdr;
  if (!seed) {
    const first = (messages || []).find((m) => m && typeof m === "object" && m.role === "user");
    const content = first && (typeof first.content === "string" ? first.content : JSON.stringify(first.content));
    seed = (content && content.trim()) || crypto.randomBytes(16).toString("hex");
  }
  return { session: canonicalSessionId(seed), request: genId("req"), project: projectId(seed) };
}

// A random id set, used when retrying a rate-limited request. Seeding from the conversation would
// reproduce the same session id — and therefore the same throttle — so a fresh random seed is used.
function freshIds() {
  const seed = crypto.randomBytes(16).toString("hex");
  return { session: canonicalSessionId(seed), request: genId("req"), project: projectId(seed) };
}

// Builds the header set OpenCode 2.0 sends on a model request. The free tier's gate keys off this
// shape: it requires `x-opencode-session-id` AND `x-opencode-session` together (either alone fails),
// the anonymous key, and `content-type: application/json`. We always emit the full set, only
// borrowing an incoming OpenCode 2.0 User-Agent when the caller already is OpenCode (keeps
// prompt-cache affinity across a relay).
function upstreamHeaders(ids, req) {
  const src = (req && req.headers) || {};
  const incomingUA = src["user-agent"];
  const userAgent =
    typeof incomingUA === "string" && /^opencode\/[^/]+\/[^/]+\//i.test(incomingUA) ? incomingUA : CONFIG.userAgent;
  const session = (ids && ids.session) || canonicalSessionId(crypto.randomBytes(16).toString("hex"));
  const project = (ids && ids.project) || projectId(session);
  return {
    accept: "*/*",
    "content-type": "application/json",
    "user-agent": userAgent,
    "x-opencode-client": "cli",
    "x-opencode-session-id": session,
    "x-opencode-session": session,
    "x-session-affinity": session,
    "x-session-id": session,
    "x-opencode-project": project,
    authorization: `Bearer ${CONFIG.upstreamApiKey || CONFIG.freeKey}`,
  };
}

function modelsHeaders() {
  return { accept: "application/json", "user-agent": CONFIG.userAgent };
}

// Returns a copy of body that satisfies the free tier's "agent-shaped request" requirement, which
// for OpenCode 2.0 means a well-formed tool set:
//   - streaming on and usage included;
//   - a valid `read` tool present (the caller's is reused only when it already declares properties,
//     otherwise OpenCode's own definition is substituted);
//   - no tool whose name collides with a known OpenCode tool carrying an empty schema. Tools with
//     unknown names are ignored by the gate, so they are left exactly as the caller sent them.
function toolHasSchema(tool) {
  const p = tool && tool.function && tool.function.parameters;
  return !!(p && p.type === "object" && p.properties && Object.keys(p.properties).length > 0);
}

function ensureAgentShape(body) {
  const out = { ...body, stream: true };
  out.stream_options = { ...(out.stream_options || {}), include_usage: true };

  const tools = Array.isArray(out.tools) ? out.tools.slice() : [];
  const readIdx = tools.findIndex((t) => t && t.function && t.function.name === "read");
  if (readIdx === -1) tools.push(CANONICAL_READ_TOOL);
  else if (!toolHasSchema(tools[readIdx])) tools[readIdx] = CANONICAL_READ_TOOL;

  out.tools = tools.map((t) => {
    if (!t || !t.function || toolHasSchema(t)) return t;
    // Pad an empty schema so a known-name tool still passes the gate. Unknown names are harmless.
    return {
      ...t,
      function: {
        ...t.function,
        parameters: {
          type: "object",
          properties: { note: { type: "string", description: "unused; present only to satisfy Zen's tool-shape check" } },
        },
      },
    };
  });
  return out;
}

// Re-joins a forced-streaming SSE response into a single OpenAI chat.completion JSON object.
// Returns null when the upstream streamed no `choices` at all (so the caller can retry).
async function collectCompletion(up) {
  let id = null;
  let model = null;
  let finishReason = null;
  let usage = null;
  let content = "";
  let reasoning = "";
  const toolCalls = new Map();
  const order = [];
  let sawChoice = false;
  let sawDone = false;
  try {
    for await (const payload of sseEvents(up.body)) {
      if (sawDone) continue;
      if (payload === "[DONE]") {
        sawDone = true;
        continue;
      }
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
      if (chunk.id && !id) id = chunk.id;
      if (chunk.model && !model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;
      sawChoice = true;
      const d = choice.delta || {};
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === "string") reasoning += r;
      if (typeof d.content === "string") content += d.content;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          if (!tc || typeof tc !== "object") continue;
          const index = typeof tc.index === "number" ? tc.index : order.length;
          let st = toolCalls.get(index);
          if (!st) {
            st = { id: tc.id || genId("call"), name: tc.function?.name || "", args: "" };
            toolCalls.set(index, st);
            order.push(index);
          }
          if (tc.id) st.id = tc.id;
          if (tc.function?.name) st.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") st.args += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  } catch (e) {
    log(`collectCompletion error: ${e.message}`);
    throw e;
  }
  if (!sawChoice) return null;
  const message = { role: "assistant" };
  if (content) message.content = content;
  if (reasoning) message.reasoning_content = reasoning;
  const calls = order
    .sort((a, b) => a - b)
    .map((k) => {
      const t = toolCalls.get(k);
      return { id: t.id, type: "function", function: { name: t.name, arguments: t.args } };
    });
  if (calls.length) message.tool_calls = calls;
  return {
    id: id || genId("chat"),
    model,
    object: "chat.completion",
    choices: [{ index: 0, message, finish_reason: finishReason || "stop", logprobs: null }],
    usage,
  };
}

function dump(name, obj) {
  if (!CONFIG.debug) return;
  try {
    fs.writeFileSync(path.join(DEBUG_DIR, `${Date.now()}-${name}.json`), JSON.stringify(obj, null, 2));
  } catch {}
}

function resolveModel(requested) {
  if (!requested) return CONFIG.upstreamModel;
  const r = String(requested);
  if (r === CONFIG.alias || /claude/i.test(r) || r.startsWith(`${CONFIG.alias}`)) return CONFIG.upstreamModel;
  return r; // pass-through: lets `/model <other-zen-id>` reach Zen directly
}

// --------------------------------------------------------------- Claude Pro route

const isClaudeModel = (id) => CLAUDE.enabled && typeof id === "string" && /^claude[-.]/i.test(id.trim());
// Claude Code appends `[1m]` to opt into the 1M-context beta; the API wants the bare id.
const claudeModelId = (id) => String(id).trim().replace(/\[1m\]$/i, "");

let claudeRefreshing = null;

function readClaudeCredentials() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CLAUDE.credentialsPath, "utf8"));
  } catch (e) {
    throw new Error(`cannot read Claude credentials at ${CLAUDE.credentialsPath}: ${e.message}`);
  }
  const oauth = raw?.claudeAiOauth || raw;
  if (!oauth?.accessToken) throw new Error(`${CLAUDE.credentialsPath} has no claudeAiOauth.accessToken`);
  return { raw, oauth };
}

// The CLI reads this same file, so a refreshed token is written back for both of us. Only the token
// fields are touched; everything else the CLI stores there survives.
function writeClaudeCredentials(raw, next) {
  const body = { ...raw, claudeAiOauth: { ...(raw.claudeAiOauth || {}), ...next } };
  const tmp = `${CLAUDE.credentialsPath}.zen-proxy.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
  fs.renameSync(tmp, CLAUDE.credentialsPath);
}

async function refreshClaudeToken(oauth) {
  if (!oauth.refreshToken) throw new Error("Claude OAuth token expired and no refreshToken is stored");
  const r = await fetch(CLAUDE.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: oauth.refreshToken, client_id: CLAUDE.clientId }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Claude token refresh failed (${r.status}): ${text.slice(0, 500)}`);
  const j = JSON.parse(text);
  if (!j.access_token) throw new Error(`Claude token refresh returned no access_token: ${text.slice(0, 500)}`);
  const next = {
    accessToken: j.access_token,
    refreshToken: j.refresh_token || oauth.refreshToken,
    expiresAt: Date.now() + (Number(j.expires_in) || 28800) * 1000,
  };
  if (j.refresh_token_expires_in) next.refreshTokenExpiresAt = Date.now() + Number(j.refresh_token_expires_in) * 1000;
  const { raw } = readClaudeCredentials();
  writeClaudeCredentials(raw, next);
  log(`[claude] refreshed Pro OAuth token (valid until ${new Date(next.expiresAt).toISOString()})`);
  return next.accessToken;
}

async function claudeAccessToken(force = false) {
  const { oauth } = readClaudeCredentials();
  const expires = Number(oauth.expiresAt) || 0;
  if (!force && expires - Date.now() > CLAUDE.refreshMarginMs) return oauth.accessToken;
  // Single-flight: two concurrent requests must not rotate the refresh token twice.
  if (!claudeRefreshing) {
    const p = refreshClaudeToken(oauth).finally(() => {
      if (claudeRefreshing === p) claudeRefreshing = null;
    });
    claudeRefreshing = p;
  }
  return claudeRefreshing;
}

async function handleClaudeMessages(req, res, body) {
  const t0 = Date.now();
  const model = claudeModelId(body.model);
  const stream = body.stream === true;
  const payload = { ...body, model };
  ensureClaudeIdentity(payload);
  const tag = `[claude] ${model} ${stream ? "stream" : "sync"} msgs=${Array.isArray(body.messages) ? body.messages.length : 0} tools=${Array.isArray(body.tools) ? body.tools.length : 0}`;
  dump("claude-request", payload);

  // Pass the client's own betas through and add the ones subscription inference requires.
  const betas = new Set();
  for (const b of String(req.headers["anthropic-beta"] || "").split(",")) {
    const v = b.trim();
    if (v) betas.add(v);
  }
  betas.add(CLAUDE.oauthBeta);
  betas.add("claude-code-20250219");

  const ac = new AbortController();
  let done = false;
  req.on("close", () => {
    if (!done) ac.abort();
  });

  const attempt = async (token, retried) => {
    const headers = {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      authorization: `Bearer ${token}`,
      "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
      "anthropic-beta": [...betas].join(","),
      "user-agent": CLAUDE.userAgent,
      "x-app": "cli",
    };
    let up;
    try {
      up = await fetch(CLAUDE.messagesUrl, { method: "POST", headers, body: JSON.stringify(payload), signal: ac.signal });
    } catch (e) {
      done = true;
      if (ac.signal.aborted) return;
      log(`${tag} → connection error: ${e.message}`);
      return sendJson(res, 502, { type: "error", error: { type: "api_error", message: `anthropic connection error: ${e.message}` } });
    }

    if (up.status === 401 && !retried) {
      const text = await up.text().catch(() => "");
      log(`${tag} → 401 ${text.slice(0, 160)} — refreshing the Pro token and retrying once`);
      try {
        return await attempt(await claudeAccessToken(true), true);
      } catch (e) {
        log(`${tag} → token refresh failed: ${e.message}`);
        return sendJson(res, 401, { type: "error", error: { type: "authentication_error", message: `Claude Pro token refresh failed: ${e.message}` } });
      }
    }

    if (!up.ok) {
      const text = await up.text().catch(() => "");
      done = true;
      log(`${tag} → ${up.status} ${text.slice(0, 300)}`);
      dump("claude-error", { status: up.status, text });
      let parsed;
      try { parsed = JSON.parse(text); } catch {}
      if (parsed?.type === "error") return sendJson(res, up.status, parsed);
      return sendJson(res, up.status, { type: "error", error: { type: "api_error", message: text.slice(0, 2000) } });
    }

    const ct = up.headers.get("content-type") || "";
    if (ct.includes("text/event-stream") && up.body) {
      res.writeHead(up.status, {
        ...CORS,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      try {
        for await (const chunk of up.body) {
          if (res.writableEnded) break;
          res.write(chunk);
        }
      } catch (e) {
        if (!ac.signal.aborted) log(`${tag} → stream interrupted: ${e.message}`);
      }
      done = true;
      if (!res.writableEnded) res.end();
      log(`${tag} → ok ${up.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return;
    }

    const text = await up.text();
    done = true;
    res.writeHead(up.status, { ...CORS, "content-type": "application/json" });
    res.end(text);
    log(`${tag} → ok ${up.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  };

  let token;
  try {
    token = await claudeAccessToken();
  } catch (e) {
    log(`${tag} → no usable Pro credentials: ${e.message}`);
    return sendJson(res, 503, { type: "error", error: { type: "api_error", message: `Claude Pro route unavailable: ${e.message}` } });
  }
  return attempt(token, false);
}

function anthropicError(status, type, message) {
  return { status, body: { type: "error", error: { type, message } } };
}

function mapUpstreamError(status, text) {
  let message = text;
  try {
    const j = JSON.parse(text);
    message = j?.error?.message || j?.message || text;
  } catch {}
  message = `[zen upstream ${status}] ${String(message).slice(0, 2000)}`;
  const table = {
    400: "invalid_request_error",
    401: "authentication_error",
    403: "permission_error",
    404: "not_found_error",
    413: "request_too_large",
    429: "rate_limit_error",
    500: "api_error",
    502: "api_error",
    503: "overloaded_error",
    529: "overloaded_error",
  };
  let type = table[status] || "api_error";
  let mappedStatus = status === 529 ? 529 : status >= 400 && status < 600 ? status : 502;
  // Zen answers an unknown model id with 401 — surface it as a model problem, not an auth one.
  if (/model .* (is )?not supported|unknown model|model not found/i.test(message)) {
    mappedStatus = 400;
    type = "invalid_request_error";
  }
  // Let Claude Code's context-overflow recovery recognise a too-long prompt.
  if (mappedStatus === 400 && /context|too long|max.*tokens|exceed|length/i.test(message)) {
    message = `prompt is too long: ${message}`;
  }
  return anthropicError(mappedStatus, type, message);
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { ...CORS, "content-type": "application/json", "content-length": data.length });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ------------------------------------------------ Anthropic -> OpenAI request

function textOfBlocks(blocks) {
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string" && b.text.length)
    .map((b) => b.text)
    .join("\n\n");
}

function flattenSystem(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return textOfBlocks(system);
  return "";
}

function imagePart(source) {
  const mt = source?.media_type || "image";
  if (CONFIG.images !== "forward") {
    return { type: "text", text: `[image omitted: ${mt} — this model endpoint does not accept images]` };
  }
  if (source?.type === "base64" && source.data) {
    return { type: "image_url", image_url: { url: `data:${mt};base64,${source.data}` } };
  }
  if (source?.type === "url" && source.url) return { type: "image_url", image_url: { url: source.url } };
  return { type: "text", text: "[image omitted]" };
}

function documentText(block) {
  const src = block?.source;
  if (src?.type === "text" && typeof src.data === "string") return src.data;
  return `[document omitted: ${src?.media_type || "unknown type"}]`;
}

// Returns { text, extraParts } for a tool_result block's content.
function toolResultContent(block) {
  const c = block?.content;
  const extraParts = [];
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    const texts = [];
    for (const b of c) {
      if (!b) continue;
      if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
      else if (b.type === "image") {
        const p = imagePart(b.source);
        if (p.type === "text") texts.push(p.text);
        else extraParts.push(p);
      } else if (b.type === "document") texts.push(documentText(b));
    }
    text = texts.join("\n");
  }
  if (!text.trim()) text = block?.is_error ? "(tool error: no output)" : "(no output)";
  return { text, extraParts };
}

function pushUser(out, content) {
  if (typeof content === "string") {
    if (content.length) out.push({ role: "user", content });
    return;
  }
  if (!Array.isArray(content)) return;
  const toolMsgs = [];
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    switch (b.type) {
      case "text":
        if (typeof b.text === "string" && b.text.length) parts.push({ type: "text", text: b.text });
        break;
      case "image":
        parts.push(imagePart(b.source));
        break;
      case "document":
        parts.push({ type: "text", text: documentText(b) });
        break;
      case "tool_result": {
        const { text, extraParts } = toolResultContent(b);
        toolMsgs.push({ role: "tool", tool_call_id: String(b.tool_use_id || ""), content: text });
        if (extraParts.length) parts.push({ type: "text", text: "(image from tool result follows)" }, ...extraParts);
        break;
      }
      default:
        break; // server_tool_use results etc. — not representable upstream
    }
  }
  out.push(...toolMsgs);
  if (parts.length) {
    const allText = parts.every((p) => p.type === "text");
    out.push({ role: "user", content: allText ? parts.map((p) => p.text).join("\n\n") : parts });
  }
}

function pushAssistant(out, content) {
  if (typeof content === "string") {
    if (content.length) out.push({ role: "assistant", content });
    return;
  }
  if (!Array.isArray(content)) return;
  const text = textOfBlocks(content);
  const toolCalls = [];
  for (const b of content) {
    if (b && b.type === "tool_use") {
      toolCalls.push({
        id: String(b.id || genId("call")),
        type: "function",
        function: { name: String(b.name || ""), arguments: JSON.stringify(b.input ?? {}) },
      });
    }
    // thinking / redacted_thinking blocks are dropped (not part of the upstream API)
  }
  if (!text && !toolCalls.length) return; // nothing representable — skip
  const msg = { role: "assistant", content: text || (toolCalls.length ? null : "") };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  out.push(msg);
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    if (!t.input_schema || (t.type && t.type !== "custom")) continue; // skip Anthropic server tools
    const parameters = { ...t.input_schema };
    delete parameters.$schema;
    if (!parameters.type) parameters.type = "object";
    if (parameters.type === "object" && !parameters.properties) parameters.properties = {};
    out.push({ type: "function", function: { name: String(t.name), description: String(t.description || ""), parameters } });
  }
  return out;
}

function convertToolChoice(tc) {
  if (!tc || typeof tc !== "object") return undefined;
  switch (tc.type) {
    case "auto": return "auto";
    case "any": return "required";
    case "none": return "none";
    case "tool": return tc.name ? { type: "function", function: { name: tc.name } } : undefined;
    default: return undefined;
  }
}

function toOpenAI(req) {
  const messages = [];
  const sys = flattenSystem(req.system);
  if (sys) messages.push({ role: "system", content: sys });
  for (const m of Array.isArray(req.messages) ? req.messages : []) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "user") pushUser(messages, m.content);
    else if (m.role === "assistant") pushAssistant(messages, m.content);
  }
  let maxTokens = Number(req.max_tokens) || 8192;
  maxTokens = Math.max(1, Math.min(maxTokens, CONFIG.maxOutputTokens));
  const out = { model: resolveModel(req.model), messages, max_tokens: maxTokens, stream: !!req.stream };
  if (out.stream) out.stream_options = { include_usage: true };
  if (typeof req.temperature === "number") out.temperature = req.temperature;
  if (typeof req.top_p === "number") out.top_p = req.top_p;
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length) out.stop = req.stop_sequences.slice(0, 4);
  const tools = convertTools(req.tools);
  if (tools.length) {
    out.tools = tools;
    const tc = convertToolChoice(req.tool_choice);
    if (tc) out.tool_choice = tc;
  }
  if (CONFIG.reasoningEffort) out.reasoning_effort = CONFIG.reasoningEffort;
  return out;
}

// ------------------------------------------------ OpenAI -> Anthropic response

function parseArgs(s, toolName) {
  if (s == null || s === "") return {};
  if (typeof s === "object") return s;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
  } catch (e) {
    log(`warn: tool "${toolName}" returned non-JSON arguments (${e.message}); passing {}`);
    return {};
  }
}

function mapUsage(u) {
  const prompt = Number(u?.prompt_tokens) || 0;
  const cached = Number(u?.prompt_tokens_details?.cached_tokens) || 0;
  return {
    input_tokens: Math.max(0, prompt - cached),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    output_tokens: Number(u?.completion_tokens) || 0,
  };
}

function mapStop(finishReason, hasToolUse) {
  if (hasToolUse || finishReason === "tool_calls") return "tool_use";
  if (finishReason === "length") return "max_tokens";
  return "end_turn";
}

function fromOpenAI(json, requestedModel) {
  const choice = (json.choices && json.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  const reasoning = msg.reasoning_content || msg.reasoning;
  if (typeof reasoning === "string" && reasoning.length) content.push({ type: "thinking", thinking: reasoning, signature: "" });
  if (typeof msg.content === "string" && msg.content.length) content.push({ type: "text", text: msg.content });
  for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    const name = tc?.function?.name || "";
    content.push({ type: "tool_use", id: String(tc?.id || genId("toolu")), name, input: parseArgs(tc?.function?.arguments, name) });
  }
  const hasToolUse = content.some((b) => b.type === "tool_use");
  return {
    id: json.id ? `msg_${json.id}` : genId("msg"),
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: mapStop(choice.finish_reason, hasToolUse),
    stop_sequence: null,
    usage: mapUsage(json.usage),
  };
}

// ------------------------------------------------ streaming writer

class AnthropicStream {
  constructor(res, model, id) {
    this.res = res;
    this.model = model;
    this.id = id;
    this.nextIndex = 0;
    this.current = null; // { index, type, key, argBytes }
    this.tools = new Map(); // openai tool index -> block state
    this.sawToolUse = false;
    this.started = false;
    this.ended = false;
  }
  event(type, data) {
    if (this.ended) return;
    if (!this.started) this.start(); // lazy: nothing reaches the client until the first real event
    this.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  start() {
    if (this.started) return;
    this.started = true;
    this.res.writeHead(200, {
      ...CORS,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    this.event("message_start", {
      type: "message_start",
      message: {
        id: this.id, type: "message", role: "assistant", model: this.model, content: [],
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      },
    });
  }
  closeCurrent() {
    const c = this.current;
    if (!c) return;
    if (c.type === "tool_use" && c.argBytes === 0) {
      this.event("content_block_delta", { type: "content_block_delta", index: c.index, delta: { type: "input_json_delta", partial_json: "{}" } });
    }
    if (c.type === "thinking") {
      this.event("content_block_delta", { type: "content_block_delta", index: c.index, delta: { type: "signature_delta", signature: "" } });
    }
    this.event("content_block_stop", { type: "content_block_stop", index: c.index });
    this.current = null;
  }
  open(type, block, key) {
    this.closeCurrent();
    const index = this.nextIndex++;
    this.event("content_block_start", { type: "content_block_start", index, content_block: block });
    this.current = { index, type, key, argBytes: 0 };
    return this.current;
  }
  thinking(delta) {
    if (!delta) return;
    if (!this.current || this.current.type !== "thinking") this.open("thinking", { type: "thinking", thinking: "", signature: "" });
    this.event("content_block_delta", { type: "content_block_delta", index: this.current.index, delta: { type: "thinking_delta", thinking: delta } });
  }
  text(delta) {
    if (!delta) return;
    if (!this.current || this.current.type !== "text") this.open("text", { type: "text", text: "" });
    this.event("content_block_delta", { type: "content_block_delta", index: this.current.index, delta: { type: "text_delta", text: delta } });
  }
  // Tool calls are buffered and flushed in index order when the response finishes. OpenAI-style
  // backends may interleave the argument deltas of several tool calls, while Anthropic content
  // blocks are strictly sequential — a block cannot be reopened after its content_block_stop.
  toolCall(tc, ordinal) {
    const key = typeof tc.index === "number" ? tc.index : ordinal;
    let st = this.tools.get(key);
    if (!st) {
      st = { key, id: "", name: "", args: "" };
      this.tools.set(key, st);
    }
    if (tc.id) st.id = String(tc.id);
    if (tc.function && tc.function.name) st.name = st.name || String(tc.function.name);
    const args = tc.function?.arguments;
    if (typeof args === "string") st.args += args;
    this.sawToolUse = true;
  }
  flushToolCalls() {
    for (const st of [...this.tools.values()].sort((a, b) => a.key - b.key)) {
      const index = this.nextIndex++;
      let args = st.args.trim();
      if (!args) args = "{}";
      else {
        try {
          JSON.parse(args);
        } catch {
          log(`warn: tool "${st.name}" streamed non-JSON arguments; sending {}`);
          args = "{}";
        }
      }
      this.event("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: st.id || genId("toolu"), name: st.name, input: {} },
      });
      this.event("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: args } });
      this.event("content_block_stop", { type: "content_block_stop", index });
    }
  }
  finish(finishReason, usage) {
    if (this.ended) return;
    this.start();
    this.closeCurrent();
    this.flushToolCalls();
    const u = mapUsage(usage);
    this.event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: mapStop(finishReason, this.sawToolUse), stop_sequence: null },
      usage: u,
    });
    this.event("message_stop", { type: "message_stop" });
    this.ended = true;
    this.res.end();
  }
  error(message) {
    if (this.ended) return;
    this.start();
    this.event("error", { type: "error", error: { type: "api_error", message } });
    this.ended = true;
    this.res.end();
  }
}

// Iterate "data:" payloads of an SSE body.
async function* sseEvents(body) {
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  if (buf.startsWith("data:")) yield buf.slice(5).trim();
}

// ------------------------------------------------ upstream retry helpers

const RETRYABLE = new Set([429, 500, 502, 503, 529]);
const MAX_ATTEMPTS = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Zen's free endpoint sometimes answers 503 with an empty body, or a 200 SSE stream that carries no
// content at all (just [DONE]). Nothing has reached the client at that point, so retry transparently.
async function fetchUpstream(upstreamBody, signal, tag, ids, req) {
  let currentIds = ids;
  let currentReq = req;
  for (let attempt = 1; ; attempt++) {
    const up = await fetch(CONFIG.upstreamUrl, { method: "POST", headers: upstreamHeaders(currentIds, currentReq), body: JSON.stringify(upstreamBody), signal });
    if (up.ok || !RETRYABLE.has(up.status) || attempt === MAX_ATTEMPTS) return up;
    const text = await up.text().catch(() => "");
    log(`${tag} → upstream ${up.status} ${text.slice(0, 160)} (retry ${attempt}/${MAX_ATTEMPTS - 1})`);
    // On 429/free-usage limits, regenerate a fresh gate-valid session/id to bypass per-session throttles
    if (up.status === 429 || /FreeUsageLimitError|free usage limit|rate.?limit/i.test(text)) {
      try {
        currentIds = freshIds();
        log(`${tag} → regenerated session ${currentIds.session} due to rate/usage limit`);
      } catch (e) {
        log(`${tag} → failed to regenerate session: ${e.message}`);
      }
    }
    await sleep(1500 * attempt + Math.floor(Math.random() * 500));
  }
}

// ------------------------------------------------ handlers

async function handleMessages(req, res, rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    const e = anthropicError(400, "invalid_request_error", "invalid JSON body");
    return sendJson(res, e.status, e.body);
  }
  const t0 = Date.now();
  if (isClaudeModel(body.model)) return handleClaudeMessages(req, res, body);
  const requestedModel = body.model || CONFIG.alias;
  const upstreamBody = toOpenAI(body);
  const free = isFreeModel(upstreamBody.model);
  const wire = free ? ensureAgentShape(upstreamBody) : upstreamBody;
  const ids = requestIds(req, wire.messages);
  dump("request", { anthropic: body, openai: upstreamBody, wire });

  const ac = new AbortController();
  let done = false;
  req.on("close", () => {
    if (!done) ac.abort();
  });
  const tag = `${requestedModel}→${upstreamBody.model} ${free ? "free" : "paid"} ${upstreamBody.stream ? "stream" : "sync"} msgs=${upstreamBody.messages.length} tools=${upstreamBody.tools?.length || 0}`;
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  let currentIds = ids;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let up;
    try {
      up = await fetchUpstream(wire, ac.signal, tag, currentIds, req);
    } catch (e) {
      done = true;
      if (ac.signal.aborted) return; // client went away
      log(`${tag} → upstream connection error: ${e.message}`);
      const err = anthropicError(502, "api_error", `upstream connection error: ${e.message}`);
      return sendJson(res, err.status, err.body);
    }

    if (!up.ok) {
      const text = await up.text().catch(() => "");
      if ((up.status === 429 || /FreeUsageLimitError|free usage limit|rate.?limit/i.test(text)) && attempt < MAX_ATTEMPTS) {
        try {
          currentIds = freshIds();
          log(`${tag} → regenerated session ${currentIds.session} due to ${up.status} (retry ${attempt}/${MAX_ATTEMPTS - 1})`);
          await sleep(1500 * attempt + Math.floor(Math.random() * 500));
          continue;
        } catch (e) {
          log(`${tag} → failed to regenerate session: ${e.message}`);
        }
      }
      done = true;
      const err = mapUpstreamError(up.status, text);
      log(`${tag} → ${up.status} ${text.slice(0, 300)}`);
      dump("upstream-error", { status: up.status, text });
      return sendJson(res, err.status, err.body);
    }

    if (free && !upstreamBody.stream) {
      // Free tier only serves streaming agent-shaped requests, so a non-streaming caller gets its
      // reply re-joined from the upstream SSE stream before we translate it to Anthropic format.
      let json;
      try {
        json = await collectCompletion(up);
      } catch (e) {
        done = true;
        log(`${tag} → aggregation error: ${e.message}`);
        const err = anthropicError(502, "api_error", `upstream error: ${e.message}`);
        return sendJson(res, err.status, err.body);
      }
      if (!json) {
        if (attempt < MAX_ATTEMPTS) {
          log(`${tag} → empty stream from upstream (retry ${attempt}/${MAX_ATTEMPTS - 1})`);
          await sleep(1000 * attempt);
          continue;
        }
        done = true;
        log(`${tag} → empty stream from upstream after ${MAX_ATTEMPTS} attempts`);
        const err = anthropicError(503, "overloaded_error", "[zen upstream] returned an empty stream; please retry");
        return sendJson(res, err.status, err.body);
      }
      json.model = upstreamBody.model;
      const out = fromOpenAI(json, requestedModel);
      dump("response", { openai: json, anthropic: out });
      log(`${tag} → 200 in ${elapsed()} in=${out.usage.input_tokens}+${out.usage.cache_read_input_tokens}c out=${out.usage.output_tokens} stop=${out.stop_reason}`);
      done = true;
      return sendJson(res, 200, out);
    }

    if (!upstreamBody.stream) {
      const text = await up.text();
      done = true;
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        const err = anthropicError(502, "api_error", `upstream returned non-JSON: ${text.slice(0, 300)}`);
        return sendJson(res, err.status, err.body);
      }
      const out = fromOpenAI(json, requestedModel);
      dump("response", { openai: json, anthropic: out });
      log(`${tag} → 200 in ${elapsed()} in=${out.usage.input_tokens}+${out.usage.cache_read_input_tokens}c out=${out.usage.output_tokens} stop=${out.stop_reason}`);
      return sendJson(res, 200, out);
    }

    // ---- streaming: the AnthropicStream starts writing to the client on the first event, so an
    // upstream stream that turns out empty can still be retried without the client noticing.
    const stream = new AnthropicStream(res, requestedModel, genId("msg"));
    let finishReason = null;
    let usage = null;
    let sawDone = false;
    let sawChoice = false;
    let ordinal = 0;
    try {
      for await (const payload of sseEvents(up.body)) {
        if (sawDone) continue; // Zen appends a {"choices":[],"cost":"0"} line after [DONE]
        if (payload === "[DONE]") {
          sawDone = true;
          continue;
        }
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        if (chunk.error) {
          const msg = chunk.error.message || JSON.stringify(chunk.error);
          log(`${tag} → stream error: ${msg}`);
          stream.error(`[zen upstream] ${msg}`);
          done = true;
          return;
        }
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) continue;
        sawChoice = true;
        const d = choice.delta || {};
        const reasoning = d.reasoning_content ?? d.reasoning;
        if (typeof reasoning === "string") stream.thinking(reasoning);
        if (typeof d.content === "string") stream.text(d.content);
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            if (tc && typeof tc === "object") stream.toolCall(tc, ordinal++);
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (e) {
      done = true;
      if (ac.signal.aborted) {
        log(`${tag} → client aborted after ${elapsed()}`);
        return;
      }
      log(`${tag} → stream read error: ${e.message}`);
      if (stream.started) stream.error(`upstream stream error: ${e.message}`);
      else {
        const err = anthropicError(502, "api_error", `upstream stream error: ${e.message}`);
        sendJson(res, err.status, err.body);
      }
      return;
    }

    if (!sawChoice && !stream.started) {
      if (attempt < MAX_ATTEMPTS) {
        log(`${tag} → empty stream from upstream (retry ${attempt}/${MAX_ATTEMPTS - 1})`);
        await sleep(1000 * attempt);
        continue;
      }
      done = true;
      log(`${tag} → empty stream from upstream after ${MAX_ATTEMPTS} attempts`);
      const err = anthropicError(503, "overloaded_error", "[zen upstream] returned an empty stream; please retry");
      return sendJson(res, err.status, err.body);
    }

    done = true;
    stream.finish(finishReason, usage);
    const u = mapUsage(usage);
    log(`${tag} → 200 in ${elapsed()} in=${u.input_tokens}+${u.cache_read_input_tokens}c out=${u.output_tokens} stop=${mapStop(finishReason, stream.sawToolUse)}`);
    return;
  }
}

function estimateTokens(body) {
  let chars = 0;
  const add = (v) => {
    if (typeof v === "string") chars += v.length;
    else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === "object") Object.values(v).forEach(add);
  };
  add(body.system);
  add(body.messages);
  add(body.tools);
  return Math.ceil(chars / 3.6);
}

function handleCountTokens(res, rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    const e = anthropicError(400, "invalid_request_error", "invalid JSON body");
    return sendJson(res, e.status, e.body);
  }
  sendJson(res, 200, { input_tokens: estimateTokens(body) });
}

// ------------------------------------------------ OpenAI-compatible passthrough

const EFFORT_MAP = { none: "low", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" };

// Rewrite the things OpenAI clients send that Zen's free endpoint rejects (verified 2026-08-22):
//   role "developer"       -> [1214] Incorrect role information
//   max_completion_tokens  -> "Endpoint is unavailable"
//   reasoning_effort other than low/high/max -> [1210] (thinking can't be disabled either)
function normalizeOpenAIBody(body) {
  const out = { ...body };
  out.model = resolveModel(body.model);
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((m) => (m && m.role === "developer" ? { ...m, role: "system" } : m));
  }
  if (out.max_completion_tokens != null) {
    if (out.max_tokens == null) out.max_tokens = out.max_completion_tokens;
    delete out.max_completion_tokens;
  }
  if (typeof out.max_tokens === "number") out.max_tokens = Math.max(1, Math.min(out.max_tokens, CONFIG.maxOutputTokens));
  if (out.reasoning_effort != null) {
    const mapped = EFFORT_MAP[String(out.reasoning_effort).toLowerCase()];
    if (mapped) out.reasoning_effort = mapped;
    else delete out.reasoning_effort;
  }
  if (CONFIG.reasoningEffort && out.reasoning_effort == null) out.reasoning_effort = CONFIG.reasoningEffort;
  if (out.stream && !out.stream_options) out.stream_options = { include_usage: true };
  for (const k of ["store", "metadata", "prompt_cache_key", "safety_identifier", "service_tier"]) delete out[k];
  return out;
}

async function handleChatCompletions(req, res, rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return sendJson(res, 400, { error: { message: "invalid JSON body", type: "invalid_request_error" } });
  }
  const t0 = Date.now();
  if (isClaudeModel(body.model)) {
    return sendJson(res, 400, {
      error: {
        message: `${body.model} is served by the Claude Pro route, which speaks the Anthropic Messages API. Configure the client with api: anthropic-messages and baseURL http://127.0.0.1:${CONFIG.port}/v1 instead of calling /v1/chat/completions.`,
        type: "invalid_request_error",
        code: "claude_route_requires_messages_api",
      },
    });
  }
  const upstreamBody = normalizeOpenAIBody(body);
  const free = isFreeModel(upstreamBody.model);
  // Free tier only serves agent-shaped, streaming requests; paid models pass through untouched.
  const wire = free ? ensureAgentShape(upstreamBody) : upstreamBody;
  const ids = requestIds(req, wire.messages);
  const forwarded = upstreamHeaders(ids, req);
  dump("openai-request", { client: body, upstream: upstreamBody, wire, headers: forwarded });
  const tag = `[openai] ${body.model || "?"}→${upstreamBody.model} ${free ? "free" : "paid"} ${wire.stream ? "stream" : "sync"} msgs=${upstreamBody.messages?.length || 0} tools=${upstreamBody.tools?.length || 0}`;

  const ac = new AbortController();
  let done = false;
  req.on("close", () => {
    if (!done) ac.abort();
  });

  let currentIds = ids;
  let currentForwarded = forwarded;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let up;
    try {
      up = await fetch(CONFIG.upstreamUrl, { method: "POST", headers: currentForwarded, body: JSON.stringify(wire) });
    } catch (e) {
      done = true;
      log(`${tag} → upstream connection error: ${e.message}`);
      return sendJson(res, 502, { error: { message: `upstream connection error: ${e.message}`, type: "api_error" } });
    }
    const ct = up.headers.get("content-type") || "application/json";
    const headers = { ...CORS, "content-type": ct, "cache-control": "no-cache", "x-accel-buffering": "no" };

    if (!up.ok) {
      const text = await up.text().catch(() => "");
      if ((up.status === 429 || /FreeUsageLimitError|free usage limit|rate.?limit/i.test(text)) && attempt < MAX_ATTEMPTS) {
        try {
          currentIds = freshIds();
          currentForwarded = upstreamHeaders(currentIds, req);
          log(`${tag} → regenerated session ${currentIds.session} due to ${up.status} (retry ${attempt}/${MAX_ATTEMPTS - 1})`);
          await sleep(1500 * attempt + Math.floor(Math.random() * 500));
          continue;
        } catch (e) {
          log(`${tag} → failed to regenerate session: ${e.message}`);
        }
      }
      done = true;
      res.writeHead(up.status, headers);
      res.end(text);
      log(`${tag} → ${up.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s ${text.length}B ${text.slice(0, 300).replace(/\s+/g, " ")}`);
      dump("upstream-error", { status: up.status, text });
      return;
    }

    if (free && !upstreamBody.stream) {
      // Free tier only serves streaming agent-shaped requests, so a non-streaming caller's
      // reply must be re-joined from the upstream SSE stream into one chat.completion object.
      let json;
      try {
        json = await collectCompletion(up);
      } catch (e) {
        done = true;
        log(`${tag} → aggregation error: ${e.message}`);
        return sendJson(res, 502, { error: { message: `upstream error: ${e.message}`, type: "api_error" } });
      }
      if (!json) {
        if (attempt < MAX_ATTEMPTS) {
          log(`${tag} → empty stream from upstream (retry ${attempt}/${MAX_ATTEMPTS - 1})`);
          await sleep(1000 * attempt);
          continue;
        }
        done = true;
        log(`${tag} → empty stream from upstream after ${MAX_ATTEMPTS} attempts`);
        return sendJson(res, 503, { error: { message: "[zen upstream] returned an empty stream; please retry", type: "server_error" } });
      }
      json.model ||= wire.model;
      done = true;
      sendJson(res, 200, json);
      log(`${tag} → 200 in ${((Date.now() - t0) / 1000).toFixed(1)}s in=${json.usage?.prompt_tokens ?? "?"} out=${json.usage?.completion_tokens ?? "?"} finish=${json.choices?.[0]?.finish_reason ?? "?"}`);
      return;
    }

    if (!upstreamBody.stream) {
      const text = await up.text().catch(() => "");
      done = true;
      res.writeHead(up.status, headers);
      res.end(text);
      let extra = "";
      try {
        const j = JSON.parse(text);
        extra = ` in=${j.usage?.prompt_tokens ?? "?"} out=${j.usage?.completion_tokens ?? "?"} finish=${j.choices?.[0]?.finish_reason ?? "?"}`;
      } catch {}
      log(`${tag} → ${up.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s ${text.length}B${extra}`);
      return;
    }

    // Streaming: hold the bytes back until the first real chunk (one with a `choices` entry) so an
    // empty stream can be retried; after that, pass everything through untouched.
    let held = [];
    let flushed = false;
    let bytes = 0;
    let pending = "";
    try {
      for await (const chunk of up.body) {
        bytes += chunk.length;
        if (flushed) {
          res.write(chunk);
          continue;
        }
        held.push(chunk);
        pending += Buffer.from(chunk).toString("utf8");
        if (/^data:\s*\{[^\n]*"choices"\s*:\s*\[\s*\{/m.test(pending)) {
          res.writeHead(up.status, headers);
          for (const h of held) res.write(h);
          held = [];
          pending = "";
          flushed = true;
        }
      }
    } catch (e) {
      if (ac.signal.aborted) {
        done = true;
        return;
      }
      log(`${tag} → stream read error: ${e.message}`);
      if (!flushed) {
        done = true;
        return sendJson(res, 502, { error: { message: `upstream stream error: ${e.message}`, type: "api_error" } });
      }
    }
    if (!flushed) {
      if (attempt < MAX_ATTEMPTS) {
        log(`${tag} → empty stream from upstream (retry ${attempt}/${MAX_ATTEMPTS - 1})`);
        await sleep(1000 * attempt);
        continue;
      }
      done = true;
      log(`${tag} → empty stream from upstream after ${MAX_ATTEMPTS} attempts`);
      return sendJson(res, 503, { error: { message: "[zen upstream] returned an empty stream; please retry", type: "server_error" } });
    }
    done = true;
    res.end();
    log(`${tag} → ${up.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s ${bytes}B`);
    return;
  }
}

function isFreeModel(id) {
  return /-free$/i.test(id) || id === "big-pickle" || id === CONFIG.upstreamModel;
}

async function handleModels(res) {
  const aliasEntry = {
    id: CONFIG.alias, object: "model", type: "model", owned_by: "zen-proxy", created: 1787270400, created_at: "2026-08-20T00:00:00Z",
    display_name: `Ox Alpha via Zen (${CONFIG.upstreamModel})`,
  };
  let upstream = [];
  try {
    const r = await fetch(CONFIG.upstreamModelsUrl, { headers: modelsHeaders() });
    if (r.ok) {
      const j = await r.json();
      const list = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
      upstream = list
        .filter((m) => m && typeof m.id === "string" && (CONFIG.models === "all" || isFreeModel(m.id)))
        .map((m) => ({ ...m, object: "model", type: "model", owned_by: m.owned_by || "opencode-zen", created: m.created || 1787270400, created_at: m.created_at || "2026-08-20T00:00:00Z", display_name: m.display_name || m.name || m.id }));
    } else log(`[models] upstream ${r.status}`);
  } catch (e) {
    log(`[models] upstream error: ${e.message}`);
  }
  const data = [aliasEntry, ...upstream.filter((m) => m.id !== CONFIG.alias)];
  if (CLAUDE.enabled) {
    const created = (iso) => Math.floor(new Date(iso).getTime() / 1000);
    for (const m of CLAUDE_MODELS) {
      data.push({
        id: m.id,
        object: "model",
        type: "model",
        owned_by: "anthropic",
        created: created(m.created_at),
        created_at: m.created_at,
        display_name: m.display_name,
        context_window: m.max_input_tokens,
        max_tokens: m.max_tokens,
      });
    }
  }
  sendJson(res, 200, { object: "list", data, has_more: false, first_id: data[0].id, last_id: data[data.length - 1].id });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = (url.pathname.replace(/\/+$/, "") || "/").replace(/^\/v1(?=\/|$)/, "") || "/";
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      return res.end();
    }
    if (req.method === "POST" && p === "/messages") return await handleMessages(req, res, await readBody(req));
    if (req.method === "POST" && p === "/messages/count_tokens") return handleCountTokens(res, await readBody(req));
    if (req.method === "POST" && p === "/chat/completions") return await handleChatCompletions(req, res, await readBody(req));
    if (req.method === "GET" && p === "/models") return await handleModels(res);
    if (req.method === "GET" && (p === "/" || p === "/health")) return sendJson(res, 200, { ok: true, upstream: CONFIG.upstreamUrl, model: CONFIG.upstreamModel, alias: CONFIG.alias, claude: CLAUDE.enabled ? { route: CLAUDE.messagesUrl, models: CLAUDE_MODELS.length } : false });
    const e = anthropicError(404, "not_found_error", `no route for ${req.method} ${url.pathname}`);
    return sendJson(res, e.status, e.body);
  } catch (e) {
    log(`unhandled error on ${req.method} ${p}: ${e.stack || e.message}`);
    if (!res.headersSent) {
      const err = anthropicError(500, "api_error", `proxy error: ${e.message}`);
      sendJson(res, err.status, err.body);
    } else res.end();
  }
});
server.requestTimeout = 0;
server.headersTimeout = 120000;
server.keepAliveTimeout = 120000;

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    log(`port ${CONFIG.port} already in use — another zen-proxy is probably running. Exiting.`);
    process.exit(0);
  }
  log(`server error: ${e.message}`);
  process.exit(1);
});

server.listen(CONFIG.port, CONFIG.host, () => {
  process.title = "zen-proxy (Ox Alpha)"; // console window title on Windows
  log(`zen-proxy listening on http://${CONFIG.host}:${CONFIG.port}`);
  log(`  upstream : ${CONFIG.upstreamUrl}`);
  log(`  model    : ${CONFIG.alias} -> ${CONFIG.upstreamModel}${CONFIG.upstreamApiKey ? " (with API key)" : " (no auth header)"}`);
  log(`  images   : ${CONFIG.images}${CONFIG.reasoningEffort ? `, reasoning_effort=${CONFIG.reasoningEffort}` : ""}${CONFIG.debug ? `, debug dumps in ${DEBUG_DIR}` : ""}`);
});
