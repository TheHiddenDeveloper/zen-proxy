// Spawns proxy.js on a scratch port, runs both suites against it, shuts it down.
// These are live smoke tests: they talk to Zen's real free endpoint, so they need network access.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.ZEN_PROXY_TEST_PORT || 4041);
const base = `http://127.0.0.1:${port}`;

const proxy = spawn(process.execPath, [path.join(here, "..", "proxy.js")], {
  env: { ...process.env, PROXY_PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"],
});
proxy.stdout.on("data", (d) => process.stdout.write(`  [proxy] ${d}`));

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("proxy did not start");
}

function runSuite(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, file)], { env: { ...process.env, ZEN_PROXY_BASE: base }, stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

let failed = 0;
try {
  await waitForHealth();
  for (const suite of ["openai.test.mjs", "anthropic.test.mjs"]) {
    console.log(`\n=== ${suite} ===`);
    failed += await runSuite(suite);
  }
} catch (e) {
  console.error(e.message);
  failed = 1;
} finally {
  proxy.kill();
}
console.log(failed ? "\nSOME TESTS FAILED" : "\nALL SUITES PASSED");
process.exit(failed ? 1 : 0);
