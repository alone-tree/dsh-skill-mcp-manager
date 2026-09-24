// Host-side UI bridge (Client UI, M3): HTTP routes for the browser drawers
// plus the /skills and /mcp human commands. This module is pure — it holds no
// MCP/skill state; the caller binds handler closures to its live registry and
// skill service. Cross-platform "open with system editor" and "trash" helpers
// live here too, beside the secret-masking view builders.

import { spawn } from "node:child_process";
import { hostname as machineHostname, homedir } from "node:os";
import { isIP } from "node:net";
import { join, basename } from "node:path";
import { mkdir, rename, appendFile } from "node:fs/promises";

// ── HTTP helpers (mirror dsh-market) ──────────────────────────────────────

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin === undefined || host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// Host header without the port. Bracketed IPv6 (`[::1]:port`) keeps the
// address inside the brackets. A bare hostname is returned as-is.
export function requestHostname(hostHeader) {
  if (typeof hostHeader !== "string" || hostHeader.trim() === "") return undefined;
  const host = hostHeader.trim();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end <= 1) return undefined;
    return host.slice(1, end);
  }
  const colon = host.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) return host.slice(0, colon);
  return host;
}

// Local names and literal IPs are allowed without being listed. A LAN
// hostname must be on the allowlist. Comparison is case-insensitive.
export function hostPermitted(hostHeader, allowlist) {
  const hostname = requestHostname(hostHeader);
  if (hostname === undefined) return false;
  const folded = hostname.toLowerCase();
  if (folded === "localhost" || folded === machineHostname().toLowerCase()) return true;
  if (isIP(hostname) !== 0) return true;
  const allowed = new Set(
    (Array.isArray(allowlist) ? allowlist : [])
      .filter((item) => typeof item === "string")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item !== ""),
  );
  return allowed.has(folded);
}

// Browser calls (an Origin header) must be same-origin AND a permitted host.
// Calls without Origin keep the previous rule: POST still requires same-origin
// (and therefore fails closed), GET stays open.
function browserGuard(request, response, allowlist) {
  if (request.headers.origin === undefined) {
    if (request.method === "POST" && !sameOrigin(request)) {
      sendJson(response, 403, { ok: false, error: "untrusted origin" });
      return false;
    }
    return true;
  }
  if (!sameOrigin(request) || !hostPermitted(request.headers.host, allowlist)) {
    sendJson(response, 403, { ok: false, error: "untrusted origin" });
    return false;
  }
  return true;
}

