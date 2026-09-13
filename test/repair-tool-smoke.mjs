// One-off repair tool (tools/repair-legacy-sessions.mjs): rewrites only the
// legacy `mcp-catalog` source objects in v0 session logs, frame-by-frame, and
// proves the rewrite before writing. Fixtures are synthetic multi-frame zstd
// logs built with the same node:zlib options the DSH writer uses.
// Isolated temp root, no network, no real profile, no real sessions.

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import zlib from "node:zlib";
import {
  splitFrames,
  frameText,
  rewriteSources,
  repairFile,
  collectTargets,
  cleanupBackups,
  NEW_SOURCE,
  LEGACY_KIND,
} from "../tools/repair-legacy-sessions.mjs";

const tmp = join(homedir(), ".dsh-repair-smoke-" + process.pid);
const root = join(tmp, "sessions");
await rm(tmp, { recursive: true, force: true });

const FRAME_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const failed = [];

/** Build a v0-shaped log: frame 0 is exactly the header line, then one frame per pair of lines. */
function makeLog(lines, { perFrame = 2 } = {}) {
  const frames = [zlib.zstdCompressSync(Buffer.from(lines[0] + "\n", "utf8"), FRAME_OPTIONS)];
  for (let index = 1; index < lines.length; index += perFrame) {
    const text = lines.slice(index, index + perFrame).map((line) => line + "\n").join("");
    frames.push(zlib.zstdCompressSync(Buffer.from(text, "utf8"), FRAME_OPTIONS));
  }
  return Buffer.concat(frames);
}

const header = JSON.stringify({ type: "session", version: 0, id: "session-fixture", createdAt: 0 });
const userMessage = (seq, source, text = "hello") =>
  JSON.stringify({ type: "user/message", seq, time: 0, data: { content: [{ type: "text", text }], source } });

/** Frame shape of a log, for byte-level comparison. */
function shape(buf) {
  const frames = splitFrames(buf);
  return {
    count: frames.length,
    first: buf.subarray(...frames[0]),
    lines: frames.map(([start, end]) => frameText(buf.subarray(start, end)).split("\n").length - 1),
  };
}

async function put(project, session, file, bytes) {
  const dir = join(root, project, session);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), bytes);
  return join(dir, file);
}

// ── fixtures ───────────────────────────────────────────────────────────────
// a) current legacy shape: {kind, digest}
const fileA = await put("proj-a", "session-aaa", "session.jsonl.zstd", makeLog([
  header,
  userMessage(1, { kind: "mcp-catalog", digest: "1375d71950f34054" }),
  userMessage(2, { kind: "user" }),
  userMessage(3, { kind: "mcp-catalog", digest: "791903236d40016f" }),
]));
// b) older, wider legacy shape: {kind, form, digest, entries}
const fileB = await put("proj-a", "session-bbb", "session.jsonl.zstd", makeLog([
  header,
  userMessage(1, { kind: "mcp-catalog", form: "catalog", digest: "a65474", entries: [{ name: "demo", description: "demo MCP" }] }),
  userMessage(2, { kind: "user" }),
]));
// c) prose only: the marker appears escaped inside a message body, not as a source key
const fileC = await put("proj-b", "session-ccc", "session.jsonl.zstd", makeLog([
  header,
  userMessage(1, { kind: "user" }, 'log excerpt: "source":{"kind":"mcp-catalog","digest":"deadbeef"}'),
  userMessage(2, { kind: "user" }),
]));
// d) untouched: no marker anywhere
const fileD = await put("proj-b", "session-ddd", "session.jsonl.zstd", makeLog([
  header,
  userMessage(1, { kind: "user" }),
]));
// e) current generation: must never be collected (it never runs the v0 -> v3 chain)
const fileE = await put("proj-b", "session-eee", "session.v3.jsonl.zstd", makeLog([
  JSON.stringify({ type: "session", version: 3, id: "session-fixture-v3", createdAt: 0 }),
  userMessage(1, { kind: "mcp-catalog", digest: "1375d71950f34054" }),
]));
// f) `compression: 'none'` log: plaintext lines, same rewrite
const fileF = await put("proj-c", "session-fff", "session.jsonl", Buffer.from(
  [header, userMessage(1, { kind: "mcp-catalog", digest: "abc123" }), userMessage(2, { kind: "user" })].join("\n") + "\n",
  "utf8",
));

const before = new Map();
for (const path of [fileA, fileB, fileC, fileD, fileE, fileF]) before.set(path, await readFile(path));
const shapeBeforeA = shape(before.get(fileA));

// ── 1) dry run writes nothing ──────────────────────────────────────────────
{
  const targets = collectTargets(root);
  if (targets.length !== 5) failed.push(`collectTargets must find the 5 v0 logs (not the v3 one), found ${targets.length}`);
  if (targets.includes(fileE)) failed.push("the current-generation log must not be a target");
  const dry = await repairFile(fileA, { apply: false, stamp: "dry" });
  if (dry.status !== "patched" || dry.count !== 2) failed.push(`dry run on the legacy log: expected patched/2, got ${JSON.stringify(dry)}`);
  const after = await readFile(fileA);
  if (!after.equals(before.get(fileA))) failed.push("dry run modified the file");
}

