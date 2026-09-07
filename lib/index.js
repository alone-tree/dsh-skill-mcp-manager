// dsh-skill-mcp-manager — host plugin for DeepSeek Harness.
//
// Visual, manageable, injectable MCP management (Skill management lands in M1).
// Three tiers per MCP server:
//   - eager      : each session starts its own connection and registers native `mcp__<server>__<tool>` tools
//   - on-demand  : no connection until that session calls `mcp_load`; `mcp_call` uses the session instance
//   - disabled   : registered but hidden
//
// Model-facing tools: mcp_register / mcp_load / mcp_call.
// A pre-step `mcp-catalog` injects the visible server summary (append-only, digest-driven).

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { stringify, parse } from "yaml";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { registerRecursiveSkillProvider, setDisableModelInvocation } from "./skill.js";
import { mountUi, entryView, openWithSystemEditor, trashDirectory } from "./ui.js";

const name = "skill-mcp-manager";
const inject = ["tools", "skills"];
const PLUGIN_VERSION = "0.1.0";

const TIERS = new Set(["eager", "on-demand", "disabled"]);
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
// Managed MCP shadow/takeover block in the profile's cordis.patch.yml.
// reconcile / prepare-uninstall replace only the span between these markers.
const MANAGED_MARKER = "# ── Managed MCP servers (dsh-skill-mcp-manager, disabled shadow entries) ──";
const MANAGED_END_MARKER = "# ── End managed MCP servers (dsh-skill-mcp-manager) ──";
// Begin of the block after prepare-uninstall hands entries back to native.
const HANDOVER_MARKER = "# ── Handed back to native dsh-mcp-client (was managed by dsh-skill-mcp-manager) ──";
// DeepSeek function-name contract: 64 chars, [A-Za-z0-9_-].
const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");

const Config = z.object({
  dataDir: z.string().default(""),
  profile: z.string().default("web"),
  trialTimeoutMs: z.number().default(30000),
  toolCallTimeoutMs: z.number().default(60000),
  catalogDescriptionMaxLength: z.number().default(500),
  toolDescriptionMaxLength: z.number().default(150),
  importNativeMcp: z.boolean().default(true),
});

// ── storage ────────────────────────────────────────────────────────────────

function resolveDataDir(config) {
  const raw = config.dataDir && config.dataDir.trim() !== "" ? config.dataDir : join(DSH_HOME, "skill-mcp-manager");
  return raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
}

// The profile this host process actually booted (`--profile <name>` on the
// dsh CLI invocation), so a bundle-installed plugin manages the profile it
// lives in without a hand-written config row.
function argvProfile() {
  const argv = process.argv;
  const flag = argv.indexOf("--profile");
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith("-")) return argv[flag + 1];
  return undefined;
}

function resolveProfile(config) {
  return config.profile && config.profile !== "" ? config.profile : argvProfile() ?? "web";
}

function emptyRegistry() {
  return { version: 1, entries: [] };
}

async function loadRegistry(dataDir) {
  try {
    const text = await readFile(join(dataDir, "registry.json"), "utf8");
    const data = JSON.parse(text);
    if (data === null || typeof data !== "object" || !Array.isArray(data.entries)) {
      throw new Error("registry.json has an invalid shape (expected { version, entries })");
    }
    return data;
  } catch (error) {
    if (error && error.code === "ENOENT") return emptyRegistry();
    throw error;
  }
}

async function saveRegistry(dataDir, registry) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, "registry.json");
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

async function loadSettings(dataDir) {
  try {
    const text = await readFile(join(dataDir, "settings.json"), "utf8");
    const data = JSON.parse(text);
    if (data === null || typeof data !== "object" || Array.isArray(data)) return {};
    return data;
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function saveSettings(dataDir, settings) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, "settings.json");
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

// ── native MCP import / takeover ──────────────────────────────────────────

// Parse a patch section (the text before the managed marker) for native
// @deepseek-ai/dsh-mcp-client insert rows. A native section that does not
// parse (e.g. it uses an unknown YAML tag) yields [] so the plugin never
// corrupts it — native entries are simply left untouched.
function parseNativeMcpEntries(nativeText) {
  const found = [];
  try {
    const docs = parse(nativeText);
    if (!Array.isArray(docs)) return found;
    for (const block of docs) {
      if (block === null || typeof block !== "object" || !Array.isArray(block.insert)) continue;
      for (const entry of block.insert) {
        if (entry !== null && typeof entry === "object" && entry.name === "@deepseek-ai/dsh-mcp-client") {
          found.push(entry);
        }
      }
    }
  } catch {
    /* leave native entries untouched */
  }
  return found;
}

function indexAfterLine(text, index) {
  const newline = text.indexOf("\n", index);
  return newline < 0 ? text.length : newline + 1;
}

// Top-level `- …` blocks in a patch-array slice. Comments and blank lines
// that are not attached to a block are ignored (the managed span's comments
// are generated by this plugin).
function splitTopLevelPatchEntries(text) {
  const entries = [];
  const lines = text.split(/\r?\n/);
  let buf = [];
  const flush = () => {
    while (buf.length > 0 && buf[buf.length - 1] === "") buf.pop();
    if (buf.length === 0) return;
    entries.push(buf.join("\n"));
    buf = [];
  };
  for (const line of lines) {
    if (line.startsWith("- ")) {
      flush();
      buf.push(line);
    } else if (buf.length > 0) {
      buf.push(line);
    }
  }
  flush();
  return entries;
}

// Ours: a shadow `- insert:` of dsh-mcp-client rows, or a takeover row that
// is only `{ id, disabled: true }`. Anything else (oauth, other plugins,
// mixed inserts) is not rewritten.
function isManagedPatchEntry(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const keys = Object.keys(entry);
  if (
    typeof entry.id === "string" &&
    entry.id !== "" &&
    entry.disabled === true &&
    keys.length === 2 &&
    keys.includes("id") &&
    keys.includes("disabled")
  ) {
    return true;
  }
  if (!Array.isArray(entry.insert) || entry.insert.length === 0) return false;
  if (typeof entry.id === "string" && entry.id !== "") return false;
  return entry.insert.every(
    (item) => item !== null && typeof item === "object" && item.name === "@deepseek-ai/dsh-mcp-client",
  );
}

function extractUnrecognizedMiddle(middleText) {
  const kept = [];
  for (const block of splitTopLevelPatchEntries(middleText)) {
    let parsed;
    try {
      parsed = parse(block);
    } catch {
      kept.push(block);
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (items.length > 0 && items.every(isManagedPatchEntry)) continue;
    kept.push(block);
  }
  return kept.join("\n");
}

function splitPatchAroundManaged(text) {
  const start = text.indexOf(MANAGED_MARKER);
  if (start < 0) {
    return { prefix: text, middle: "", relocated: "", suffix: "" };
  }
  const afterStart = indexAfterLine(text, start);
  const end = text.indexOf(MANAGED_END_MARKER, afterStart);
  let middle;
  let suffix;
  if (end >= 0) {
    middle = text.slice(afterStart, end);
    suffix = text.slice(indexAfterLine(text, end));
  } else {
    middle = text.slice(afterStart);
    suffix = "";
  }
  return {
    prefix: text.slice(0, start),
    middle,
    relocated: extractUnrecognizedMiddle(middle),
    suffix,
  };
}

function stitchPatch(prefix, block, relocated, suffix) {
  const extras = [];
  if (block && block.trim() !== "") extras.push(block.replace(/^\n+/, "").trimEnd());
  if (relocated && relocated.trim() !== "") extras.push(relocated.replace(/^\n+/, "").trimEnd());
  let next = prefix.trimEnd();
  if (extras.length > 0) next += `\n\n${extras.join("\n\n")}\n`;
  else next += "\n";
  if (suffix) {
    next += suffix;
    if (!next.endsWith("\n")) next += "\n";
  }
  return next;
}

// ── full-merge takeover helpers ────────────────────────────────────────────

// Top-level `- …` blocks in a patch-array slice, with their line spans so the
// caller can excise whole blocks. Comments and blank lines that are not
// attached to a block are ignored.
function splitTopLevelPatchEntriesWithRanges(text) {
  const lines = text.split(/\r?\n/);
  const lineOffsets = [];
  let acc = 0;
  for (const line of lines) {
    lineOffsets.push(acc);
    acc += line.length + 1;
  }
  const entries = [];
  let buf = [];
  let startLine = -1;
  const flush = () => {
    while (buf.length > 0 && buf[buf.length - 1] === "") buf.pop();
    if (buf.length === 0) return;
    const startOffset = lineOffsets[startLine];
    const endLine = startLine + buf.length;
    entries.push({
      text: buf.join("\n"),
      startLine,
      lineCount: buf.length,
      startOffset,
      endOffset: lineOffsets[Math.min(endLine, lineOffsets.length - 1)] + (endLine >= lineOffsets.length ? lines[lines.length - 1].length : 0),
    });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("- ")) {
      flush();
      startLine = i;
      buf.push(lines[i]);
    } else if (buf.length > 0) {
      buf.push(lines[i]);
    }
  }
  flush();
  return { entries, lineOffsets, lineCount: lines.length };
}

// Segment the rows of one `- insert:` entry into line spans. Row starts are
// `- ` lines at the sequence's own indent; deeper-indented lines (args lists,
// nested maps) belong to the current row. Returns null when the structure is
// not recognizable — the caller then leaves the entry untouched.
function segmentInsertRows(entryText) {
  const lines = entryText.split(/\r?\n/);
  let seqIndent = null;
  const rows = [];
  let current = null;
  for (let i = 1; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)- /);
    if (match !== null) {
      const indent = match[1].length;
      if (seqIndent === null) seqIndent = indent;
      if (indent === seqIndent) {
        if (current !== null) rows.push(current);
        current = { relStart: i, relEnd: lines.length };
        continue;
      }
    }
  }
  if (current !== null) rows.push(current);
  if (seqIndent === null) return null;
  // close each row at the next row start
  for (let i = 0; i < rows.length; i++) {
    rows[i].relEnd = i + 1 < rows.length ? rows[i + 1].relStart : lines.length;
  }
  return rows;
}