async function readJsonBody(request, maxBytes = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// ── cross-platform file operations ────────────────────────────────────────

// Open a file with the OS default handler (editor for .md). Fire-and-forget:
// the launcher detaches and we never wait, so a hanging editor cannot stall
// the route.
export function openWithSystemEditor(path) {
  const platform = process.platform;
  let command;
  let args;
  if (platform === "win32") {
    // explorer.exe resolves the shell's default verb without cmd re-quoting.
    command = "explorer.exe";
    args = [path];
  } else if (platform === "darwin") {
    command = "open";
    args = [path];
  } else {
    command = "xdg-open";
    args = [path];
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function tryRecycleBinWindows(absPath) {
  return new Promise((resolve) => {
    const script = [
      "Add-Type -AssemblyName Microsoft.VisualBasic",
      `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(${psQuote(absPath)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`,
    ].join("; ");
    let child;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function tryTrashMac(absPath) {
  try {
    const dest = join(homedir(), ".Trash", `${basename(absPath)}-${Date.now()}`);
    await rename(absPath, dest);
    return true;
  } catch {
    return false;
  }
}

function tryGioTrash(absPath) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("gio", ["trash", absPath], { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function logTrash(dataDir, absPath, method, dest) {
  try {
    await appendFile(
      join(dataDir, "trash.log"),
      `${JSON.stringify({ ts: new Date().toISOString(), path: absPath, method, dest: dest ?? null })}\n`,
      "utf8",
    );
  } catch {
    /* audit log is best-effort */
  }
  return { ok: true, method, dest: dest ?? null };
}

// Delete a whole SKILL directory. Tries the platform recycle bin first
// (Windows PowerShell → Recycle Bin, macOS → ~/.Trash, Linux → gio trash),
// then falls back to the plugin's own trash directory under dataDir so a
// delete is always recoverable and never silently drops data.
export async function trashDirectory(absPath, dataDir) {
  const platform = process.platform;
  if (platform === "win32") {
    if (await tryRecycleBinWindows(absPath)) return logTrash(dataDir, absPath, "recycle-bin");
  } else if (platform === "darwin") {
    if (await tryTrashMac(absPath)) return logTrash(dataDir, absPath, "trash");
  } else if (await tryGioTrash(absPath)) {
    return logTrash(dataDir, absPath, "recycle-bin");
  }
  const trashDir = join(dataDir, "trash");
  await mkdir(trashDir, { recursive: true });
  const dest = join(trashDir, `${basename(absPath)}-${Date.now()}`);
  await rename(absPath, dest);
  return logTrash(dataDir, absPath, "plugin-trash", dest);
}

// ── secret masking ────────────────────────────────────────────────────────

function isSensitiveKey(key) {
  return /(token|secret|password|passwd|auth|credential|api[_-]?key|access[_-]?key|private[_-]?key)/i.test(key);
}

function maskSecretValue(value) {
  const text = String(value ?? "");
  if (text.length === 0) return "";
  // A `$VAR` reference is an indirection, not a secret — show it verbatim.
  if (text.startsWith("$")) return text;
  return "\u2022\u2022\u2022\u2022\u2022\u2022";
}

function maskEnv(env, reveal) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    out[key] = reveal || !isSensitiveKey(key) ? String(value) : maskSecretValue(value);
  }
  return out;
}

function maskHeaders(headers, reveal) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key] = reveal ? String(value) : maskSecretValue(value);
  }
  return out;
}

function maskUrl(url, reveal) {
  if (url === undefined || url === null || url === "") return url;
  if (reveal) return url;
  try {
    const parsed = new URL(url);
    if (parsed.search) parsed.search = "?<redacted>";
    return parsed.toString();
  } catch {
    return "<redacted>";
  }
}

export function entryView(entry, reveal, state = {}) {
  const disabledTools = new Set(Array.isArray(entry.disabledTools) ? entry.disabledTools : []);
  return {
    id: entry.id,
    name: entry.name,
    tier: entry.tier,
    transport: entry.transport,
    command: entry.command ?? null,
    args: entry.args ?? [],
    env: maskEnv(entry.env, reveal),
    cwd: entry.cwd ?? null,
    url: maskUrl(entry.url, reveal),
    headers: maskHeaders(entry.headers, reveal),
    notes: entry.notes ?? "",
    managed: entry.managed ?? false,
    registeredAt: entry.registeredAt ?? null,
    lastLoadAt: entry.lastLoadAt ?? null,
    toolCount: Array.isArray(entry.tools) ? entry.tools.length : 0,
    tools: Array.isArray(entry.tools)
      ? entry.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          enabled: !disabledTools.has(tool.name),
        }))
      : [],
    serverName: entry.serverName ?? "",
    serverVersion: entry.serverVersion ?? "",
    serverTitle: entry.serverTitle ?? "",
    serverDescription: entry.serverDescription ?? "",
    websiteUrl: entry.websiteUrl ?? "",
    instructions: entry.instructions ?? "",
    connectFailed: state.connectFailed === true,
  };
}

// ── route + command mounting ──────────────────────────────────────────────

