#!/usr/bin/env node
"use strict";
/**
 * zen-proxy — use OpenCode Zen's free models (Ox Alpha, Big Pickle, ...) from Claude Code and
 * any OpenAI-compatible client, without an API key.   https://github.com/Dalailalama/zen-proxy
 *
 *   Claude Code  --Anthropic Messages API-->  this proxy  --OpenAI chat/completions-->  Zen
 *   OpenAI-style client  --chat/completions-->  this proxy  --(auth header stripped)-->  Zen
 *
 * Zero dependencies, Node 18+. Serves:
 *   - POST /v1/messages              Anthropic Messages API, translated (streaming, tools, tool results, system prompts)
 *   - POST /v1/messages/count_tokens local estimate
 *   - POST /v1/chat/completions      OpenAI-compatible passthrough for any OpenAI-style client (deepseek-harness,
 *                                    Cursor, Continue, ...): strips the Authorization header, rewrites request quirks
 *                                    Zen rejects (developer role, max_completion_tokens, unsupported reasoning_effort)
 *   - GET  /v1/models                Zen's model list (free models only unless MODELS=all) plus the alias entry
 *   The /v1 prefix is optional on every route, and CORS is open for browser-based clients.
 *
 * Zen's free models reject ANY Authorization header that isn't a real key, so by default
 * NO auth header is sent upstream (UPSTREAM_API_KEY empty). Images are replaced with a text
 * placeholder because the free endpoint returns 503 for image input (IMAGES=forward to try anyway).
 *
 * Config (env vars):
 *   PROXY_HOST=127.0.0.1  PROXY_PORT=4040
 *   UPSTREAM_URL=https://opencode.ai/zen/v1/chat/completions
 *   UPSTREAM_MODEL=x-preview-f-free      model every "ox-alpha" / "claude-*" request is mapped to
 *   UPSTREAM_API_KEY=                     leave empty for Zen free models
 *   MODEL_ALIAS=ox-alpha                  model name Claude Code uses
 *   REASONING_EFFORT=                     low | high | max  (Ox Alpha cannot disable thinking)
 *   IMAGES=strip                          strip | forward
 *   MODELS=free                           free | all   (which Zen models GET /v1/models lists)
 *   DEBUG=1                               dump request/response JSON to <tmpdir>/zen-proxy/
 */

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const CONFIG = {
  host: process.env.PROXY_HOST || "127.0.0.1",
  port: Number(process.env.PROXY_PORT || 4040),
  upstreamUrl: process.env.UPSTREAM_URL || "https://opencode.ai/zen/v1/chat/completions",
  upstreamModel: process.env.UPSTREAM_MODEL || "x-preview-f-free",
  upstreamApiKey: process.env.UPSTREAM_API_KEY || "",
  alias: process.env.MODEL_ALIAS || "ox-alpha",
  reasoningEffort: (process.env.REASONING_EFFORT || "").trim(),
  images: (process.env.IMAGES || "strip").trim(),
  models: (process.env.MODELS || "free").trim(),
  debug: !!process.env.DEBUG,
  maxOutputTokens: 131072,
};
CONFIG.upstreamModelsUrl = CONFIG.upstreamUrl.replace(/\/chat\/completions\/?$/, "") + "/models";

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