// Remove every @deepseek-ai/dsh-mcp-client insert row that lives OUTSIDE the
// managed span and is claimed by a registry entry (row id ∈ claimedIds) —
// after a merge those rows exist only inside the managed block, and a
// leftover copy outside would collide on the loader entry id. Rows the
// registry does not claim (importNativeMcp: false, foreign rows) stay
// untouched. Whole `- insert:` blocks that become empty are removed;
// comments trailing an entry are kept.
function removeOutsideMcpRows(text, managedStartOffset, managedEndOffset, claimedIds) {
  const { entries, lineOffsets, lineCount } = splitTopLevelPatchEntriesWithRanges(text);
  const cuts = [];
  for (const entry of entries) {
    // A negative managedStartOffset means the file has no managed span yet —
    // every row is then outside and subject to excision.
    if (managedStartOffset >= 0 && entry.startOffset >= managedStartOffset && entry.startOffset < managedEndOffset) continue;
    let parsed;
    try {
      parsed = parse(entry.text);
    } catch {
      continue;
    }
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    if (blocks.length !== 1 || blocks[0] === null || typeof blocks[0] !== "object") continue;
    const insert = blocks[0].insert;
    if (!Array.isArray(insert) || insert.length === 0) continue;
    const dshIndexes = [];
    const claimedIndexes = [];
    insert.forEach((row, index) => {
      if (row === null || typeof row !== "object" || row.name !== "@deepseek-ai/dsh-mcp-client") return;
      dshIndexes.push(index);
      if (typeof row.id === "string" && claimedIds.has(row.id)) claimedIndexes.push(index);
    });
    if (claimedIndexes.length === 0) continue;
    if (claimedIndexes.length === dshIndexes.length && dshIndexes.length === insert.length) {
      // Whole entry goes; keep trailing comment lines attached after it.
      let endOffset = entry.endOffset;
      const entryLines = entry.text.split(/\r?\n/);
      while (entryLines.length > 0) {
        const last = entryLines[entryLines.length - 1].trim();
        if (last === "" || last.startsWith("#")) {
          entryLines.pop();
          endOffset = lineOffsets[entry.startLine + entryLines.length] ?? endOffset;
        } else break;
      }
      cuts.push([entry.startOffset, endOffset]);
      continue;
    }
    const rows = segmentInsertRows(entry.text);
    if (rows === null || rows.length !== insert.length) continue;
    const entryLines = entry.text.split(/\r?\n/);
    const relOffsets = [];
    let relAcc = 0;
    for (const line of entryLines) {
      relOffsets.push(relAcc);
      relAcc += line.length + 1;
    }
    for (const index of claimedIndexes) {
      const row = rows[index];
      const start = entry.startOffset + relOffsets[row.relStart];
      const lastLine = Math.min(row.relEnd, entryLines.length - 1);
      const end = entry.startOffset + relOffsets[lastLine] + (entryLines[lastLine]?.length ?? 0) + 1;
      cuts.push([start, Math.min(end, text.length)]);
    }
  }
  let next = text;
  for (const [start, end] of cuts.sort((a, b) => b[0] - a[0])) {
    next = next.slice(0, start) + next.slice(Math.min(end, next.length));
  }
  return next;
}

// Build a registry entry from a native dsh-mcp-client insert row.
// `rawConfig` keeps the row's original config verbatim (including fields the
// registry does not model) until the user edits the entry through
// mcp_register, which rebuilds the entry and drops it.
function nativeEntryToRegistryEntry(native, tier) {
  const cfg = native.config ?? {};
  const name = cfg.serverName;
  const now = new Date().toISOString();
  return {
    id: name,
    name,
    tier,
    transport: cfg.transport,
    command: cfg.command ?? null,
    args: cfg.args ?? [],
    env: cfg.env ?? {},
    cwd: cfg.cwd ?? null,
    url: cfg.url ?? null,
    headers: cfg.headers ?? {},
    notes: "",
    systemEntryId: typeof native.id === "string" ? native.id : `mcp-${name}`,
    managed: true,
    registeredAt: now,
    lastLoadAt: null,
    lastSyncAt: now,
    tools: [],
    disabledTools: [],
    serverName: "",
    serverVersion: "",
    serverTitle: "",
    serverDescription: "",
    websiteUrl: "",
    instructions: "",
    capabilities: null,
    metaFetchedAt: null,
    rawConfig: { ...cfg },
  };
}

// ── MCP client ─────────────────────────────────────────────────────────────

