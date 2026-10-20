// OpenAI-compatible passthrough: what deepseek-harness / pi-ai / Cursor-style clients send,
// including a placeholder Authorization header (Zen would 401 on it) and request quirks Zen rejects.
const BASE = `${process.env.ZEN_PROXY_BASE || "http://127.0.0.1:4040"}/v1`;
const H = { "content-type": "application/json", authorization: "Bearer placeholder-key-that-zen-would-reject" };
let failures = 0;
const ok = (c, label, extra = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`); if (!c) failures++; };

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

{
  const r = await fetch(`${BASE}/models`, { headers: H });
  const j = await r.json();
  const ids = (j.data || []).map((m) => m.id);
  ok(r.status === 200 && ids.includes("big-pickle") && ids.includes("ox-alpha"), "GET /v1/models (placeholder key stripped)", `count=${ids.length} ids=${ids.slice(0, 5).join(",")}…`);
  ok(!ids.includes("claude-opus-5"), "paid models filtered out by default");
}

{
  // The free tier forces agent tools into the request, and big-pickle sometimes calls one instead
  // of answering — retry until it actually says pong.
  let pass = false, seen = "";
  for (let i = 0; i < 3 && !pass; i++) {
    const r = await fetchRetry(`${BASE}/chat/completions`, { method: "POST", headers: H, body: JSON.stringify({
      model: "big-pickle", messages: [{ role: "developer", content: "Be terse." }, { role: "user", content: "Reply with exactly: pong. Do not call any tools." }],
      max_completion_tokens: 64, reasoning_effort: "medium", store: false,
    }) });
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content;
    seen = text?.trim() || "(empty)";
    // Models like to add a full stop even when told not to; don't fail the suite over it.
    pass = r.status === 200 && /^pong[.!]?$/i.test(text?.trim() || "");
    if (!pass) console.log(`retry ${i + 1}: got ${JSON.stringify(seen)}`);
  }
  ok(pass, "non-stream with developer role + max_completion_tokens + reasoning_effort=medium", `last=${JSON.stringify(seen)}`);
}

{
  const r = await fetchRetry(`${BASE}/chat/completions`, { method: "POST", headers: H, body: JSON.stringify({
    model: "big-pickle", messages: [{ role: "user", content: "Reply with exactly: pong" }], max_tokens: 64, stream: true,
  }) });
  let raw = "";
  for await (const c of r.body) raw += Buffer.from(c).toString("utf8");
  let text = "";
  for (const l of raw.split("\n")) if (l.startsWith("data: ") && !l.includes("[DONE]")) { try { text += JSON.parse(l.slice(6)).choices?.[0]?.delta?.content || ""; } catch {} }
  ok(r.status === 200 && r.headers.get("content-type")?.includes("text/event-stream") && text.trim() === "pong" && raw.includes("[DONE]"), "stream passthrough", `text=${JSON.stringify(text)}`);
}

{
  let pass = false, finish = null;
  for (let i = 0; i < 3 && !pass; i++) {
    const r = await fetchRetry(`${BASE}/chat/completions`, { method: "POST", headers: H, body: JSON.stringify({
      model: "big-pickle", max_tokens: 256,
      tools: [{ type: "function", function: { name: "get_time", description: "Get the current time", parameters: { type: "object", properties: {} } } }],
      messages: [{ role: "user", content: "What time is it? You MUST call the get_time tool to answer, then reply with the time." }],
    }) });
    const j = await r.json();
    finish = j.choices?.[0]?.finish_reason;
    pass = r.status === 200 && j.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === "get_time";
    if (!pass) console.log(`retry ${i + 1}: finish=${finish}`);
  }
  ok(pass, "tool call passthrough", `finish=${finish}`);
}

{
  const r = await fetchRetry(`${BASE}/chat/completions`, { method: "POST", headers: H, body: JSON.stringify({ model: "ox-alpha", messages: [{ role: "user", content: "Reply with exactly: pong" }], max_tokens: 32 }) });
  const j = await r.json();
  ok(r.status === 200 && j.model === "big-pickle", "alias ox-alpha → upstream model", `model=${j.model}`);
  const r2 = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: H, body: JSON.stringify({ model: "nope-model", messages: [{ role: "user", content: "hi" }], max_tokens: 8 }) });
  const j2 = await r2.json();
  ok(r2.status >= 400 && j2.error, "unknown model → upstream error passed through", `status=${r2.status}`);
}

{
  const base = BASE.replace(/\/v1$/, "");
  const r = await fetch(`${base}/models`);
  ok(r.status === 200, "GET /models without /v1 prefix");
  const o = await fetch(`${BASE}/chat/completions`, { method: "OPTIONS" });
  ok(o.status === 204 && o.headers.get("access-control-allow-origin") === "*", "CORS preflight");
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