// ── 2) apply rewrites exactly the legacy sources, frame-wise ───────────────
const stamp = "smoke1";
for (const path of [fileA, fileB, fileC, fileD, fileF]) {
  const result = await repairFile(path, { apply: true, stamp });
  const expected = path === fileA ? "patched" : path === fileB ? "patched" : path === fileF ? "patched" : "clean";
  if (result.status !== expected) failed.push(`${path.split(/[\\/]/).slice(-2).join("/")}: expected ${expected}, got ${JSON.stringify(result)}`);
}

// a) both sources replaced, everything else identical
{
  const after = await readFile(fileA);
  const shapeAfter = shape(after);
  if (shapeAfter.count !== shapeBeforeA.count) failed.push("frame count changed");
  if (!shapeAfter.first.equals(shapeBeforeA.first)) failed.push("header frame changed");
  if (JSON.stringify(shapeAfter.lines) !== JSON.stringify(shapeBeforeA.lines)) failed.push("per-frame line counts changed");
  const text = splitFrames(after).map(([start, end]) => frameText(after.subarray(start, end))).join("");
  if (text.includes(LEGACY_KIND)) failed.push("legacy marker survived the rewrite");
  const sources = text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line).data?.source).filter(Boolean);
  const rewritten = sources.filter((source) => source.plugin === "dsh-skill-mcp-manager");
  if (rewritten.length !== 2) failed.push(`expected 2 rewritten sources, got ${rewritten.length}`);
  if (JSON.stringify(rewritten[0]) !== NEW_SOURCE) failed.push(`rewritten source is ${JSON.stringify(rewritten[0])}`);
  // every source must survive the migration audit's member check
  for (const source of rewritten) {
    const keys = Object.keys(source).sort().join(",");
    if (keys !== "kind,plugin") failed.push(`rewritten source carries extra members: ${keys}`);
  }
}

// b) the wider legacy shape is matched too
{
  const bytes = await readFile(fileB);
  const text = splitFrames(bytes).map(([start, end]) => frameText(bytes.subarray(start, end))).join("");
  if (text.includes(LEGACY_KIND)) failed.push("wider legacy shape survived");
  if (!text.includes(NEW_SOURCE)) failed.push("wider legacy shape was not rewritten");
}

// c) prose mention and clean logs are byte-identical
for (const path of [fileC, fileD]) {
  const after = await readFile(path);
  if (!after.equals(before.get(path))) failed.push(`${path.split(/[\\/]/).slice(-2).join("/")}: file changed but had no legacy source`);
}

// e) the current generation is never touched
{
  const after = await readFile(fileE);
  if (!after.equals(before.get(fileE))) failed.push("the current-generation log was modified");
}

// f) plaintext log rewritten in place
{
  const text = (await readFile(fileF)).toString("utf8");
  if (text.includes(LEGACY_KIND)) failed.push("plaintext log: legacy marker survived");
  if (!text.includes(NEW_SOURCE)) failed.push("plaintext log: source was not rewritten");
}

// ── 3) backups exist, then cleanup removes them ────────────────────────────
for (const path of [fileA, fileB, fileF]) {
  if (!existsSync(`${path}.bak-${stamp}`)) failed.push(`missing backup for ${path}`);
  const backed = await readFile(`${path}.bak-${stamp}`);
  if (!backed.equals(before.get(path))) failed.push(`backup for ${path} does not match the original`);
}
{
  const removed = cleanupBackups(root, stamp);
  if (removed !== 3) failed.push(`cleanupBackups removed ${removed}, expected 3`);
  for (const path of [fileA, fileB, fileF]) {
    if (existsSync(`${path}.bak-${stamp}`)) failed.push(`backup for ${path} survived cleanup`);
  }
}

// ── 4) idempotent: a second pass finds nothing to do ───────────────────────
for (const path of [fileA, fileB, fileF]) {
  const again = await repairFile(path, { apply: false, stamp: "smoke2" });
  if (again.status !== "clean") failed.push(`second pass on ${path}: expected clean, got ${JSON.stringify(again)}`);
}

// ── 5) rewriteSources refuses a non-canonical line ─────────────────────────
{
  const line = '{"type":"user/message","seq":1,"time":0,"data":{"source":{"kind":"mcp-catalog","digest":"x"}}}';
  const spaced = line.replace('"seq":1', '"seq": 1');
  const result = rewriteSources(spaced + "\n");
  if (result.ok && result.count > 0) failed.push("a non-canonical line must be refused, not reformatted");
}

// ── 6) a source object split across frames aborts the file ─────────────────
{
  const broken = join(root, "proj-d", "session-ggg");
  await mkdir(broken, { recursive: true });
  const line = userMessage(1, { kind: "mcp-catalog", digest: "x" });
  // Frame 1 holds an unterminated half of the object; frame 2 holds the rest.
  const half = Math.floor(line.length / 2);
  const bytes = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(header + "\n" + line.slice(0, half), "utf8"), FRAME_OPTIONS),
    zlib.zstdCompressSync(Buffer.from(line.slice(half) + "\n", "utf8"), FRAME_OPTIONS),
  ]);
  const path = await put("proj-d", "session-ggg", "session.jsonl.zstd", bytes);
  const result = await repairFile(path, { apply: true, stamp: "smoke3" });
  if (result.status !== "aborted") failed.push(`a cross-frame source object must abort, got ${JSON.stringify(result)}`);
  if (existsSync(`${path}.bak-smoke3`)) failed.push("an aborted file must not be written or backed up");
}

await rm(tmp, { recursive: true, force: true });

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("REPAIR TOOL SMOKE FAILED");
  process.exit(1);
}
console.log("REPAIR TOOL SMOKE PASSED");