// handlers (all async, all throw on error):
//   listSkills()                       -> SkillView[]
//   toggleSkill(name, enabled)         -> SkillView
//   openSkill(name)                    -> { ok, path, error? }
//   deleteSkill(name)                  -> { ok, method, error? }
//   listMcp(reveal)                    -> McpEntryView[]
//   setTier(name, tier)                -> McpEntryView
//   setToolEnabled(name, tool, enabled)-> McpEntryView
//   deleteMcp(name)                    -> { ok, error? }
//   peekMcp(name)                      -> { ok, text, error? }
//   refreshSnapshot(name)              -> { ok, text, error? }
export function mountUi(ctx, handlers, { dataDir, webServer }) {
  const disposers = [];
  // webServer is provided lazily by the web-app bundle; the caller acquires it
  // via `ctx.inject(['webServer'], ...)` and passes it in (mirroring dshmarket).
  // The `ctx.get` fallback keeps the mock-ctx test path working.
  const server = webServer ?? ctx.get("webServer");
  if (server !== undefined) {
    const route = (method, path, fn) => {
      disposers.push(server.register({
        kind: "exact",
        path,
        handler: async (request, response) => {
          try {
            if (request.method !== method) {
              response.writeHead(405, { allow: method });
              response.end();
              return;
            }
            if (!browserGuard(request, response, handlers.lanHostAllowlist?.() ?? [])) return;
            const body = method === "POST" ? await readJsonBody(request) : {};
            const result = await fn(body, request);
            sendJson(response, 200, result);
          } catch (error) {
            sendJson(response, 400, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      }));
    };

    route("GET", "/skill-mcp-manager/skills", async () => ({ skills: await handlers.listSkills() }));
    route("POST", "/skill-mcp-manager/skills/toggle", async (body) => ({
      ok: true,
      skill: await handlers.toggleSkill(body.name, body.enabled === true),
    }));
    route("POST", "/skill-mcp-manager/skills/open", async (body) => await handlers.openSkill(body.name));
    route("POST", "/skill-mcp-manager/skills/delete", async (body) => await handlers.deleteSkill(body.name));
    route("GET", "/skill-mcp-manager/mcp", async (_body, request) => ({
      entries: await handlers.listMcp(String(request.url ?? "").includes("reveal=1")),
    }));
    route("POST", "/skill-mcp-manager/mcp/tier", async (body) => ({
      ok: true,
      entry: await handlers.setTier(body.name, body.tier),
    }));
    route("POST", "/skill-mcp-manager/mcp/tool-tier", async (body) => ({
      ok: true,
      entry: await handlers.setToolEnabled(body.name, body.tool, body.enabled),
    }));
    route("POST", "/skill-mcp-manager/mcp/delete", async (body) => await handlers.deleteMcp(body.name));
    route("POST", "/skill-mcp-manager/mcp/load", async (body) => (
      body.peek === true
        ? await handlers.peekMcp(body.name)
        : await handlers.refreshSnapshot(body.name)
    ));
    // settings: GET + POST share one path, so register ONE route and dispatch
    // on method (the webServer rejects duplicate (kind, path)).
    disposers.push(server.register({
      kind: "exact",
      path: "/skill-mcp-manager/settings",
      handler: async (request, response) => {
        try {
          if (!browserGuard(request, response, handlers.lanHostAllowlist?.() ?? [])) return;
          if (request.method === "GET") {
            sendJson(response, 200, await handlers.getSettings());
            return;
          }
          if (request.method === "POST") {
            const body = await readJsonBody(request);
            sendJson(response, 200, await handlers.setSettings(body));
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        } catch (error) {
          sendJson(response, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    }));

    route("GET", "/skill-mcp-manager/session-audit", async () => await handlers.getSessionAudit());
  }

  const commands = ctx.get("commands");
  if (commands !== undefined) {
    disposers.push(commands.register({
      name: "skills",
      description: "List every managed skill (bundle SKILL.md) with its path and model-invocation state",
      handler: async () => {
        const skills = await handlers.listSkills();
        const text = skills.length === 0
          ? "No managed skills found."
          : `Managed skills (${skills.length}):\n${skills
              .map((skill) => `- ${skill.name} [${skill.modelInvocable ? "on" : "off"}] ${skill.path}`)
              .join("\n")}`;
        return { kind: "success", text };
      },
    }));
    disposers.push(commands.register({
      name: "mcp",
      description: "List every registered MCP server with tier and tool count. /mcp prepare-uninstall hands them back to the native client.",
      handler: async (invocation) => {
        const raw = String(invocation?.rawInput ?? "").trim();
        if (raw === "prepare-uninstall") {
          if (typeof handlers.prepareUninstall !== "function") {
            return { kind: "error", text: "prepare-uninstall is not available" };
          }
          return handlers.prepareUninstall();
        }
        if (raw !== "") {
          return {
            kind: "error",
            text: "用法：/mcp 列出服务器；/mcp prepare-uninstall 把托管条目交还原生客户端。",
          };
        }
        const entries = await handlers.listMcp(false);
        const text = entries.length === 0
          ? "No MCP servers registered."
          : `Registered MCP servers (${entries.length}):\n${entries
              .map((entry) => `- ${entry.name} [${entry.tier}] — ${entry.toolCount} tool(s)`)
              .join("\n")}`;
        return { kind: "success", text };
      },
    }));
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  });

  return disposers;
}
