// Regression: Desktop strips Origin before forwarding a JSON POST to the host.
// Exercise real plugin routes, loopback HTTP, a stdio MCP child, and persistence.
// Default: portable forwarding contract. --desktop-asar: installed shell code.
import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomInt } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === "--desktop-asar"),
  "Usage: node test/desktop-origin-smoke.mjs [--desktop-asar <trusted app.asar>]");

// Model only the observed request boundary; this is not an Electron GUI test.
async function forwardContract(request, host, cookie) {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "dsh-app://app") return new Response(null, { status: 403 });
  const source = new URL(request.url);
  const target = new URL(source.pathname + source.search, host);
  const headers = new Headers(request.headers);
  for (const name of ["host", "origin", "cookie", "sec-fetch-site"]) headers.delete(name);
  headers.set("cookie", cookie);
  return fetch(target, {
    method: request.method, headers, body: request.body, signal: request.signal,
    duplex: "half", redirect: "manual",
  });
}

// Read two entries without unpacking the application or requiring an ASAR CLI.
// This executes code from a trusted local installation; vm is NOT a sandbox.
async function installedForward(asarPath) {
  const archive = await open(asarPath, "r");
  try {
    const { size } = await archive.stat();
    async function readAt(position, length) {
      assert(Number.isSafeInteger(position) && position >= 0 &&
        Number.isSafeInteger(length) && length >= 0 && length <= 64 * 1024 * 1024 &&
        position + length <= size, "Invalid or oversized ASAR entry");
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await archive.read(buffer, offset, length - offset, position + offset);
        assert(bytesRead > 0, "Unexpected end of ASAR");
        offset += bytesRead;
      }
      return buffer;
    }
    const prefix = await readAt(0, 16);
    const dataStart = 8 + prefix.readUInt32LE(4);
    const headerLength = prefix.readUInt32LE(12);
    assert(16 + headerLength <= dataStart && dataStart <= size, "Invalid ASAR header");
    const tree = JSON.parse((await readAt(16, headerLength)).toString("utf8"));
    async function entryText(path) {
      let entry = tree;
      for (const part of path.split("/")) entry = entry?.files?.[part];
      assert(entry && !entry.link, `Missing or linked ASAR entry: ${path}`);
      if (entry.unpacked) return readFile(join(`${asarPath}.unpacked`, path), "utf8");
      return (await readAt(dataStart + Number(entry.offset), entry.size)).toString("utf8");
    }
    const metadata = JSON.parse(await entryText("package.json"));
    const source = await entryText("lib/main.js");
    const start = source.indexOf("const WITHHELD_RESPONSE_HEADERS");
    const end = source.indexOf("//#endregion", start);
    assert(start >= 0 && end > start,
      "Desktop forwarding section changed; inspect the installed source before updating this test");
    const section = source.slice(start, end);
    assert(section.includes("async function forwardWebRequest("), "Missing Desktop forwarding function");
    const forward = runInNewContext(`${section}; forwardWebRequest`,
      { URL, Headers, Response, fetch }, { timeout: 1000 });
    assert.equal(typeof forward, "function");
    return { forward, label: `installed ${metadata.name}@${metadata.version}` };
  } finally {
    await archive.close();
  }
}

const { forward, label } = args.length
  ? await installedForward(args[1])
  : { forward: forwardContract, label: "portable forwarding contract (no Electron)" };
