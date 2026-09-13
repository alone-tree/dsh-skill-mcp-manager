// mcp-catalog pre-step: inject once while the catalog is on the session
// surface; re-append after compaction removes it, when the stored text is
// unreadable, when the source is not this plugin's own, or when the catalog
// content changes. Identity is the model-facing text itself: the source is the
// kernel's generic plugin attribution, which the released migration edges audit
// against a closed set of kinds (a custom kind or an extra `digest` member
// makes historical logs unloadable). The mock mirrors the real host Session API
// (seq + eventAt + surface.nodes) and persists whole messages (content +
// source), so the text-based identity is exercised the way the log stores it.
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

const CATALOG_SOURCE = { kind: "plugin", plugin: "dsh-skill-mcp-manager" };

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
    compact() {
      surface.nodes.length = 0;
    },
  };
}

function catalogCount(messages) {
  return messages.filter((message) => message?.source?.kind === CATALOG_SOURCE.kind && message?.source?.plugin === CATALOG_SOURCE.plugin).length;
}

function lastCatalog(messages) {
  return [...messages].reverse().find((message) => message?.source?.kind === CATALOG_SOURCE.kind && message?.source?.plugin === CATALOG_SOURCE.plugin);
}

// Persist a returned message the way the host does: the whole message object,
// not just its source.
function persist(session, message) {
  session.append({ type: "user/message", data: { content: message.content, source: message.source } });
}

// 1) First step on an empty session: inject exactly once. The source must be
//    the kernel's plugin attribution with nothing else on it — no declared
//    form (humans expand the card to the model-facing text itself, never a
//    lossy summary) and no digest (the migration audit refuses that member).
const first = makeSession();
const firstResult = await preStep({ agent: first.agent, signal }, enter);
if (catalogCount(firstResult.messages) !== 1) failed.push("first step did not inject mcp-catalog");
const injected = lastCatalog(firstResult.messages);
if (JSON.stringify(injected?.source) !== JSON.stringify(CATALOG_SOURCE)) failed.push(`injected source must be exactly ${JSON.stringify(CATALOG_SOURCE)}, got ${JSON.stringify(injected?.source)}`);
if (injected?.source?.digest !== undefined) failed.push("source must not carry a digest (migration audit refuses it)");
if ("form" in (injected?.source ?? {})) failed.push("injected catalog must not declare a form (opaque rendering keeps humans at parity)");
if (injected?.source?.entries !== undefined) failed.push("source must not carry entries (SourceFields would render the same information twice)");
if (typeof injected?.content?.[0]?.text !== "string" || injected.content[0].text === "") failed.push("injected catalog must carry its model-facing text");
persist(first, injected);

// 2) Catalog still visible and unchanged: no re-injection, turn after turn.
for (let round = 2; round <= 4; round += 1) {
  const result = await preStep({ agent: first.agent, signal }, enter);
  if (catalogCount(result.messages) !== 0) failed.push(`round ${round} re-injected the visible catalog`);
}

// 3) Compaction empties the surface: the catalog must be re-appended.
first.compact();
const compacted = await preStep({ agent: first.agent, signal }, enter);
if (catalogCount(compacted.messages) !== 1) failed.push("compaction did not re-inject mcp-catalog");
persist(first, lastCatalog(compacted.messages));

// 4) A record carrying this plugin's source but no readable text cannot be
//    identified: it must not count as visible.
const shapeless = makeSession();
shapeless.append({ type: "user/message", data: { source: CATALOG_SOURCE } });
const afterShapeless = await preStep({ agent: shapeless.agent, signal }, enter);
if (catalogCount(afterShapeless.messages) !== 1) failed.push("a catalog record without readable text must not count as visible; expected fresh injection");

// 5) A record with the right text but somebody else's source must not count as
//    this plugin's catalog (a foreign message cannot suppress the injection).
const foreign = makeSession();
foreign.append({ type: "user/message", data: { source: { kind: "plugin", plugin: "time-context" }, content: lastCatalog(firstResult.messages).content } });
const afterForeign = await preStep({ agent: foreign.agent, signal }, enter);
if (catalogCount(afterForeign.messages) !== 1) failed.push("a foreign plugin source must not count as this plugin's catalog; expected fresh injection");

// 6) Historical logs repaired to the plugin shape are recognised: their text is
//    still the catalog, so resuming such a session must not inject a second copy.
const repaired = makeSession();
repaired.append({ type: "user/message", data: { source: CATALOG_SOURCE, content: lastCatalog(firstResult.messages).content } });
const afterRepaired = await preStep({ agent: repaired.agent, signal }, enter);
if (catalogCount(afterRepaired.messages) !== 0) failed.push("a repaired historical catalog must count as visible; expected no re-injection");

// 7) Registry content changes while the catalog is visible: the text changes,
//    so a fresh copy is appended.
const changed = makeSession();
const before = await preStep({ agent: changed.agent, signal }, enter);
if (catalogCount(before.messages) !== 1) failed.push("content-change scenario: first injection missing");
persist(changed, lastCatalog(before.messages));
const mcpRegister = [...registrations].reverse().find((record) => record.active && record.definition.name === "mcp_register")?.definition;
if (!mcpRegister) {
  failed.push("mcp_register definition missing");
} else {
  await mcpRegister.execute({ name: "demo", notes: "changed note" });
  const after = await preStep({ agent: changed.agent, signal }, enter);
  if (catalogCount(after.messages) !== 1) failed.push("text change while visible did not re-inject");
  if (lastCatalog(after.messages).content[0].text === lastCatalog(before.messages).content[0].text) {
    failed.push("catalog text did not change after notes edit");
  }
}

await rm(tmp, { recursive: true, force: true });

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("CATALOG SMOKE FAILED");
  process.exit(1);
}
console.log("CATALOG SMOKE PASSED");
