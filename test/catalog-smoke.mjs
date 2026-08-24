// mcp-catalog pre-step: inject once while the catalog is on the session
// surface; re-append after compaction removes it. Isolated dataDir, no
// network, no real profile.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { apply } from "../lib/index.js";

const tmp = join(homedir(), ".dsh-catalog-smoke-" + process.pid);
const dataDir = join(tmp, "data");
await rm(tmp, { recursive: true, force: true });
await mkdir(dataDir, { recursive: true });

await writeFile(join(dataDir, "registry.json"), `${JSON.stringify({
  version: 1,
  entries: [
    {
      name: "demo",
      tier: "on-demand",
      transport: "streamable-http",
      url: "http://127.0.0.1:1/mcp/",
      serverDescription: "demo MCP",
      notes: "",
      tools: [{ name: "ping", description: "ping" }],
      metaFetchedAt: "2020-01-01T00:00:00.000Z",
    },
  ],
}, null, 2)}\n`, "utf8");

let preStep;
const ctx = {
  tools: { register() { return () => {}; } },
  skills: { registerProvider() { return () => {}; } },
  on(event, handler) {
    if (event === "agent/pre-step") preStep = handler;
    return () => {};
  },
  effect() { return () => {}; },
  get() { return undefined; },
  logger: { warn() {}, error() {}, info() {} },
};

await apply(ctx, { dataDir, profile: "__test__", importNativeMcp: false });
await new Promise((resolve) => setTimeout(resolve, 50));

const failed = [];
const signal = { throwIfAborted() {} };

function catalogCount(messages) {
  return messages.filter((message) => message?.source?.kind === "mcp-catalog").length;
}

function lastCatalog(messages) {
  return [...messages].reverse().find((message) => message?.source?.kind === "mcp-catalog");
}

const first = await preStep(
  { agent: { session: { surface: { nodes: [] }, events: [] } }, signal },
  async () => ({ kind: "enter", messages: [] }),
);
if (catalogCount(first.messages) !== 1) failed.push("first step did not inject mcp-catalog");
const injected = lastCatalog(first.messages);
if (injected?.source?.digest === undefined || injected.source.digest === "") failed.push("injected catalog missing digest");

const seq = 7;
const stillVisible = await preStep(
  {
    agent: {
      session: {
        surface: { nodes: [seq] },
        events: [{ seq, type: "user/message", data: { source: injected.source } }],
      },
    },
    signal,
  },
  async () => ({ kind: "enter", messages: [] }),
);
if (catalogCount(stillVisible.messages) !== 0) failed.push("visible catalog was re-injected");

const compacted = await preStep(
  {
    agent: {
      session: {
        surface: { nodes: [99] },
        events: [{ seq, type: "user/message", data: { source: injected.source } }],
      },
    },
    signal,
  },
  async () => ({ kind: "enter", messages: [] }),
);
if (catalogCount(compacted.messages) !== 1) failed.push("compaction did not re-inject mcp-catalog");

await rm(tmp, { recursive: true, force: true });

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("CATALOG SMOKE FAILED");
  process.exit(1);
}
console.log("CATALOG SMOKE PASSED");