function upstreamHeaders() {
  const h = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (CONFIG.upstreamApiKey) h.authorization = `Bearer ${CONFIG.upstreamApiKey}`;
  return h;
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
  toolCall(tc, ordinal) {
    const key = typeof tc.index === "number" ? tc.index : ordinal;
    let st = this.tools.get(key);
    const isNew = !st || (tc.id && st.id && tc.id !== st.id);
    if (isNew) {
      const id = String(tc.id || genId("toolu"));
      const name = tc.function?.name || "";
      st = this.open("tool_use", { type: "tool_use", id, name, input: {} }, key);
      st.id = id;
      this.tools.set(key, st);
      this.sawToolUse = true;
    } else if (this.current !== st) {
      // Continuation for a block we already closed (rare): reopen tracking on the same index.
      this.closeCurrent();
      this.current = st;
    }
    const args = tc.function?.arguments;
    if (typeof args === "string" && args.length) {
      this.event("content_block_delta", { type: "content_block_delta", index: st.index, delta: { type: "input_json_delta", partial_json: args } });
      st.argBytes += args.length;
    }
  }
  finish(finishReason, usage) {
    if (this.ended) return;
    this.start();
    this.closeCurrent();
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

const RETRYABLE = new Set([500, 502, 503, 529]);
const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Zen's free endpoint sometimes answers 503 with an empty body, or a 200 SSE stream that carries no
// content at all (just [DONE]). Nothing has reached the client at that point, so retry transparently.
async function fetchUpstream(upstreamBody, signal, tag) {
  for (let attempt = 1; ; attempt++) {
    const up = await fetch(CONFIG.upstreamUrl, { method: "POST", headers: upstreamHeaders(), body: JSON.stringify(upstreamBody), signal });
    if (up.ok || !RETRYABLE.has(up.status) || attempt === MAX_ATTEMPTS) return up;
    const text = await up.text().catch(() => "");
    log(`${tag} → upstream ${up.status} ${text.slice(0, 120)} (retry ${attempt}/${MAX_ATTEMPTS - 1})`);
    await sleep(1000 * attempt);
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
  const requestedModel = body.model || CONFIG.alias;
  const upstreamBody = toOpenAI(body);
  dump("request", { anthropic: body, openai: upstreamBody });

  const ac = new AbortController();
  let done = false;
  req.on("close", () => {
    if (!done) ac.abort();
  });
  const tag = `${requestedModel}→${upstreamBody.model} ${upstreamBody.stream ? "stream" : "sync"} msgs=${upstreamBody.messages.length} tools=${upstreamBody.tools?.length || 0}`;
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let up;
    try {
      up = await fetchUpstream(upstreamBody, ac.signal, tag);
    } catch (e) {
      done = true;
      if (ac.signal.aborted) return; // client went away
      log(`${tag} → upstream connection error: ${e.message}`);
      const err = anthropicError(502, "api_error", `upstream connection error: ${e.message}`);
      return sendJson(res, err.status, err.body);
    }

    if (!up.ok) {
      done = true;
      const text = await up.text().catch(() => "");
      const err = mapUpstreamError(up.status, text);
      log(`${tag} → ${up.status} ${text.slice(0, 300)}`);
      dump("upstream-error", { status: up.status, text });
      return sendJson(res, err.status, err.body);
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
  const upstreamBody = normalizeOpenAIBody(body);
  dump("openai-request", { client: body, upstream: upstreamBody });
  const tag = `[openai] ${body.model || "?"}→${upstreamBody.model} ${upstreamBody.stream ? "stream" : "sync"} msgs=${upstreamBody.messages?.length || 0} tools=${upstreamBody.tools?.length || 0}`;

  const ac = new AbortController();
  let done = false;
  req.on("close", () => {
    if (!done) ac.abort();
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let up;
    try {
      up = await fetchUpstream(upstreamBody, ac.signal, tag);
    } catch (e) {
      done = true;
      if (ac.signal.aborted) return;
      log(`${tag} → upstream connection error: ${e.message}`);
      return sendJson(res, 502, { error: { message: `upstream connection error: ${e.message}`, type: "api_error" } });
    }
    const ct = up.headers.get("content-type") || "application/json";
    const headers = { ...CORS, "content-type": ct, "cache-control": "no-cache", "x-accel-buffering": "no" };

    if (!up.ok || !upstreamBody.stream) {
      const text = await up.text().catch(() => "");
      done = true;
      res.writeHead(up.status, headers);
      res.end(text);
      let extra = "";
      if (!up.ok) extra = " " + text.slice(0, 300).replace(/\s+/g, " ");
      else {
        try {
          const j = JSON.parse(text);
          extra = ` in=${j.usage?.prompt_tokens ?? "?"} out=${j.usage?.completion_tokens ?? "?"} finish=${j.choices?.[0]?.finish_reason ?? "?"}`;
        } catch {}
      }
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
    const r = await fetch(CONFIG.upstreamModelsUrl, { headers: upstreamHeaders() });
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
    if (req.method === "GET" && (p === "/" || p === "/health")) return sendJson(res, 200, { ok: true, upstream: CONFIG.upstreamUrl, model: CONFIG.upstreamModel, alias: CONFIG.alias });
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
