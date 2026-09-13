// One-off legacy session audit (lib/session-audit.js): detects sessions written
// before the 1.1.5 source-format fix so the UI can point at the repair guide.
// It is read-only by design — the only file it writes is its own record.
// Isolated temp root, no network, no real profile, no real sessions.

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import zlib from "node:zlib";
import {
  collectLegacyCandidates,
  hasLegacySource,
  auditSessions,
  readAuditRecord,
  runAuditIfNeeded,
  AUDIT_FILE,
} from "../lib/session-audit.js";

const tmp = join(homedir(), ".dsh-audit-smoke-" + process.pid);
const root = join(tmp, "sessions");
const dataDir = join(tmp, "data");
await rm(tmp, { recursive: true, force: true });

const FRAME_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const failed = [];

/** Build a v0-shaped log: frame 0 is exactly the header line. */
function makeLog(lines) {
  const frames = [zlib.zstdCompressSync(Buffer.from(lines[0] + "\n", "utf8"), FRAME_OPTIONS)];
  for (const line of lines.slice(1)) {
    frames.push(zlib.zstdCompressSync(Buffer.from(line + "\n", "utf8"), FRAME_OPTIONS));
  }
  return Buffer.concat(frames);
}

const header = JSON.stringify({ type: "session", version: 0, id: "session-fixture", createdAt: 0 });
const event = (seq, source, text = "hello") =>
  JSON.stringify({ type: "user/message", seq, time: 0, data: { content: [{ type: "text", text }], source } });

async function put(project, session, file, bytes) {
  const dir = join(root, project, session);
  await mkdir(dir, { recursive: true });
  const path = join(dir, file);
  await writeFile(path, bytes);
  return path;
}

// a) affected: the legacy kind is present
const fileA = await put("proj-a", "session-aaa", "session.jsonl.zstd", makeLog([
  header,
  event(1, { kind: "user" }),
  event(2, { kind: "mcp-catalog", digest: "1375d719" }),
]));
// b) affected through the older, wider legacy shape
const fileB = await put("proj-a", "session-bbb", "session.jsonl.zstd", makeLog([
  header,
  event(1, { kind: "mcp-catalog", form: "catalog", digest: "a6", entries: [] }),
]));
// c) clean: the marker only appears escaped inside a message body
const fileC = await put("proj-b", "session-ccc", "session.jsonl.zstd", makeLog([
  header,
  event(1, { kind: "user" }, 'log: "source":{"kind":"mcp-catalog","digest":"deadbeef"}'),
]));
// d) already repaired: the plugin's own current shape
const fileD = await put("proj-b", "session-ddd", "session.jsonl.zstd", makeLog([
  header,
  event(1, { kind: "plugin", plugin: "dsh-skill-mcp-manager" }),
]));
// e) current generation: never runs the v0 -> v3 chain, so never a candidate
const fileE = await put("proj-b", "session-eee", "session.v3.jsonl.zstd", makeLog([
  JSON.stringify({ type: "session", version: 3, id: "session-fixture-v3", createdAt: 0 }),
  event(1, { kind: "mcp-catalog", digest: "1375d719" }),
]));
// f) plaintext (`compression: 'none'`) affected log
const fileF = await put("proj-c", "session-fff", "session.jsonl", Buffer.from(
  [header, event(1, { kind: "mcp-catalog", digest: "abc" })].join("\n") + "\n",
  "utf8",
));

// ── 1) candidate collection ────────────────────────────────────────────────
{
  const targets = collectLegacyCandidates(root);
  if (targets.length !== 5) failed.push(`expected the 5 v0 logs (not the v3 one), got ${targets.length}`);
  if (targets.includes(fileE)) failed.push("the current-generation log must not be a candidate");
}

// ── 2) per-log verdict ─────────────────────────────────────────────────────
{
  const expectations = [
    [fileA, true, "current legacy shape"],
    [fileB, true, "older wider legacy shape"],
    [fileC, false, "escaped mention inside a message body"],
    [fileD, false, "already-repaired plugin source"],
    [fileF, true, "plaintext log"],
  ];
  for (const [path, expected, label] of expectations) {
    const actual = hasLegacySource(path);
    if (actual !== expected) failed.push(`${label}: expected ${expected}, got ${actual}`);
  }
  if (hasLegacySource(join(root, "proj-z", "missing", "session.jsonl.zstd")) !== false) {
    failed.push("a missing file must read as unaffected, not throw");
  }
}