const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = fileURLToPath(new URL("fixtures/desktop-origin-server.mjs", import.meta.url));
const dataDir = await mkdtemp(join(tmpdir(), "dsh-desktop-origin-"));
const previousDshHome = process.env.DSH_HOME;
const routes = [];
const effects = [];
const seen = [];
const server = createServer((req, res) => {
  seen.push({ origin: req.headers.origin, site: req.headers["sec-fetch-site"],
    marker: req.headers["x-dsh-skill-mcp-manager"] });
  const route = routes.find((r) => r.path === new URL(req.url, "http://localhost").pathname);
  if (!route) { res.statusCode = 404; res.end(); return; }
  Promise.resolve().then(() => route.handler(req, res)).catch((error) => {
    res.statusCode = 500; res.end(String(error));
  });
});
const ctx = {
  tools: { register() { return () => {}; } },
  skills: { registerProvider() { return () => {}; } },
  on() { return () => {}; },
  effect(fn) { const dispose = fn(); if (typeof dispose === "function") effects.push(dispose); },
  get(name) { return name === "webServer"
    ? { register(route) { routes.push(route); return () => {}; } } : undefined; },
  logger: { warn() {}, error() {}, info() {} },
};
try {
  // index.js captures DSH_HOME at import time. The __test__ sentinel disables
  // auditing, but reconcile still probes that profile's patch even with import off.
  process.env.DSH_HOME = join(dataDir, "home");
  const { apply } = await import("../lib/index.js");
  const registryPath = join(dataDir, "registry.json");
  await writeFile(registryPath, JSON.stringify({ version: 1, entries: [{
    id: "desktop", name: "desktop", tier: "on-demand", transport: "stdio",
    command: process.execPath, args: [fixture], env: {}, cwd: root,
    // A cached timestamp prevents startup warming from satisfying the assertions.
    tools: [{ name: "stale" }], metaFetchedAt: "2026-01-01T00:00:00.000Z",
  }] }));
  await apply(ctx, { dataDir, profile: "__test__", importNativeMcp: false });
  // Some Windows hosts assign low ephemeral ports that Fetch forbids (e.g. 6000).
  // Use the private port range and retry collisions without bypassing Fetch.
  for (let attempt = 0; ; attempt++) {
    assert(attempt < 32, "Unable to allocate a Fetch-compatible loopback port");
    server.listen(randomInt(49152, 65536), "127.0.0.1");
    try {
      await once(server, "listening");
      break;
    } catch (error) {
      if (error.code !== "EADDRINUSE" && error.code !== "EACCES") throw error;
    }
  }
  const host = `http://127.0.0.1:${server.address().port}`;
  const invoke = (origin, marker) => {
    const headers = { origin, "content-type": "application/json", "sec-fetch-site": "same-origin" };
    if (marker) headers["x-dsh-skill-mcp-manager"] = "1";
    return forward(new Request("dsh-app://app/skill-mcp-manager/mcp/load", {
      method: "POST", headers, body: JSON.stringify({ name: "desktop" }),
      signal: AbortSignal.timeout(15_000),
    }), host, "test-cookie=isolated");
  };
  const hostile = await invoke("http://evil.example", true);
  assert.equal(hostile.status, 403, "foreign origins must not reach the host");
  await hostile.arrayBuffer();
  assert.equal(seen.length, 0);

  const legacy = await invoke("dsh-app://app", false);
  assert.equal(legacy.status, 403, "unmarked Desktop POST must remain blocked");
  assert.equal((await legacy.json()).error, "untrusted origin");
  const before = JSON.parse(await readFile(registryPath, "utf8"));
  assert.deepEqual(before.entries[0].tools.map((tool) => tool.name), ["stale"],
    "rejected requests and startup must not refresh the snapshot");

  const fixed = await invoke("dsh-app://app", true);
  assert.equal(fixed.status, 200, "marked Desktop JSON POST must refresh the snapshot");
  assert.equal((await fixed.json()).ok, true);
  const saved = JSON.parse(await readFile(registryPath, "utf8"));
  assert.deepEqual(saved.entries[0].tools.map((tool) => tool.name), ["desktop_ping"]);
  assert.deepEqual(saved.entries[0].tools[0].inputSchema,
    { type: "object", properties: {}, additionalProperties: false });
  assert.equal(saved.entries[0].serverName, "desktop-origin-fixture");
  assert.deepEqual(seen.at(-1), { origin: undefined, site: undefined, marker: "1" });
  console.log(`PASS Desktop snapshot: ${label}; HTTP + stdio + persisted tools/schema`);
} finally {
  try {
    for (const dispose of effects.reverse()) await dispose();
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
}
