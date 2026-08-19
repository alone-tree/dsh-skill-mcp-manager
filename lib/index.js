// dsh-skill-mcp-manager — host plugin for DeepSeek Harness.
//
// Visual, manageable, injectable MCP management (Skill management lands in M1).
// Three tiers per MCP server:
//   - eager      : connect at startup, register native `mcp__<server>__<tool>` tools
//   - on-demand  : no connection at startup; `mcp_load` fetches definitions, `mcp_call` invokes
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
// Begin of the managed shadow block appended to the profile's cordis.patch.yml.
const MANAGED_MARKER = "# ── Managed MCP servers (dsh-skill-mcp-manager, disabled shadow entries) ──";
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

// Build a registry entry from a native dsh-mcp-client insert row.
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
    serverName: "",
    serverVersion: "",
    serverTitle: "",
    serverDescription: "",
    websiteUrl: "",
    instructions: "",
    capabilities: null,
    metaFetchedAt: null,
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

async function callTool(client, rawName, args, timeoutMs, signal) {
  return client.request(
    { method: "tools/call", params: { name: rawName, arguments: args && typeof args === "object" ? args : {} } },
    CallToolResultSchema,
    { signal, timeout: timeoutMs },
  );
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

  // Live runtime state.
  const connections = new Map(); // entry.name -> { client, transport, tools }
  const nativeDisposers = new Map(); // entry.name -> Map<publicName, disposer>
  const lastCatalogDigest = new WeakMap(); // agent -> digest
  let registry = emptyRegistry();

  async function snapshotTools(client) {
    return (await listTools(client)).map((tool) => ({ name: tool.name, description: tool.description ?? "" }));
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

  async function ensureConnected(entry) {
    const existing = connections.get(entry.name);
    if (existing !== undefined) return existing;
    const connection = await connectEntry(entry, trialTimeoutMs);
    connections.set(entry.name, connection);
    applyServerMetadata(entry, connection);
    return connection;
  }

  async function ensureEager(entry) {
    const connection = await ensureConnected(entry);
    entry.tools = connection.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "" }));
    const previous = nativeDisposers.get(entry.name);
    if (previous !== undefined) for (const dispose of previous.values()) dispose();
    const disposers = new Map();
    for (const tool of connection.tools) {
      const publicName = publicToolName(entry.name, tool.name);
      disposers.set(publicName, ctx.tools.register({
        name: publicName,
        description: tool.description ?? "",
        parameters: tool.inputSchema ?? { type: "object" },
        output: TEXT_OUTPUT,
        async execute(args, exec) {
          const result = await callTool(connection.client, tool.name, args, toolCallTimeoutMs, exec.signal);
          if (result.isError) throw new Error(extractText(result));
          return { text: extractText(result) };
        },
      }));
    }
    nativeDisposers.set(entry.name, disposers);
    return connection.tools.length;
  }

  async function disposeEntry(entryName) {
    const connection = connections.get(entryName);
    connections.delete(entryName);
    const disposers = nativeDisposers.get(entryName);
    nativeDisposers.delete(entryName);
    if (disposers !== undefined) for (const dispose of disposers.values()) dispose();
    if (connection !== undefined) {
      try {
        await connection.client.close();
      } catch {
        /* ignore */
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

  function managedBlockYaml(nativeEntries) {
    const nativeNames = new Set(
      nativeEntries.map((entry) => entry.config?.serverName).filter((value) => typeof value === "string"),
    );
    const shadowOnly = [];
    for (const entry of registry.entries) {
      if (entry.tier === "disabled") continue;
      if (nativeNames.has(entry.name)) continue; // the native row already mirrors this config
      const config = shadowConfig(entry);
      if (config === null) continue;
      shadowOnly.push({
        id: entry.systemEntryId ?? `mcp-${entry.name}`,
        name: "@deepseek-ai/dsh-mcp-client",
        config,
        disabled: true,
      });
    }
    const takeover = nativeEntries
      .filter((entry) => entry.disabled !== true && typeof entry.id === "string" && entry.id !== "")
      .map((entry) => `- id: ${entry.id}\n  disabled: true`);
    const parts = [MANAGED_MARKER];
    if (shadowOnly.length > 0) parts.push(stringify([{ insert: shadowOnly }]));
    if (takeover.length > 0) parts.push(takeover.join("\n"));
    return `${parts.join("\n")}\n`;
  }

  function handoverBlockYaml(nativeEntries) {
    const nativeNames = new Set(
      nativeEntries.map((entry) => entry.config?.serverName).filter((value) => typeof value === "string"),
    );
    const entries = [];
    for (const entry of registry.entries) {
      if (entry.tier === "disabled") continue;
      if (nativeNames.has(entry.name)) continue;
      const config = shadowConfig(entry);
      if (config === null) continue;
      entries.push({
        id: entry.systemEntryId ?? `mcp-${entry.name}`,
        name: "@deepseek-ai/dsh-mcp-client",
        config,
      });
    }
    if (entries.length === 0) return "";
    return `${HANDOVER_MARKER}\n${stringify([{ insert: entries }])}`;
  }

  // Import native dsh-mcp-client entries that are not yet in the registry.
  // Boot-only: runtime mutations must NOT re-import, or an entry the user
  // deleted from the registry would resurrect on the next write.
  async function importNative() {
    if (config.importNativeMcp === false) return 0;
    const patchPath = join(DSH_HOME, "profiles", config.profile ?? "web", "cordis.patch.yml");
    let current;
    try {
      current = await readFile(patchPath, "utf8");
    } catch {
      return 0;
    }
    const markerIndex = current.indexOf(MANAGED_MARKER);
    const nativeText = markerIndex >= 0 ? current.slice(0, markerIndex) : current;
    const known = new Set(registry.entries.map((entry) => entry.name));
    let imported = 0;
    for (const native of parseNativeMcpEntries(nativeText)) {
      const serverName = native.config?.serverName;
      if (typeof serverName !== "string" || serverName === "" || known.has(serverName)) continue;
      const tier = native.disabled === true ? "disabled" : "on-demand";
      registry.entries.push(nativeEntryToRegistryEntry(native, tier));
      known.add(serverName);
      imported += 1;
    }
    if (imported > 0) await saveRegistry(dataDir, registry);
    return imported;
  }

  // Write the managed block: a `disabled: true` shadow insert for registry
  // entries the native section does not mirror, plus an id-targeted
  // `disabled: true` override for every enabled native row (takeover).
  async function reconcile() {
    const patchPath = join(DSH_HOME, "profiles", config.profile ?? "web", "cordis.patch.yml");
    let current;
    try {
      current = await readFile(patchPath, "utf8");
    } catch {
      ctx.logger.warn(`skill-mcp-manager: cannot read ${patchPath}; reconcile skipped`);
      return;
    }
    const markerIndex = current.indexOf(MANAGED_MARKER);
    const nativeText = markerIndex >= 0 ? current.slice(0, markerIndex) : current;
    const nativeEntries = parseNativeMcpEntries(nativeText);
    const block = managedBlockYaml(nativeEntries);
    const next = markerIndex >= 0
      ? current.slice(0, markerIndex).trimEnd() + `\n\n${block}`
      : current.trimEnd() + `\n\n${block}`;
    if (next === current) return;
    await writeFile(`${patchPath}.bak-${Date.now()}`, current, "utf8");
    await writeFile(patchPath, next, "utf8");
    ctx.logger.info(`skill-mcp-manager: reconciled ${patchPath} (scope: ${config.profile})`);
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
    const patchPath = join(DSH_HOME, "profiles", config.profile ?? "web", "cordis.patch.yml");
    let current;
    try {
      current = await readFile(patchPath, "utf8");
    } catch {
      return { kind: "error", text: `cannot read ${patchPath}` };
    }
    const markerIndex = current.indexOf(MANAGED_MARKER);
    if (markerIndex < 0) {
      return { kind: "success", text: "No managed MCP block found — nothing to hand back." };
    }
    const nativeEntries = parseNativeMcpEntries(current.slice(0, markerIndex));
    const count = registry.entries.filter((entry) => entry.tier !== "disabled").length;
    const block = handoverBlockYaml(nativeEntries);
    const next = current.slice(0, markerIndex).trimEnd() + (block ? `\n\n${block}\n` : "");
    if (next !== current) {
      await writeFile(`${patchPath}.bak-${Date.now()}`, current, "utf8");
      await writeFile(patchPath, next, "utf8");
    }
    for (const entry of registry.entries) {
      if (entry.tier === "eager") await disposeEntry(entry.name);
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
        const toolCount = await ensureEager(entry);
        await reconcile();
        return { text: `MCP "${entry.name}" ${isUpdate ? "updated" : "registered"} as eager — connected and registered ${toolCount} native tool(s).` };
      }
      if (isUpdate && existing.tier === "eager") await disposeEntry(entry.name);
      await reconcile();
      return { text: `MCP "${entry.name}" ${isUpdate ? "updated" : "registered"} (tier=${entry.tier}, ${snapshot.length} tool(s)).` };
    },
  };

  // ── mcp_load ──
  const mcpLoad = {
    name: "mcp_load",
    description:
      "Load (or hot-reload) one non-disabled MCP server and return its full tool definitions (names, descriptions, parameter schemas) as this tool's result. With peek=true it only reads the latest snapshot or active connection without connecting, registering, or dropping a live connection.",
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
    async execute(args) {
      const entry = registry.entries.find((e) => e.name === args.name);
      if (entry === undefined) throw new Error(`MCP "${args.name}" is not registered`);
      if (entry.tier === "disabled") throw new Error(`MCP "${args.name}" is disabled`);

      if (args.peek === true) {
        const connection = connections.get(entry.name);
        const tools = connection?.tools ?? entry.tools ?? [];
        return { text: renderDefinitions(entry, tools) };
      }

      // Hot reload: drop the existing connection, connect fresh.
      await disposeEntry(entry.name);
      const connection = await ensureConnected(entry);
      entry.tools = await snapshotTools(connection.client);
      entry.lastLoadAt = new Date().toISOString();
      await saveRegistry(dataDir, registry);

      if (entry.tier === "eager") {
        await ensureEager(entry);
        return { text: `MCP "${entry.name}" reloaded (eager): ${entry.tools.length} tool(s), native tools re-registered.` };
      }
      return { text: renderDefinitions(entry, entry.tools) };
    },
  };

  function renderDefinitions(entry, tools) {
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
      ...tools.map((tool) => {
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
      const entry = registry.entries.find((e) => e.name === args.name);
      if (entry === undefined) throw new Error(`MCP "${args.name}" is not registered`);
      if (entry.tier === "disabled") throw new Error(`MCP "${args.name}" is disabled`);
      const connection = connections.get(entry.name);
      if (connection === undefined) {
        throw new Error(`MCP "${args.name}" is not loaded — call mcp_load first`);
      }
      const result = await callTool(connection.client, args.tool, args.args, toolCallTimeoutMs, exec.signal);
      if (result.isError) throw new Error(extractText(result));
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

  async function resolveSkillPath(name) {
    const definition = await ctx.skills.get(name);
    if (definition === undefined || typeof definition.path !== "string") return undefined;
    if (!BUNDLE_SKILL_RE.test(definition.path)) return undefined;
    return definition;
  }

  const uiHandlers = {
    async listSkills() {
      const summaries = await ctx.skills.list();
      const views = [];
      for (const summary of summaries) {
        const definition = await resolveSkillPath(summary.name);
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
      const definition = await resolveSkillPath(name);
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
      const definition = await resolveSkillPath(name);
      if (definition === undefined) throw new Error(`skill "${name}" not found or not a bundle skill`);
      if (!openWithSystemEditor(definition.path)) throw new Error(`no default handler available to open ${definition.path}`);
      return { ok: true, path: definition.path };
    },
    async deleteSkill(name) {
      const definition = await resolveSkillPath(name);
      if (definition === undefined) throw new Error(`skill "${name}" not found or not a bundle skill`);
      if (isReadonlySkillPath(definition.path)) throw new Error(`skill "${name}" is shipped/read-only and cannot be deleted`);
      return trashDirectory(dirname(definition.path), dataDir);
    },
    async listMcp(reveal) {
      return registry.entries.map((entry) => entryView(entry, reveal, connections.has(entry.name)));
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
      if (tier === "eager") await ensureEager(entry);
      else if (wasEager) await disposeEntry(name);
      await reconcile();
      return entryView(entry, false, connections.has(name));
    },
    async deleteMcp(name) {
      const index = registry.entries.findIndex((entry) => entry.name === name);
      if (index < 0) throw new Error(`MCP "${name}" is not registered`);
      await disposeEntry(name);
      registry.entries.splice(index, 1);
      await saveRegistry(dataDir, registry);
      await reconcile();
      return { ok: true };
    },
    async loadMcp(name, peek) {
      const entry = registry.entries.find((candidate) => candidate.name === name);
      if (entry === undefined) throw new Error(`MCP "${name}" is not registered`);
      if (entry.tier === "disabled") throw new Error(`MCP "${name}" is disabled`);
      if (peek) {
        const connection = connections.get(name);
        const tools = connection?.tools ?? entry.tools ?? [];
        return { ok: true, text: renderDefinitions(entry, tools) };
      }
      await disposeEntry(name);
      const connection = await ensureConnected(entry);
      entry.tools = await snapshotTools(connection.client);
      entry.lastLoadAt = new Date().toISOString();
      await saveRegistry(dataDir, registry);
      if (entry.tier === "eager") {
        await ensureEager(entry);
        return { ok: true, text: `MCP "${entry.name}" reloaded (eager): ${entry.tools.length} tool(s), native tools re-registered.` };
      }
      return { ok: true, text: renderDefinitions(entry, entry.tools) };
    },
    async disconnectMcp(name) {
      const entry = registry.entries.find((candidate) => candidate.name === name);
      if (entry === undefined) throw new Error(`MCP "${name}" is not registered`);
      await disposeEntry(name);
      return { ok: true };
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
  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind === "reject") return decision;
    signal.throwIfAborted();
    const visible = registry.entries.filter((entry) => entry.tier !== "disabled");
    if (visible.length === 0) return decision;
    const digest = catalogDigest(visible);
    if (lastCatalogDigest.get(agent) === digest) return decision;
    lastCatalogDigest.set(agent, digest);
    const message = renderCatalog(visible, catalogDescriptionMaxLength, toolDescriptionMaxLength);
    return { kind: "enter", messages: [...decision.messages, message] };
  });

  function catalogDigest(entries) {
    const canonical = entries
      .map((entry) => JSON.stringify([entry.name, entry.tier, entry.serverDescription, entry.notes, (entry.tools ?? []).map((t) => [t.name, t.description])]))
      .join("\n");
    return createHash("sha256").update(canonical).digest("hex");
  }

  function renderCatalog(entries, maxLength, toolMaxLength) {
    const lines = [];
    for (const entry of entries) {
      const description = entry.serverDescription && entry.serverDescription !== ""
        ? truncate(entry.serverDescription, maxLength)
        : "(no description)";
      let line = `- \`${entry.name}\` (${entry.tier}): ${description}`;
      if (entry.tier === "on-demand" && entry.notes) line += ` (notes: ${entry.notes})`;
      lines.push(line);
      for (const tool of entry.tools ?? []) {
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
      "用法：mcp_load / mcp_register / mcp_call 是能力库自带的管理工具，直接调用即可——它们不是某个 MCP 服务器的工具，切勿经 mcp_call 通道去转调它们。eager 服务器直接调 mcp__<server>__<tool>。on-demand 服务器先 mcp_load 拿工具名/参数，再 mcp_call {name, tool, args} 调用；未 mcp_load 直接 mcp_call 会报错。带 tools 的条目说明已有缓存；无 tools 的需先 mcp_load。disabled 已隐藏。",
      "</system-reminder>",
    ].join("\n");
    return createUserMessage({
      content: [{ type: "text", text }],
      source: {
        kind: "mcp-catalog",
        form: "catalog",
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
      for (const entryName of [...connections.keys()]) await disposeEntry(entryName);
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
  const imported = await importNative();
  await reconcile();
  for (const entry of registry.entries) {
    if (entry.tier === "eager") {
      try {
        await ensureEager(entry);
      } catch (error) {
        ctx.logger.error(`skill-mcp-manager: failed to start eager MCP "${entry.name}": ${String(error?.message ?? error)}`);
      }
    }
  }
  await warmSnapshots();
  ctx.logger.info(`skill-mcp-manager: ready (${registry.entries.length} MCP entries, imported ${imported}, dataDir=${dataDir})`);
}

export { Config, apply, inject, name };