// ── 3) audit counts affected logs, not occurrences ─────────────────────────
{
  const result = await auditSessions(root);
  if (result.scanned !== 5) failed.push(`auditSessions scanned ${result.scanned}, expected 5`);
  if (result.affected !== 3) failed.push(`auditSessions affected ${result.affected}, expected 3`);
  if (!Array.isArray(result.samples) || result.samples.length > 5) failed.push("samples must be a bounded array");
}

// ── 4) something affected keeps the check flag set and rescans each start ───
{
  const logged = [];
  const logger = { info: (line) => logged.push(line), warn() {} };
  if ((await readAuditRecord(dataDir)) !== null) failed.push("no record should exist before the first run");

  const first = await runAuditIfNeeded(dataDir, root, logger);
  if (first.affected !== 3 || first.scanned !== 5) failed.push(`first run recorded ${JSON.stringify(first)}`);
  if (first.check !== true) failed.push("an affected result must keep the check flag set");
  if (!existsSync(join(dataDir, AUDIT_FILE))) failed.push("the audit record was not written");

  // Fix one of the three: the flag stays set and the next start rescans, so the
  // count stays honest while the problem is real.
  await rm(fileA, { force: true });
  const second = await runAuditIfNeeded(dataDir, root, logger);
  if (second.affected !== 2) failed.push(`a second start must rescan: affected=${second.affected}`);
  if (second.check !== true) failed.push("still affected, so the check flag must stay set");
  if (logged.length !== 2) failed.push(`expected two audit log lines, got ${logged.length}`);
}

// ── 5) a clean scan retires the flag silently ──────────────────────────────
{
  await rm(fileB, { force: true });
  await rm(fileF, { force: true });
  const logged = [];
  const logger = { info: (line) => logged.push(line), warn() {} };
  const clean = await runAuditIfNeeded(dataDir, root, logger);
  if (clean.affected !== 0) failed.push(`expected a clean scan, got ${JSON.stringify(clean)}`);
  if (clean.check !== false) failed.push("a clean scan must retire the check flag");
  const stored = JSON.parse(await readFile(join(dataDir, AUDIT_FILE), "utf8"));
  if (stored.check !== false) failed.push("the retired flag was not persisted");
  if (stored.scanned !== 2) failed.push(`the retired record must keep its result, got scanned=${stored.scanned}`);

  // A retired flag short-circuits: no scan, no log line, and the record is left
  // exactly as the retiring run wrote it.
  const before = logged.length;
  const again = await runAuditIfNeeded(dataDir, root, logger);
  if (again.check !== false) failed.push("a retired check must stay retired");
  if (logged.length !== before) failed.push(`a retired check must not scan, but logged ${logged.length - before} more line(s)`);
  if (JSON.parse(await readFile(join(dataDir, AUDIT_FILE), "utf8")).checkedAt !== stored.checkedAt) {
    failed.push("a retired check must not rewrite the record");
  }
}

// ── 6) a machine with no legacy logs at all retires immediately ────────────
{
  const emptyRoot = join(tmp, "empty-sessions");
  await mkdir(join(emptyRoot, "proj"), { recursive: true });
  const emptyData = join(tmp, "empty-data");
  const logged = [];
  const record = await runAuditIfNeeded(emptyData, emptyRoot, { info: (line) => logged.push(line), warn() {} });
  if (record.scanned !== 0 || record.affected !== 0) failed.push(`empty root must scan nothing, got ${JSON.stringify(record)}`);
  if (record.check !== false) failed.push("a machine with no legacy logs must retire the check");
}

// ── 7) a missing sessions root is not fatal ────────────────────────────────
{
  const result = await auditSessions(join(tmp, "no-such-root"));
  if (result.scanned !== 0 || result.affected !== 0) failed.push(`missing root must yield an empty audit, got ${JSON.stringify(result)}`);
}

await rm(tmp, { recursive: true, force: true });

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("SESSION AUDIT SMOKE FAILED");
  process.exit(1);
}
console.log("SESSION AUDIT SMOKE PASSED");
