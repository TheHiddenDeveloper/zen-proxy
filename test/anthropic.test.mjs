// Anthropic Messages API translation, using request shapes the way Claude Code sends them
// (system array with cache_control, tool definitions incl. a server tool, tool results, images, thinking blocks).
const BASE = process.env.ZEN_PROXY_BASE || "http://127.0.0.1:4040";
const H = { "content-type": "application/json", "x-api-key": "zen-proxy", "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31" };
let failures = 0;
const ok = (cond, label, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`); if (!cond) failures++; };

// Zen's free endpoint occasionally answers 503 "Endpoint is unavailable"; clients retry, so do we.
async function fetchRetry(url, init, tries = 3) {
  for (let i = 1; ; i++) {
    const r = await fetch(url, init);
    if (![500, 502, 503, 529].includes(r.status) || i >= tries) return r;
    console.log(`retry ${i}/${tries - 1}: upstream ${r.status}`);
    await r.text().catch(() => {});
    await new Promise((res) => setTimeout(res, 2000 * i));
  }
}

async function msg(body) {
  const r = await fetchRetry(`${BASE}/v1/messages?beta=true`, { method: "POST", headers: H, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

async function stream(body) {
  const r = await fetchRetry(`${BASE}/v1/messages`, { method: "POST", headers: H, body: JSON.stringify({ ...body, stream: true }) });
  const events = [];
  let buf = "", cur = null;
  for await (const c of r.body) {
    buf += Buffer.from(c).toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
      if (line.startsWith("event: ")) cur = line.slice(7);
      else if (line.startsWith("data: ")) events.push({ event: cur, data: JSON.parse(line.slice(6)) });
    }
  }
  const blocks = [];
  let stop = null, usage = null;
  for (const e of events) {
    const d = e.data;
    if (d.type === "content_block_start") blocks[d.index] = { ...d.content_block, _json: "" };
    else if (d.type === "content_block_delta") {
      const b = blocks[d.index];
      if (d.delta.type === "text_delta") b.text += d.delta.text;
      else if (d.delta.type === "thinking_delta") b.thinking += d.delta.thinking;
      else if (d.delta.type === "input_json_delta") b._json += d.delta.partial_json;
    } else if (d.type === "message_delta") { stop = d.delta.stop_reason; usage = d.usage; }
  }
  for (const b of blocks) if (b && b.type === "tool_use") b.input = JSON.parse(b._json || "{}");
  return { status: r.status, events, blocks, stop, usage, types: events.map((e) => e.event) };
}

const SYSTEM = [{ type: "text", text: "You are Claude Code, a CLI coding assistant. Be terse.", cache_control: { type: "ephemeral" } }];
const TOOLS = [
  { name: "Bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string", description: "The command to run" } }, required: ["command"], additionalProperties: false, $schema: "http://json-schema.org/draft-07/schema#" }, cache_control: { type: "ephemeral" } },
  { name: "Read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
  { type: "web_search_20250305", name: "web_search", max_uses: 3 }, // server tool: must be dropped, not crash
];

{
  const r = await fetch(`${BASE}/health`); const j = await r.json();
  ok(r.status === 200 && j.ok, "GET /health");
}

{
  const { status, json } = await msg({ model: "ox-alpha", max_tokens: 64, system: SYSTEM, metadata: { user_id: "abc" }, messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: pong", cache_control: { type: "ephemeral" } }] }] });
  const text = json?.content?.find((b) => b.type === "text")?.text;
  ok(status === 200 && text?.trim() === "pong", "non-stream text", `status=${status} text=${JSON.stringify(text)} stop=${json?.stop_reason} usage=${JSON.stringify(json?.usage)}`);
  console.log(`info  content block types: ${json?.content?.map((b) => b.type).join(",")} (thinking appears only when the model reasons)`);
}

{
  const s = await stream({ model: "claude-sonnet-5", max_tokens: 64, system: "Be terse.", messages: [{ role: "user", content: "Reply with exactly: pong" }] });
  const text = s.blocks.find((b) => b?.type === "text")?.text;
  ok(s.status === 200 && text?.trim() === "pong", "stream text (claude-* id mapped to upstream model)", `text=${JSON.stringify(text)} stop=${s.stop}`);
  ok(s.types[0] === "message_start" && s.types.at(-1) === "message_stop", "stream event framing", s.types.filter((t, i, a) => a.indexOf(t) === i).join(","));
  ok(s.usage && s.usage.output_tokens > 0 && s.usage.input_tokens + s.usage.cache_read_input_tokens > 0, "stream usage populated in message_delta", JSON.stringify(s.usage));
}

let toolUse;
{
  const { status, json } = await msg({ model: "ox-alpha", max_tokens: 512, system: SYSTEM, tools: TOOLS, tool_choice: { type: "auto" }, messages: [{ role: "user", content: "Use the Bash tool to list files in the current directory with `ls -la`. Call the tool now." }] });
  toolUse = json?.content?.find((b) => b.type === "tool_use");
  ok(status === 200 && toolUse?.name === "Bash" && typeof toolUse?.input?.command === "string" && json?.stop_reason === "tool_use", "non-stream tool_use", `status=${status} stop=${json?.stop_reason} tool=${JSON.stringify(toolUse)}`);
  if (toolUse) {
    const { status: s2, json: j2 } = await msg({ model: "ox-alpha", max_tokens: 256, system: SYSTEM, tools: TOOLS, messages: [
      { role: "user", content: "Use the Bash tool to list files in the current directory with `ls -la`. Call the tool now." },
      { role: "assistant", content: [{ type: "thinking", thinking: "stale thinking", signature: "" }, { type: "text", text: "Listing files." }, toolUse] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: [{ type: "text", text: "total 2\n-rw-r--r-- 1 u u 10 Aug 22 12:00 a.txt\n-rw-r--r-- 1 u u 20 Aug 22 12:00 b.md" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] }, { type: "text", text: "How many files are there? Answer with just the number." }] },
    ] });
    const t = j2?.content?.find((b) => b.type === "text")?.text;
    ok(s2 === 200 && /2/.test(t || ""), "tool_result round-trip (+ stale thinking block, + image inside tool_result)", `status=${s2} text=${JSON.stringify(t)}`);
  }
}

{
  const s = await stream({ model: "ox-alpha", max_tokens: 512, system: SYSTEM, tools: TOOLS, messages: [{ role: "user", content: "Read the file /tmp/notes.txt using the Read tool. Call the tool now." }] });
  const tu = s.blocks.find((b) => b?.type === "tool_use");
  ok(s.status === 200 && tu?.name === "Read" && typeof tu?.input?.file_path === "string" && s.stop === "tool_use", "stream tool_use", `tool=${JSON.stringify(tu && { name: tu.name, input: tu.input })} stop=${s.stop}`);
}

{
  const { status, json } = await msg({ model: "ox-alpha", max_tokens: 64, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }, { type: "text", text: "If you cannot see an image, reply exactly: no-image" }] }] });
  const t = json?.content?.find((b) => b.type === "text")?.text;
  ok(status === 200 && /no-image/i.test(t || ""), "image block stripped to placeholder", `status=${status} text=${JSON.stringify(t)}`);
}

{
  const r = await fetch(`${BASE}/v1/messages/count_tokens`, { method: "POST", headers: H, body: JSON.stringify({ model: "ox-alpha", system: SYSTEM, messages: [{ role: "user", content: "hello ".repeat(100) }] }) });
  const j = await r.json();
  ok(r.status === 200 && j.input_tokens > 50, "count_tokens estimate", `input_tokens=${j.input_tokens}`);
}

{
  const { status, json } = await msg({ model: "definitely-not-a-model", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
  ok(status === 400 && json?.error?.type === "invalid_request_error", "unknown model → 400 invalid_request_error", `status=${status} ${JSON.stringify(json?.error).slice(0, 160)}`);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