function buildTransport(entry) {
  switch (entry.transport) {
    case "stdio":
      return new StdioClientTransport({
        command: entry.command,
        args: entry.args ?? [],
        env: { ...process.env, ...(entry.env ?? {}) },
        cwd: entry.cwd || undefined,
      });
    case "streamable-http":
      return new StreamableHTTPClientTransport(new URL(entry.url), {
        requestInit: { headers: entry.headers ?? {} },
      });
    default:
      throw new Error(`unsupported transport "${entry.transport}"`);
  }
}

async function connectEntry(entry, timeoutMs) {
  const client = new Client({ name, version: PLUGIN_VERSION });
  const transport = buildTransport(entry);
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`connection to "${entry.name}" timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    await Promise.race([client.connect(transport), timeout]);
    const tools = await listTools(client);
    // Server-declared metadata from the initialize handshake (the newer spec
    // adds name/version/title/description/websiteUrl to serverInfo, plus a
    // top-level instructions string and a capabilities object). Empty when the
    // server omits them.
    const serverInfo = client.getServerVersion();
    const instructions = client.getInstructions();
    const capabilities = client.getServerCapabilities();
    return { client, transport, tools, serverInfo, instructions, capabilities };
  } catch (error) {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function listTools(client) {
  const tools = [];
  let cursor;
  do {
    const response = await client.request(
      { method: "tools/list", ...(cursor === undefined ? {} : { params: { cursor } }) },
      ListToolsResultSchema,
    );
    tools.push(...response.tools);
    cursor = response.nextCursor;
  } while (cursor);
  return tools;
}

const MAX_ERROR_CONTEXT_CHARS = 2000;

function clipJson(value) {
  const text = JSON.stringify(value ?? null);
  if (text.length <= MAX_ERROR_CONTEXT_CHARS) return text;
  return `${text.slice(0, MAX_ERROR_CONTEXT_CHARS)}…(truncated, ${text.length} chars total)`;
}

// Protocol/transport-level tool-call failures (-32602, -32603, timeouts, …) are
// opaque to the model on their own. When errorInfo is provided, append the call
// context (server/tool, arguments sent, tool inputSchema) so the model can see
// what it sent and self-correct instead of guessing.
async function callTool(client, rawName, args, timeoutMs, signal, errorInfo) {
  const safeArgs = args && typeof args === "object" ? args : {};
  try {
    return await client.request(
      { method: "tools/call", params: { name: rawName, arguments: safeArgs } },
      CallToolResultSchema,
      { signal, timeout: timeoutMs },
    );
  } catch (err) {
    if (errorInfo === undefined) throw err;
    const lines = [
      err instanceof Error ? err.message : String(err),
      `called MCP tool: ${errorInfo.server}/${rawName}`,
      `arguments sent: ${clipJson(safeArgs)}`,
    ];
    if (errorInfo.inputSchema !== undefined) {
      lines.push(`tool inputSchema: ${clipJson(errorInfo.inputSchema)}`);
    }
    throw new Error(lines.join("\n"));
  }
}

// isError tool results are normal responses (server-side business failures,
// e.g. "unknown tool", bad parameters), not protocol rejects — attach the same
// call context so the model can see what it sent and self-correct.
function isErrorContextSuffix(errorInfo, rawName, args) {
  if (errorInfo === undefined) return "";
  return `\ncalled MCP tool: ${errorInfo.server}/${rawName}\narguments sent: ${clipJson(args && typeof args === "object" ? args : {})}`;
}

function extractText(result) {
  if (!result || !Array.isArray(result.content)) return typeof result === "string" ? result : JSON.stringify(result);
  const parts = [];
  for (const block of result.content) {
    if (typeof block !== "object" || block === null) {
      parts.push("[unsupported content]");
      continue;
    }
    switch (block.type) {
      case "text":
        if (block.text !== undefined) parts.push(block.text);
        break;
      case "image":
        parts.push(`[image: ${block.mimeType ?? "unknown"}, content discarded]`);
        break;
      case "audio":
        parts.push(`[audio: ${block.mimeType ?? "unknown"}, content discarded]`);
        break;
      case "resource":
      case "resource_link":
        parts.push("[resource: content discarded]");
        break;
      default:
        parts.push(`[${block.type} content]`);
    }
  }
  return parts.join("\n");
}

// ── naming / validation ────────────────────────────────────────────────────

function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, "_");
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash("sha256").update(`${serverName}\0${rawName}`).digest("hex").slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

function assertServerName(value) {
  if (typeof value !== "string" || !SERVER_NAME_PATTERN.test(value)) {
    throw new Error(`invalid MCP name "${value}" (must match [A-Za-z0-9_-]{1,32})`);
  }
}

function truncate(value, maxLength) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function disabledToolNames(entry) {
  return new Set(Array.isArray(entry?.disabledTools) ? entry.disabledTools.filter((value) => typeof value === "string") : []);
}

function isToolDisabled(entry, toolName) {
  return disabledToolNames(entry).has(toolName);
}

function enabledTools(entry, tools) {
  const disabled = disabledToolNames(entry);
  return (tools ?? []).filter((tool) => !disabled.has(tool.name));
}

// ── entry construction ─────────────────────────────────────────────────────

function buildEntry(args, existing, tools) {
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? args.name,
    name: args.name,
    tier: args.tier ?? existing?.tier ?? "on-demand",
    transport: args.transport ?? existing?.transport,
    command: args.command ?? existing?.command ?? null,
    args: args.args ?? existing?.args ?? [],
    env: args.env ?? existing?.env ?? {},
    cwd: args.cwd ?? existing?.cwd ?? null,
    url: args.url ?? existing?.url ?? null,
    headers: args.headers ?? existing?.headers ?? {},
    notes: args.notes ?? existing?.notes ?? "",
    systemEntryId: `mcp-${args.name}`,
    managed: true,
    registeredAt: existing?.registeredAt ?? now,
    lastLoadAt: existing?.lastLoadAt ?? null,
    lastSyncAt: now,
    tools: tools ?? existing?.tools ?? [],
    disabledTools: existing?.disabledTools ?? [],
    serverName: existing?.serverName ?? "",
    serverVersion: existing?.serverVersion ?? "",
    serverTitle: existing?.serverTitle ?? "",
    serverDescription: existing?.serverDescription ?? "",
    websiteUrl: existing?.websiteUrl ?? "",
    instructions: existing?.instructions ?? "",
    capabilities: existing?.capabilities ?? null,
    metaFetchedAt: existing?.metaFetchedAt ?? null,
  };
}

// ── model-facing output (uniform { text }) ─────────────────────────────────

const TEXT_OUTPUT = {
  schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: "text", text: value.text }],
};

// ── apply ──────────────────────────────────────────────────────────────────

async function apply(ctx, config = {}) {
  const dataDir = resolveDataDir(config);
  const trialTimeoutMs = config.trialTimeoutMs ?? 30000;
  const toolCallTimeoutMs = config.toolCallTimeoutMs ?? 60000;
  const catalogDescriptionMaxLength = config.catalogDescriptionMaxLength ?? 500;
  let toolDescriptionMaxLength = config.toolDescriptionMaxLength ?? 150;

  // Live runtime state: one MCP instance set per DSH agent/session.
  const liveSessions = new Set();
  let registry = emptyRegistry();

  async function snapshotTools(client) {
    // Keep the server-declared inputSchema in snapshots: mcp_load renders it so
    // the model can see parameter structure before calling, and registry.json
    // persists it for peek/UI. Stripping it here silently starves the renderer.
    return (await listTools(client)).map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }));
  }

  // Copy server-declared metadata (from the initialize handshake) onto the
  // entry. These are read-only and refresh only when we reconnect — they are
  // never overwritten by a user note or an mcp_register edit.
  function applyServerMetadata(entry, connection) {
    entry.metaFetchedAt = new Date().toISOString();
    const info = connection?.serverInfo;
    if (info && typeof info === "object") {
      if (typeof info.name === "string" && info.name !== "") entry.serverName = info.name;
      if (typeof info.version === "string" && info.version !== "") entry.serverVersion = info.version;
      if (typeof info.title === "string" && info.title !== "") entry.serverTitle = info.title;
      if (typeof info.description === "string" && info.description !== "") entry.serverDescription = info.description;
      if (typeof info.websiteUrl === "string" && info.websiteUrl !== "") entry.websiteUrl = info.websiteUrl;
    }
    if (typeof connection?.instructions === "string" && connection.instructions !== "") {
      entry.instructions = connection.instructions;
    }
    if (connection?.capabilities && typeof connection.capabilities === "object") {
      entry.capabilities = connection.capabilities;
    }
  }

  function sessionOf(agent) {
    if (agent === undefined || agent === null) throw new Error("MCP session runtime requires an agent");
    for (const session of liveSessions) {
      if (session.agent === agent) return session;
    }
    const session = {
      agent,
      connections: new Map(),
      nativeDisposers: new Map(),
    };
    liveSessions.add(session);
    const agentCtx = agent.ctx;
    if (agentCtx !== undefined && typeof agentCtx.effect === "function") {
      agentCtx.effect(() => async () => {
        liveSessions.delete(session);
        await disposeSession(session);
      });
    }
    return session;
  }

  function toolHost(session) {
    return session.agent?.ctx?.tools ?? ctx.tools;
  }

  async function ensureConnected(session, entry) {
    const existing = session.connections.get(entry.name);
    if (existing !== undefined) return existing;
    const connection = await connectEntry(entry, trialTimeoutMs);
    session.connections.set(entry.name, connection);
    applyServerMetadata(entry, connection);
    return connection;
  }

  async function ensureEager(session, entry) {
    const connection = await ensureConnected(session, entry);
    entry.tools = connection.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }));
    const previous = session.nativeDisposers.get(entry.name);
    if (previous !== undefined) for (const dispose of previous.values()) dispose();
    const disposers = new Map();
    const host = toolHost(session);
    for (const tool of enabledTools(entry, connection.tools)) {
      const publicName = publicToolName(entry.name, tool.name);
      disposers.set(publicName, host.register({
        name: publicName,
        description: tool.description ?? "",
        parameters: tool.inputSchema ?? { type: "object" },
        output: TEXT_OUTPUT,
        async execute(args, exec) {
          if (isToolDisabled(entry, tool.name)) throw new Error(`MCP tool "${entry.name}/${tool.name}" is disabled`);
          const live = session.connections.get(entry.name) ?? connection;
          const errorContext = { server: entry.name, inputSchema: tool.inputSchema };
          const result = await callTool(live.client, tool.name, args, toolCallTimeoutMs, exec.signal, errorContext);
          if (result.isError) throw new Error(extractText(result) + isErrorContextSuffix(errorContext, tool.name, args));
          return { text: extractText(result) };
        },
      }));
    }
    session.nativeDisposers.set(entry.name, disposers);
    return disposers.size;
  }

  async function disposeSessionEntry(session, entryName) {
    const connection = session.connections.get(entryName);
    session.connections.delete(entryName);
    const disposers = session.nativeDisposers.get(entryName);
    session.nativeDisposers.delete(entryName);
    if (disposers !== undefined) for (const dispose of disposers.values()) dispose();
    if (connection !== undefined) {
      try {
        await connection.client.close();
      } catch {
        /* ignore */
      }
    }
  }

  async function disposeSession(session) {
    const names = new Set([...session.connections.keys(), ...session.nativeDisposers.keys()]);
    for (const entryName of names) await disposeSessionEntry(session, entryName);
  }

  async function disposeNamedEverywhere(entryName) {
    for (const session of [...liveSessions]) await disposeSessionEntry(session, entryName);
  }

  async function syncEagerEverywhere(entry) {
    for (const session of [...liveSessions]) {
      try {
        await ensureEager(session, entry);
      } catch (error) {
        ctx.logger.error(`skill-mcp-manager: failed to start eager MCP "${entry.name}" for a session: ${String(error?.message ?? error)}`);
      }
    }
  }

  async function ensureSessionRuntime(agent) {
    if (agent === undefined || agent === null) return;
    const session = sessionOf(agent);
    for (const entry of registry.entries) {
      if (entry.tier === "eager") {
        try {
          await ensureEager(session, entry);
        } catch (error) {
          ctx.logger.error(`skill-mcp-manager: failed to start eager MCP "${entry.name}": ${String(error?.message ?? error)}`);
        }
      } else if (entry.tier === "disabled") {
        await disposeSessionEntry(session, entry.name);
      }
    }
  }

  // System-config reconcile (M2): write a `disabled: true` shadow entry per
  // active (non-disabled) registry entry into the profile's cordis.patch.yml,
  // so config survives a plugin uninstall as a static dsh-mcp-client fallback.
  function shadowConfig(entry) {
    const config = { serverName: entry.name, toolCallTimeoutMs: 120000 };
    if (entry.transport === "stdio") {
      config.transport = "stdio";
      config.command = entry.command;
      if (Array.isArray(entry.args) && entry.args.length > 0) config.args = entry.args;
      if (entry.env !== undefined && entry.env !== null && Object.keys(entry.env).length > 0) config.env = entry.env;
      if (entry.cwd) config.cwd = entry.cwd;
    } else if (entry.transport === "streamable-http") {
      config.transport = "streamable-http";
      config.url = entry.url;
      if (entry.headers !== undefined && entry.headers !== null && Object.keys(entry.headers).length > 0) config.headers = entry.headers;
    } else {
      return null;
    }
    return config;
  }

  // Regenerate the managed block from the registry: exactly one disabled row
  // per entry. Config comes from the adopted raw config (serverName kept
  // aligned with the entry's current name) or is synthesized for
  // registry-born entries. A duplicate loader id can never be written —
  // refuse loudly instead of producing a patch that breaks the next boot.
  function entryRowConfig(entry) {
    if (entry.rawConfig && typeof entry.rawConfig === "object") {
      return { ...entry.rawConfig, serverName: entry.name };
    }
    return shadowConfig(entry);
  }

  function entryRowId(entry) {
    return typeof entry.systemEntryId === "string" && entry.systemEntryId !== ""
      ? entry.systemEntryId
      : `mcp-${entry.name}`;
  }

  function managedBlockYaml() {
    const rows = [];
    const seen = new Set();
    for (const entry of registry.entries) {
      const id = entryRowId(entry);
      if (seen.has(id)) {
        throw new Error(`managed MCP rows would duplicate loader id "${id}" — refusing to write the patch`);
      }
      seen.add(id);
      const config = entryRowConfig(entry);
      if (config === null) continue;
      rows.push({ id, name: "@deepseek-ai/dsh-mcp-client", config, disabled: true });
    }
    const parts = [MANAGED_MARKER];
    if (rows.length > 0) parts.push(stringify([{ insert: rows }]));
    parts.push(MANAGED_END_MARKER);
    return `${parts.join("\n")}\n`;
  }

  // prepare-uninstall: hand every entry back to the native dsh-mcp-client as
  // an insert row (enabled, except disabled-tier entries keep their disabled
  // flag so the user's off choice survives the handover).
  function handoverBlockYaml() {
    const rows = [];
    for (const entry of registry.entries) {
      const config = entryRowConfig(entry);
      if (config === null) continue;
      const row = { id: entryRowId(entry), name: "@deepseek-ai/dsh-mcp-client", config };
      if (entry.tier === "disabled") row.disabled = true;
      rows.push(row);
    }
    if (rows.length === 0) return "";
    return `${HANDOVER_MARKER}\n${stringify([{ insert: rows }])}`;
  }

  // Absorb + full-merge reconcile:
  //   1. Scan the WHOLE patch file (managed span included) for
  //      @deepseek-ai/dsh-mcp-client insert rows and adopt the ones no
  //      registry entry claims by row id (systemEntryId) — hand-added rows
  //      anywhere are absorbed once; renamed entries are never re-imported.
  //   2. Regenerate the managed span from the registry: exactly one disabled
  //      row per entry. A duplicate loader id aborts the write (self-check).
  //   3. Remove every dsh-mcp-client row outside the managed span — the rows
  //      moved into the block must not survive as stray copies.
  // Returns the number of newly adopted entries.
  async function reconcile() {
    const patchPath = join(DSH_HOME, "profiles", resolveProfile(config), "cordis.patch.yml");
    let current;
    try {
      current = await readFile(patchPath, "utf8");
    } catch {
      ctx.logger.warn(`skill-mcp-manager: cannot read ${patchPath}; reconcile skipped`);
      return 0;
    }
    const { prefix, middle, suffix } = splitPatchAroundManaged(current);
    const claimedIds = new Set(registry.entries.map((entry) => entryRowId(entry)));
    let imported = 0;
    const absorb = (text) => {
      if (config.importNativeMcp === false) return;
      for (const row of parseNativeMcpEntries(text)) {
        const rowId = typeof row.id === "string" && row.id !== "" ? row.id : null;
        if (rowId !== null && claimedIds.has(rowId)) continue;
        const serverName = row.config?.serverName;
        if (typeof serverName !== "string" || serverName === "") continue;
        if (registry.entries.some((entry) => entry.name === serverName)) continue;
        registry.entries.push(nativeEntryToRegistryEntry(row, row.disabled === true ? "disabled" : "on-demand"));
        if (rowId !== null) claimedIds.add(rowId);
        imported += 1;
      }
    };
    absorb(prefix);
    absorb(middle);
    absorb(suffix);

    let block;
    try {
      block = managedBlockYaml();
    } catch (error) {
      ctx.logger.error(`skill-mcp-manager: ${String(error?.message ?? error)}`);
      if (imported > 0) await saveRegistry(dataDir, registry);
      return imported;
    }

    const managedStart = current.indexOf(MANAGED_MARKER);
    const endMarkerIndex = managedStart < 0 ? -1 : current.indexOf(MANAGED_END_MARKER, managedStart);
    const managedEnd = managedStart < 0 || endMarkerIndex < 0 ? current.length : indexAfterLine(current, endMarkerIndex);
    const stripped = removeOutsideMcpRows(current, managedStart, managedEnd, claimedIds);
    const parts = splitPatchAroundManaged(stripped);
    const next = stitchPatch(parts.prefix, block, parts.relocated, parts.suffix);
    if (next !== current || imported > 0) {
      if (next !== current) {
        await writeFile(`${patchPath}.bak-${Date.now()}`, current, "utf8");
        await writeFile(patchPath, next, "utf8");
        ctx.logger.info(`skill-mcp-manager: reconciled ${patchPath} (scope: ${resolveProfile(config)})`);
      }
      if (imported > 0) await saveRegistry(dataDir, registry);
    }
    return imported;
  }

  // Warm up imported entries that have no cached snapshot: connect + listTools
  // once (concurrent) so the catalog and the capability-library UI show real
  // tool names from the first session onward. Uses the trial-connection timeout
  // (30s) because the stdio python servers can take 10-30s to boot; a failure
  // is non-fatal — the entry stays empty and can still be loaded via mcp_load.
  async function warmSnapshots() {
    let changed = false;
    const missing = registry.entries.filter(
      (entry) => entry.tier !== "disabled" && (
        !Array.isArray(entry.tools) || entry.tools.length === 0 ||
        entry.metaFetchedAt === undefined || entry.metaFetchedAt === null
      ),
    );
    await Promise.all(missing.map(async (entry) => {
      try {
        const connection = await connectEntry(entry, trialTimeoutMs);
        try {
          entry.tools = await snapshotTools(connection.client);
          entry.lastLoadAt = new Date().toISOString();
          applyServerMetadata(entry, connection);
          changed = true;
        } finally {
          await connection.client.close();
        }
      } catch (error) {
        ctx.logger.warn(`skill-mcp-manager: warm-up snapshot for "${entry.name}" failed: ${String(error?.message ?? error)}`);
      }
    }));
    if (changed) await saveRegistry(dataDir, registry);
  }

  // prepare-uninstall: flip managed shadow entries `disabled: true -> absent`
  // (enabled), handing them back to the native dsh-mcp-client so they survive
  // uninstalling this plugin. Also dispose eager native registrations first to
  // avoid a transient double registration when the patch hot-reloads.
  async function prepareUninstall() {
    const patchPath = join(DSH_HOME, "profiles", resolveProfile(config), "cordis.patch.yml");
    let current;
    try {
      current = await readFile(patchPath, "utf8");
    } catch {
      return { kind: "error", text: `cannot read ${patchPath}` };
    }
    const { prefix, relocated, suffix } = splitPatchAroundManaged(current);
    if (!current.includes(MANAGED_MARKER)) {
      return { kind: "success", text: "No managed MCP block found — nothing to hand back." };
    }
    const count = registry.entries.filter((entry) => entry.tier !== "disabled").length;
    const block = handoverBlockYaml();
    const next = stitchPatch(prefix, block, relocated, suffix);
    if (next !== current) {
      await writeFile(`${patchPath}.bak-${Date.now()}`, current, "utf8");
      await writeFile(patchPath, next, "utf8");
    }
    for (const entry of registry.entries) {
      if (entry.tier === "eager") await disposeNamedEverywhere(entry.name);
    }
    return {
      kind: "success",
      text: `Handed ${count} MCP entry/entries back to native dsh-mcp-client. Now remove the skill-mcp-manager entry from cordis.patch.yml to finish uninstalling.`,
    };
  }

  // ── mcp_register ──
  const mcpRegister = {
    name: "mcp_register",
    description:
      "Register (add) or modify an MCP server entry. Validates by trial-connecting (30s) and listing tools, then persists to the registry. The server's own description/version/title/website/instructions are captured automatically from the server during the trial connection. Reuse it to change tier/parameters/notes. Only connection-contract changes re-connect; changing notes or downgrading to disabled skips the trial connection.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Stable server name ([A-Za-z0-9_-]{1,32}); the model-facing namespace." },
        tier: { type: "string", enum: ["eager", "on-demand", "disabled"], description: "Default on-demand." },
        transport: { type: "string", enum: ["stdio", "streamable-http"], description: "Required on add." },
        command: { type: "string", description: "stdio: executable to spawn." },
        args: { type: "array", items: { type: "string" }, description: "stdio: argument array (no shell)." },
        env: { type: "object", description: "stdio: extra env; value may be a literal or a $VAR reference." },
        cwd: { type: "string", description: "stdio: working directory." },
        url: { type: "string", description: "streamable-http: server URL." },
        headers: { type: "object", description: "streamable-http: extra headers." },
        notes: { type: "string", description: "Optional USER-maintained note (never overwritten by developer/server updates); surfaced in the on-demand catalog." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      assertServerName(args.name);
      const tier = args.tier ?? "on-demand";
      if (!TIERS.has(tier)) throw new Error(`invalid tier "${tier}"`);

      const existingIndex = registry.entries.findIndex((e) => e.name === args.name);
      const existing = existingIndex >= 0 ? registry.entries[existingIndex] : undefined;
      const isUpdate = existing !== undefined;
      const transport = args.transport ?? existing?.transport;
      if (transport === undefined) throw new Error("`transport` is required when registering a new MCP server");
      if (transport === "stdio" && !args.command && !existing?.command) throw new Error("stdio transport requires `command`");
      if (transport === "streamable-http" && !args.url && !existing?.url) throw new Error("streamable-http transport requires `url`");

      // Trial-connect only when the connection contract changes or the tier becomes eager.
      const needsTrial =
        tier === "eager" ||
        args.transport !== undefined ||
        args.command !== undefined ||
        args.url !== undefined ||
        args.env !== undefined ||
        args.headers !== undefined ||
        args.args !== undefined ||
        args.cwd !== undefined;

      let snapshot = existing?.tools ?? [];
      let trialMeta = null;
      if (needsTrial) {
        const candidate = buildEntry(args, existing);
        const connection = await connectEntry(candidate, trialTimeoutMs);
        try {
          snapshot = await snapshotTools(connection.client);
          trialMeta = connection;
        } finally {
          await connection.client.close();
        }
      }

      const entry = buildEntry(args, existing, snapshot);
      if (trialMeta !== null) applyServerMetadata(entry, trialMeta);
      if (isUpdate) registry.entries[existingIndex] = entry;
      else registry.entries.push(entry);
      await saveRegistry(dataDir, registry);

      if (tier === "eager") {
        await syncEagerEverywhere(entry);
        await reconcile();
        return { text: `MCP "${entry.name}" ${isUpdate ? "updated" : "registered"} as eager — live sessions will register native tools.` };
      }
      if (isUpdate && existing.tier === "eager") await disposeNamedEverywhere(entry.name);
      await reconcile();
      return { text: `MCP "${entry.name}" ${isUpdate ? "updated" : "registered"} (tier=${entry.tier}, ${snapshot.length} tool(s)).` };
    },
  };

  // ── mcp_load ──
  const mcpLoad = {
    name: "mcp_load",
    description:
      "Load (or hot-reload) one non-disabled MCP server for the current session and return its full tool definitions (names, descriptions, parameter schemas) as this tool's result. With peek=true it only reads the latest snapshot or this session's active connection without connecting, registering, or dropping a live connection.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Registered MCP server name." },
        peek: { type: "boolean", description: "Default false. true = only inspect, never connect or reload." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const entry = registry.entries.find((e) => e.name === args.name);
      if (entry === undefined) throw new Error(`MCP "${args.name}" is not registered`);
      if (entry.tier === "disabled") throw new Error(`MCP "${args.name}" is disabled`);

      if (args.peek === true) {
        const session = exec?.agent === undefined ? undefined : sessionOf(exec.agent);
        const tools = session?.connections.get(entry.name)?.tools ?? entry.tools ?? [];
        return { text: renderDefinitions(entry, tools) };
      }

      if (exec?.agent === undefined) throw new Error("mcp_load requires a session");
      const session = sessionOf(exec.agent);
      await disposeSessionEntry(session, entry.name);
      const connection = await ensureConnected(session, entry);
      entry.tools = await snapshotTools(connection.client);
      entry.lastLoadAt = new Date().toISOString();
      await saveRegistry(dataDir, registry);

      if (entry.tier === "eager") {
        const toolCount = await ensureEager(session, entry);
        return { text: `MCP "${entry.name}" reloaded (eager): ${toolCount} enabled native tool(s) re-registered for this session.` };
      }
      return { text: renderDefinitions(entry, entry.tools) };
    },
  };

  function renderDefinitions(entry, tools) {
    const visibleTools = enabledTools(entry, tools);
    const lines = [
      `MCP "${entry.name}" (${entry.tier})`,
      entry.serverDescription ? `description: ${entry.serverDescription}` : "description: (no description)",
      entry.serverName ? `serverName: ${entry.serverName}` : "",
      entry.serverVersion ? `version: ${entry.serverVersion}` : "",
      entry.serverTitle ? `title: ${entry.serverTitle}` : "",
      entry.websiteUrl ? `website: ${entry.websiteUrl}` : "",
      entry.instructions ? `instructions: ${entry.instructions}` : "",
      entry.notes ? `notes: ${entry.notes}` : "",
      "",
      "Tools:",
      ...visibleTools.map((tool) => {
        const schema = tool.inputSchema ? `\n    inputSchema: ${JSON.stringify(tool.inputSchema)}` : "";
        return `- ${tool.name}: ${tool.description ?? ""}${schema}`;
      }),
    ];
    return lines.filter((line) => line !== "").join("\n");
  }

  // ── mcp_call ──
  const mcpCall = {
    name: "mcp_call",
    description:
      "Invoke one tool of an on-demand MCP server through the bridge. The server must be loaded first via mcp_load; calling an unloaded server returns an error telling you to mcp_load first. Pass structured `args` only (never shell text, never a temp file). Eager servers are called directly as mcp__<server>__<tool> instead.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Registered MCP server name." },
        tool: { type: "string", description: "Raw tool name as reported by mcp_load." },
        args: { type: "object", description: "Structured JSON arguments matching the tool's inputSchema." },
      },
      required: ["name", "tool"],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      // Parameter-shape guard: the model sometimes nests the tool call inside
      // "args" (e.g. {name, args: {tool, args}}), which previously slipped
      // through as params.name=undefined and produced an opaque server-side
      // -32602. Reject early with the correct shape; never auto-unwrap.
      if (typeof args.tool !== "string" || args.tool === "") {
        const nested =
          args.args !== null &&
          typeof args.args === "object" &&
          !Array.isArray(args.args) &&
          typeof args.args.tool === "string" &&
          args.args.tool !== "";
        throw new Error(
          nested
            ? `mcp_call parameter shape error: the tool name was nested inside "args" (args.tool="${args.args.tool}"). Correct shape: {"name":"<server name>","tool":"<raw tool name>","args":{...tool arguments...}} — "tool" is a TOP-LEVEL string field; only the tool's own arguments go inside "args". Retry with the corrected shape.`
            : `mcp_call requires a top-level "tool" string field. Correct shape: {"name":"<server name>","tool":"<raw tool name>","args":{...tool arguments...}}.`,
        );
      }
      if (args.args !== undefined && (args.args === null || typeof args.args !== "object" || Array.isArray(args.args))) {
        throw new Error(
          `mcp_call "args" must be an object holding the tool arguments (or omitted entirely for no-argument tools), got ${Array.isArray(args.args) ? "an array" : JSON.stringify(args.args)}. Correct shape: {"name":"<server name>","tool":"<raw tool name>","args":{...}}.`,
        );
      }
      const entry = registry.entries.find((e) => e.name === args.name);
      if (entry === undefined) throw new Error(`MCP "${args.name}" is not registered`);
      if (entry.tier === "disabled") throw new Error(`MCP "${args.name}" is disabled`);
      if (isToolDisabled(entry, args.tool)) throw new Error(`MCP tool "${entry.name}/${args.tool}" is disabled`);
      if (exec?.agent === undefined) throw new Error("mcp_call requires a session");
      const session = sessionOf(exec.agent);
      const connection = session.connections.get(entry.name);
      if (connection === undefined) {
        throw new Error(`MCP "${args.name}" is not loaded — call mcp_load first`);
      }
      const targetTool = Array.isArray(connection.tools)
        ? connection.tools.find((tool) => tool.name === args.tool)
        : undefined;
      const errorContext = { server: entry.name, inputSchema: targetTool?.inputSchema };
      const result = await callTool(connection.client, args.tool, args.args, toolCallTimeoutMs, exec.signal, errorContext);
      if (result.isError) throw new Error(extractText(result) + isErrorContextSuffix(errorContext, args.tool, args.args));
      return { text: extractText(result) };
    },
  };

  // ── client-UI RPC handlers (skill + mcp drawers) ──
  const BUNDLE_SKILL_RE = /(^|[\\/])SKILL\.md$/i;

  // Skills living inside the DSH install (app.asar.unpacked) or any installed
  // package's node_modules are SHIPPED/read-only: the drawer may list and open
  // them, but must never toggle or delete them — doing so would corrupt the
  // deployment or a third-party plugin. Only user-writable roots are managed.
  function isReadonlySkillPath(path) {
    return /[\\/]app\.asar|[\\/]node_modules[\\/]/.test(path);
  }

  // Built-in dsh-skill-filesystem is mounted by the agent preset, so its
  // catalog (including ~/.dsh/skills junctions) is only visible when list/get
  // pass that preset's standing scope. Host UI has no current agent; use the
  // same standingKeyFor fallback the host API uses for cold transcript reads.
  async function skillLookup() {
    const presets = ctx.get("agentPresets");
    if (presets === undefined || typeof presets.standingKeyFor !== "function") return {};
    try {
      return { scope: await presets.standingKeyFor() };
    } catch {
      return {};
    }
  }

  async function resolveSkillPath(name, lookup) {
    const definition = await ctx.skills.get(name, lookup ?? {});
    if (definition === undefined || typeof definition.path !== "string") return undefined;
    if (!BUNDLE_SKILL_RE.test(definition.path)) return undefined;
    return definition;
  }

  const uiHandlers = {
    async listSkills() {
      const lookup = await skillLookup();
      const summaries = await ctx.skills.list(lookup);
      const views = [];
      for (const summary of summaries) {
        const definition = await resolveSkillPath(summary.name, lookup);
        if (definition === undefined) continue;
        views.push({
          name: definition.name,
          description: definition.description ?? "",
          path: definition.path,
          directory: dirname(definition.path),
          source: definition.source ?? "",
          provider: definition.provider ?? "",
          modelInvocable: definition.invocation?.modelInvocable !== false,
          userInvocable: definition.invocation?.userInvocable !== false,
          readonly: isReadonlySkillPath(definition.path),
          ...(definition.whenToUse !== undefined ? { whenToUse: definition.whenToUse } : {}),
        });
      }
      views.sort((a, b) => a.path.localeCompare(b.path));
      return views;
    },
    async toggleSkill(name, enabled) {
      const definition = await resolveSkillPath(name, await skillLookup());
      if (definition === undefined) throw new Error(`skill "${name}" not found or not a bundle skill`);
      if (isReadonlySkillPath(definition.path)) throw new Error(`skill "${name}" is shipped/read-only and cannot be toggled`);
      const result = await setDisableModelInvocation(definition.path, !enabled);
      return {
        name: definition.name,
        path: definition.path,
        directory: dirname(definition.path),
        modelInvocable: result.modelInvocable,
        changed: result.changed,
      };
    },
    async openSkill(name) {
      const definition = await resolveSkillPath(name, await skillLookup());
      if (definition === undefined) throw new Error(`skill "${name}" not found or not a bundle skill`);
      if (!openWithSystemEditor(definition.path)) throw new Error(`no default handler available to open ${definition.path}`);
      return { ok: true, path: definition.path };
    },
    async deleteSkill(name) {
      const definition = await resolveSkillPath(name, await skillLookup());
      if (definition === undefined) throw new Error(`skill "${name}" not found or not a bundle skill`);
      if (isReadonlySkillPath(definition.path)) throw new Error(`skill "${name}" is shipped/read-only and cannot be deleted`);
      return trashDirectory(dirname(definition.path), dataDir);
    },
    async listMcp(reveal) {
      return registry.entries.map((entry) => entryView(entry, reveal));
    },
    async setTier(name, tier) {
      if (!TIERS.has(tier)) throw new Error(`invalid tier "${tier}"`);
      const index = registry.entries.findIndex((entry) => entry.name === name);
      if (index < 0) throw new Error(`MCP "${name}" is not registered`);
      const entry = registry.entries[index];
      const wasEager = entry.tier === "eager";
      if (tier === "eager" && !wasEager) {
        const candidate = { ...entry, tier };
        const connection = await connectEntry(candidate, trialTimeoutMs);
        try {
          entry.tools = await snapshotTools(connection.client);
        } finally {
          await connection.client.close();
        }
      }
      entry.tier = tier;
      entry.lastSyncAt = new Date().toISOString();
      await saveRegistry(dataDir, registry);
      if (tier === "eager") await syncEagerEverywhere(entry);
      else if (wasEager) await disposeNamedEverywhere(name);
      await reconcile();
      return entryView(entry, false);
    },
    async setToolEnabled(name, toolName, enabled) {
      if (typeof toolName !== "string" || toolName === "") throw new Error("tool name is required");
      if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
      const entry = registry.entries.find((candidate) => candidate.name === name);
      if (entry === undefined) throw new Error(`MCP "${name}" is not registered`);
      const knownTools = entry.tools ?? [];
      if (!knownTools.some((tool) => tool.name === toolName)) {
        throw new Error(`MCP tool "${name}/${toolName}" is not in the latest tool snapshot`);
      }
      const disabled = disabledToolNames(entry);
      if (enabled) disabled.delete(toolName);
      else disabled.add(toolName);
      entry.disabledTools = [...disabled];
      entry.lastSyncAt = new Date().toISOString();
      await saveRegistry(dataDir, registry);
      if (entry.tier === "eager") await syncEagerEverywhere(entry);
      return entryView(entry, false);
    },
    async deleteMcp(name) {
      const index = registry.entries.findIndex((entry) => entry.name === name);
      if (index < 0) throw new Error(`MCP "${name}" is not registered`);
      await disposeNamedEverywhere(name);
      registry.entries.splice(index, 1);
      await saveRegistry(dataDir, registry);
      await reconcile();
      return { ok: true };
    },
    async peekMcp(name) {
      const entry = registry.entries.find((candidate) => candidate.name === name);
      if (entry === undefined) throw new Error(`MCP "${name}" is not registered`);
      if (entry.tier === "disabled") throw new Error(`MCP "${name}" is disabled`);
      return { ok: true, text: renderDefinitions(entry, entry.tools ?? []) };
    },
    async refreshSnapshot(name) {
      const entry = registry.entries.find((candidate) => candidate.name === name);
      if (entry === undefined) throw new Error(`MCP "${name}" is not registered`);
      if (entry.tier === "disabled") throw new Error(`MCP "${name}" is disabled`);
      const connection = await connectEntry(entry, trialTimeoutMs);
      try {
        entry.tools = await snapshotTools(connection.client);
        applyServerMetadata(entry, connection);
        entry.lastLoadAt = new Date().toISOString();
        await saveRegistry(dataDir, registry);
        return { ok: true, text: renderDefinitions(entry, entry.tools) };
      } finally {
        try {
          await connection.client.close();
        } catch {
          /* ignore */
        }
      }
    },
    async getSettings() {
      return { toolDescriptionMaxLength };
    },
    async setToolDescriptionMaxLength(value) {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0 || n > 5000) {
        throw new Error("toolDescriptionMaxLength must be a positive integer (<= 5000)");
      }
      toolDescriptionMaxLength = n;
      const settings = await loadSettings(dataDir);
      settings.toolDescriptionMaxLength = n;
      await saveSettings(dataDir, settings);
      return { ok: true, toolDescriptionMaxLength: n };
    },
  };

  // webServer is provided lazily by the web-app bundle; acquire it by waiting
  // on it (the same ctx.inject pattern dshmarket uses). A synchronous
  // ctx.get("webServer") here would return undefined and the routes would never
  // register, so the browser would get the SPA fallback instead of JSON.
  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer"], (hostCtx) => {
      mountUi(hostCtx, uiHandlers, { dataDir, webServer: hostCtx.webServer });
    });
  } else {
    mountUi(ctx, uiHandlers, { dataDir });
  }

  // ── pre-step catalog injector ──
  // Mirror dsh-tool-skill's skill-catalog: decide from durable session
  // surface, not a process-local digest. Compaction can drop the previous
  // mcp-catalog off the surface while the registry is unchanged; in that
  // case the catalog must be re-appended.
  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    await ensureSessionRuntime(agent);
    signal.throwIfAborted();
    const decision = await next();
    if (decision.kind === "reject") return decision;
    signal.throwIfAborted();
    const visible = registry.entries.filter((entry) => entry.tier !== "disabled");
    if (visible.length === 0) return decision;
    const digest = catalogDigest(visible);
    if (visibleCatalogDigest(agent) === digest) return decision;
    if (pendingCatalogDigest(decision.messages) === digest) return decision;
    const message = renderCatalog(visible, catalogDescriptionMaxLength, toolDescriptionMaxLength, digest);
    return { kind: "enter", messages: [...decision.messages, message] };
  });

  function catalogDigest(entries) {
    const canonical = entries
      .map((entry) => JSON.stringify([entry.name, entry.tier, entry.serverDescription, entry.notes, enabledTools(entry, entry.tools).map((t) => [t.name, t.description])]))
      .join("\n");
    return createHash("sha256").update(canonical).digest("hex");
  }

  function sourceCatalogDigest(source) {
    return typeof source?.digest === "string" && source.digest !== "" ? source.digest : undefined;
  }

  function visibleCatalogDigest(agent) {
    const visible = new Set(agent?.session?.surface?.nodes ?? []);
    const events = agent?.session?.events ?? [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type !== "user/message" || event?.data?.source?.kind !== "mcp-catalog") continue;
      const digest = sourceCatalogDigest(event.data.source);
      if (digest === undefined) continue;
      if (visible.has(event.seq)) return digest;
    }
  }

  function pendingCatalogDigest(messages) {
    if (!Array.isArray(messages)) return undefined;
    for (const message of messages) {
      if (message?.source?.kind !== "mcp-catalog") continue;
      const digest = sourceCatalogDigest(message.source);
      if (digest !== undefined) return digest;
    }
  }

  function renderCatalog(entries, maxLength, toolMaxLength, digest) {
    const lines = [];
    for (const entry of entries) {
      const description = entry.serverDescription && entry.serverDescription !== ""
        ? truncate(entry.serverDescription, maxLength)
        : "(no description)";
      let line = `- \`${entry.name}\` (${entry.tier}): ${description}`;
      if (entry.tier === "on-demand" && entry.notes) line += ` (notes: ${entry.notes})`;
      lines.push(line);
      for (const tool of enabledTools(entry, entry.tools)) {
        const desc = truncate(tool.description ?? "", toolMaxLength);
        lines.push(`  - ${tool.name}${desc ? `: ${desc}` : ""}`);
      }
    }
    const text = [
      "<system-reminder>",
      "The following MCP servers are available in this session:",
      "",
      "<mcp_catalog>",
      ...lines,
      "</mcp_catalog>",
      "",
      "用法：mcp_load / mcp_register / mcp_call 是能力库自带的管理工具，直接调用即可——它们不是某个 MCP 服务器的工具，切勿经 mcp_call 通道去转调它们。eager 服务器直接调 mcp__<server>__<tool>。on-demand 服务器先 mcp_load 拿工具名/参数，再 mcp_call {name, tool, args} 调用；未 mcp_load 直接 mcp_call 会报错。带 tools 的条目说明已有缓存；无 tools 的需先 mcp_load。disabled 服务器和工具均已隐藏。",
      "</system-reminder>",
    ].join("\n");
    return createUserMessage({
      content: [{ type: "text", text }],
      source: {
        kind: "mcp-catalog",
        form: "catalog",
        digest,
        entries: entries.map((entry) => ({ name: entry.name, tier: entry.tier, description: entry.serverDescription ?? "" })),
      },
    });
  }

  // ── effect-scoped registration (synchronous, before any await) ──
  const toolDisposers = [
    ctx.tools.register(mcpRegister),
    ctx.tools.register(mcpLoad),
    ctx.tools.register(mcpCall),
  ];
  // /prepare-uninstall command (optional: only when ctx.commands is composed).
  const commands = ctx.get("commands");
  const commandDisposer = commands !== undefined
    ? commands.register({
        name: "prepare-uninstall",
        description: "Hand managed MCP entries back to the native dsh-mcp-client before uninstalling this plugin",
        handler: () => prepareUninstall(),
      })
    : () => {};
  ctx.effect(() => {
    return async () => {
      commandDisposer();
      for (const dispose of toolDisposers) dispose();
      for (const session of [...liveSessions]) {
        liveSessions.delete(session);
        await disposeSession(session);
      }
    };
  });

  // ── skill provider (M1) ──
  registerRecursiveSkillProvider(ctx, dataDir);

  // ── startup ──
  registry = await loadRegistry(dataDir);
  try {
    const settings = await loadSettings(dataDir);
    if (typeof settings.toolDescriptionMaxLength === "number" && settings.toolDescriptionMaxLength > 0) {
      toolDescriptionMaxLength = settings.toolDescriptionMaxLength;
    }
  } catch {
    /* settings.json unreadable — keep the config default */
  }
  const imported = await reconcile();
  await warmSnapshots();
  ctx.logger.info(`skill-mcp-manager: ready (${registry.entries.length} MCP entries, imported ${imported}, dataDir=${dataDir})`);
}

export { Config, apply, inject, name };
