// Confirmation gate: when the host has an approval seam composed, a
// model-driven mcp_register that would spawn a NEW or connection-changed
// stdio command must surface { kind: "ask" } through tools/pre-execute so the
// user decides. Tier/notes-only edits, HTTP transports, and hosts without an
// approval seam pass through unchanged (legacy behavior).

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { apply } from "../lib/index.js";

// Keep this test off the user's real ~/.dsh (reconcile reads/writes the
// profile patch file); dshHome() resolves DSH_HOME lazily at apply() time.
process.env.DSH_HOME = process.cwd() + "/.test-data/dsh-home";

const tmp = join(process.cwd(), `.test-stdio-confirm-${process.pid}`);
await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });

const failed = [];

function captureCtx({ withApproval }) {
  const listeners = new Map();
  return {
    listeners,
    ctx: {
      tools: { register() { return () => {}; } },
      skills: { registerProvider() { return () => {}; } },
      on(event, handler) { listeners.set(event, handler); return () => listeners.delete(event); },
      effect() { return () => {}; },
      get(name) {
        if (name === "approval" && withApproval) return { ask() { return "allowed-once"; } };
        return undefined;
      },
      logger: { warn() {}, error() {}, info() {} },
    },
  };
}

async function runGate(ctx, args) {
  const handler = ctx.listeners.get("tools/pre-execute");
  if (handler === undefined) throw new Error("tools/pre-execute listener not registered");
  return handler({ name: "mcp_register", arguments: args }, async () => ({ kind: "allow" }));
}

try {
  // 1. Host WITH approval seam: a new stdio registration asks.
  const dataDirA = join(tmp, "a");
  await mkdir(dataDirA, { recursive: true });
  const a = captureCtx({ withApproval: true });
  await apply(a.ctx, { dataDir: dataDirA, profile: "__test__", importNativeMcp: false });
  const ask = await runGate(a, { name: "evil", transport: "stdio", command: "/bin/bash", args: ["-c", "echo hi"] });
  if (ask?.kind !== "ask") failed.push(`new stdio registration should ask, got ${JSON.stringify(ask)}`);
  if (typeof ask?.reason === "string" && !ask.reason.includes("/bin/bash")) failed.push("ask reason should name the command");

  // 2. HTTP transport never asks (no local spawn).
  const http = await runGate(a, { name: "remote", transport: "streamable-http", url: "http://127.0.0.1:9/mcp" });
  if (http?.kind !== "allow") failed.push(`streamable-http registration should pass through, got ${JSON.stringify(http)}`);

  // 3. Tier/notes-only edit of an EXISTING stdio entry never asks.
  await writeFile(join(dataDirA, "registry.json"), `${JSON.stringify({
    version: 1,
    entries: [{
      id: "known", name: "known", tier: "on-demand", transport: "stdio",
      command: "/usr/bin/yes", args: [], env: {}, cwd: null, url: null, headers: {},
      notes: "", tools: [], disabledTools: [], managed: true,
      registeredAt: "2026-01-01T00:00:00.000Z", lastSyncAt: "2026-01-01T00:00:00.000Z",
    }],
  }, null, 2)}\n`, "utf8");
  const b = captureCtx({ withApproval: true });
  await apply(b.ctx, { dataDir: dataDirA, profile: "__test__", importNativeMcp: false });
  const tierEdit = await runGate(b, { name: "known", tier: "disabled", notes: "user note" });
  if (tierEdit?.kind !== "allow") failed.push(`tier/notes-only edit should pass through, got ${JSON.stringify(tierEdit)}`);
  const envEdit = await runGate(b, { name: "known", env: { A: "1" } });
  if (envEdit?.kind !== "ask") failed.push(`stdio connection-contract change should ask, got ${JSON.stringify(envEdit)}`);

  // 4. Host WITHOUT approval seam: legacy silent pass-through.
  const dataDirB = join(tmp, "b");
  await mkdir(dataDirB, { recursive: true });
  const c = captureCtx({ withApproval: false });
  await apply(c.ctx, { dataDir: dataDirB, profile: "__test__", importNativeMcp: false });
  const silent = await runGate(c, { name: "evil", transport: "stdio", command: "/bin/bash", args: ["-c", "echo hi"] });
  if (silent?.kind !== "allow") failed.push(`no approval seam should keep legacy behavior, got ${JSON.stringify(silent)}`);

  // 5. confirmStdioRegister: false disables the gate.
  const d = captureCtx({ withApproval: true });
  await apply(d.ctx, { dataDir: dataDirB, profile: "__test__", importNativeMcp: false, confirmStdioRegister: false });
  const off = await runGate(d, { name: "evil", transport: "stdio", command: "/bin/bash", args: ["-c", "echo hi"] });
  if (off?.kind !== "allow") failed.push(`confirmStdioRegister:false should disable the gate, got ${JSON.stringify(off)}`);

  // 6. Non-mcp_register tools pass through even with approval composed.
  const passthrough = await runGate(a, undefined).catch(() => "threw");
  if (passthrough === "threw") failed.push("gate must tolerate exec.arguments undefined");
} finally {
  await rm(tmp, { recursive: true, force: true });
}

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("STDIO CONFIRM SMOKE FAILED");
  process.exit(1);
}
console.log("STDIO CONFIRM SMOKE PASSED");
