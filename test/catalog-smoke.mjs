// mcp-catalog pre-step: inject once while the catalog is on the session
// surface; re-append after compaction removes it, when the stored entries are
// unreadable (older format), or when the catalog content changes. The mock
// mirrors the real host Session API (seq + eventAt + surface.nodes) — the
// earlier events-array mock simulated `agent.session.events`, which does not
// exist on the host and hid a real-machine re-injection on every turn.
// Isolated dataDir, no network, no real profile.

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
const registrations = [];
const ctx = {
  tools: {
    register(definition) {
      const record = { definition, active: true };
      registrations.push(record);
      return () => { record.active = false; };
    },
  },
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
const enter = async () => ({ kind: "enter", messages: [] });

// Durable-log mock shaped like the real host Session: events are read via
// eventAt(seq) from a log with an explicit length; surface.nodes holds the
// seqs still visible (compaction empties it).
function makeSession() {
  const events = [];
  const surface = { nodes: [] };
  const agent = {
    session: {
      seq: 0,
      surface,
      eventAt(index) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= events.length) return undefined;
        return events[index];
      },
    },
  };
  return {
    agent,
    append(event) {
      const seq = events.length;
      events.push({ seq, ...event });
      surface.nodes.push(seq);
      agent.session.seq = events.length;
    },
    appendRaw(event) {
      const seq = events.length;
      events.push({ seq, ...event });
      surface.nodes.push(seq);
      agent.session.seq = events.length;
    },
    compact() {
      surface.nodes.length = 0;
    },
  };
}

function catalogCount(messages) {
  return messages.filter((message) => message?.source?.kind === "mcp-catalog").length;
}

function lastCatalog(messages) {
  return [...messages].reverse().find((message) => message?.source?.kind === "mcp-catalog");
}

// 1) First step on an empty session: inject exactly once; the source must not
//    declare a structured form — humans expand the card to the model-facing
//    text itself, never a lossy summary (no double standard).
const first = makeSession();
const firstResult = await preStep({ agent: first.agent, signal }, enter);
if (catalogCount(firstResult.messages) !== 1) failed.push("first step did not inject mcp-catalog");
const injected = lastCatalog(firstResult.messages);
const source = injected?.source;
if (source?.digest === undefined || source.digest === "") failed.push("injected catalog missing digest");
if ("form" in (source ?? {})) failed.push("injected catalog must not declare a form (opaque rendering keeps humans at parity)");
if (source?.entries !== undefined) failed.push("source must not carry entries (SourceFields would render the same information twice)");
first.append({ type: "user/message", data: { source } });

// 2) Catalog still visible and unchanged: no re-injection, turn after turn.
for (let round = 2; round <= 4; round += 1) {
  const result = await preStep({ agent: first.agent, signal }, enter);
  if (catalogCount(result.messages) !== 0) failed.push(`round ${round} re-injected the visible catalog`);
}

// 3) Compaction empties the surface: the catalog must be re-appended.
first.compact();
const compacted = await preStep({ agent: first.agent, signal }, enter);
if (catalogCount(compacted.messages) !== 1) failed.push("compaction did not re-inject mcp-catalog");
first.append({ type: "user/message", data: { source: lastCatalog(compacted.messages).source } });

// 4) A stored catalog without a readable digest (older formats, hand-edited
//    logs) cannot be identified: it must not count as visible.
const legacy = makeSession();
legacy.appendRaw({ type: "user/message", data: { source: { kind: "mcp-catalog", form: "catalog" } } });
const afterLegacy = await preStep({ agent: legacy.agent, signal }, enter);
if (catalogCount(afterLegacy.messages) !== 1) failed.push("a catalog without a readable digest must not count as visible; expected fresh injection");

// 5) Registry content changes while the catalog is visible: new digest → inject.
const changed = makeSession();
const before = await preStep({ agent: changed.agent, signal }, enter);
if (catalogCount(before.messages) !== 1) failed.push("content-change scenario: first injection missing");
changed.append({ type: "user/message", data: { source: lastCatalog(before.messages).source } });
const mcpRegister = [...registrations].reverse().find((record) => record.active && record.definition.name === "mcp_register")?.definition;
if (!mcpRegister) {
  failed.push("mcp_register definition missing");
} else {
  await mcpRegister.execute({ name: "demo", notes: "changed note" });
  const after = await preStep({ agent: changed.agent, signal }, enter);
  if (catalogCount(after.messages) !== 1) failed.push("digest change while visible did not re-inject");
  if (lastCatalog(after.messages).source.digest === lastCatalog(before.messages).source.digest) {
    failed.push("digest did not change after notes edit");
  }
}

await rm(tmp, { recursive: true, force: true });

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("CATALOG SMOKE FAILED");
  process.exit(1);
}
console.log("CATALOG SMOKE PASSED");
