// One-off legacy session audit (lib/session-audit.js): detects sessions written
// before the 1.1.5 source-format fix so the UI can point at the repair guide.
// It is read-only by design — the only file it writes is its own record.
// Isolated temp root, no network, no real profile, no real sessions.

import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
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

// ── 8) the audit must stay OUT of the startup path ─────────────────────────
// Regression guard for 2026-09-14, which broke DSH twice: awaiting the scan
// inside apply() held `host-boot` open past the desktop host's ~120s watchdog,
// and a `setTimeout(..., 8000)` still fired inside that same window, because
// plugin load happens early in boot. Both put the app into safe mode. Whether
// the scan is scheduled from the startup path is invisible to every other test,
// so this one watches for the observable consequence: after apply() returns, NO
// scan may run on its own — not immediately, and not on any timer short enough
// to have been the old one.
{
  const startupHome = join(tmp, "startup-home");
  const startupSession = join(startupHome, "sessions", "--proj--", "session-legacy");
  await mkdir(startupSession, { recursive: true });
  await writeFile(join(startupSession, "session.jsonl.zstd"), makeLog([
    JSON.stringify({ type: "session", version: 0, id: "session-legacy", createdAt: 0 }),
    event(1, { kind: "mcp-catalog", digest: "x" }),
  ]));

  // DSH_HOME is read when lib/index.js is evaluated, so set it before importing.
  process.env.DSH_HOME = startupHome;
  const startupData = join(tmp, "startup-data");
  const { apply } = await import(pathToFileURL("D:/Github/dsh-skill-mcp-manager/lib/index.js").href);
  const ctx = {
    tools: { register: () => () => {} },
    skills: { registerProvider: () => () => {} },
    on: () => () => {},
    effect: () => () => {},
    get: () => undefined,
    logger: { info() {}, warn() {}, error() {} },
  };
  // A real profile name, so the `__test__` skip does not hide the audit.
  await apply(ctx, { dataDir: startupData, profile: "startup-smoke", importNativeMcp: false });

  const recordPath = join(startupData, AUDIT_FILE);
  if (existsSync(recordPath)) failed.push("apply() ran the audit synchronously");
  // Watch past the old 8s delay: the startup path must schedule nothing at all.
  const quietUntil = Date.now() + 10000;
  while (Date.now() < quietUntil) {
    if (existsSync(recordPath)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (existsSync(recordPath)) failed.push("the startup path scheduled a scan; it must be request-triggered only");

  // The trigger itself still works, and only on request. The runner must also
  // report whether a scan is really in flight: the UI shows a wait notice for
  // that state and must never show one for a check that is already settled, or a
  // machine that will never scan again would wait forever.
  const { createAuditRunner, readAuditRecord: readRecord } = await import(pathToFileURL("D:/Github/dsh-skill-mcp-manager/lib/session-audit.js").href);
  const runner = createAuditRunner(startupData, join(startupHome, "sessions"), { info() {}, warn() {} });
  if (runner.running()) failed.push("a runner must not report a scan before anything asked for one");
  const started = runner.kick();
  if (started?.started !== true) failed.push(`kick() must report that it started work, got ${JSON.stringify(started)}`);
  if (!runner.running()) failed.push("kick() must report a scan in flight until the answer lands");
  await runner.wait();
  if (runner.running()) failed.push("a settled scan must not stay in flight");
  if (!existsSync(recordPath)) {
    failed.push("kicking the runner did not produce a record");
  } else {
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    if (record.affected !== 1 || record.check !== true) failed.push(`request-triggered audit recorded ${JSON.stringify(record)}`);
  }

  // A retired check does no work at all — that is the state the UI reports as
  // settled-and-nothing-to-say, which is why "no record at all" has to stay
  // distinguishable from "still scanning".
  const retiredData = join(tmp, "retired-data");
  await mkdir(retiredData, { recursive: true });
  await writeFile(join(retiredData, AUDIT_FILE), JSON.stringify({ schema: 2, check: false, checkedAt: "2026-09-14T00:00:00.000Z", scanned: 0, affected: 0, samples: [] }), "utf8");
  const retired = createAuditRunner(retiredData, join(startupHome, "sessions"), { info() {}, warn() {} });
  retired.kick();
  await retired.wait();
  if (retired.running()) failed.push("a retired check must not report work in flight");
  const untouched = await readRecord(retiredData);
  if (untouched?.check !== false || untouched?.checkedAt !== "2026-09-14T00:00:00.000Z") {
    failed.push(`a retired check must not rewrite its record, got ${JSON.stringify(untouched)}`);
  }
}

// ── 9) the notice contract ─────────────────────────────────────────────────
// The client bundle cannot be rendered here, so this pins the contract it has
// with the host and the one behaviour that must not regress: the "no sessions
// affected" reassurance is told once per browser session, never on every load.
{
  const source = await readFile("D:/Github/dsh-skill-mcp-manager/client/client.js", "utf8");
  const must = [
    ["the running state", /data\.scanning === true/],
    ["the settled state", /audit\.done !== true/],
    ["the wait notice", /能力库正在检查/],
    ["the wait notice dismiss control", /setCheckClosed\(true\)/],
    ["the problem result", /有 \$\{affected\} 个历史会话无法查看/],
    ["the all-clear result", /没有会话受影响，请放心使用/],
    ["told-once bookkeeping", /dsh-skill-mcp-manager:result-shown/],
  ];
  for (const [what, pattern] of must) {
    if (!pattern.test(source)) failed.push(`client.js no longer carries ${what}`);
  }
  if (!source.includes("本次不再显示") || !source.includes("知道了")) {
    failed.push("a host change replaced the close control, but the copy was not updated with it");
  }
  if (/\bpending\b/.test(source)) {
    failed.push("client.js still relies on `pending`; the host reports `scanning` and `done` now");
  }
}

// ── 10) a schema-1 record is migrated, never discarded ─────────────────────
// Discarding it makes the next run rescan; a scan heavy enough to be killed
// mid-flight records nothing, so the machine would rescan on every start
// forever — which is how the 2026-09-14 schema bump became a boot loop.
{
  const legacyData = join(tmp, "legacy-data");
  await mkdir(legacyData, { recursive: true });
  const legacyPath = join(legacyData, AUDIT_FILE);
  const base = { schema: 1, checkedAt: "2026-09-11T09:22:45.388Z", scanned: 577, affected: 3, samples: [] };

  await writeFile(legacyPath, JSON.stringify({ ...base, dismissedAt: "2026-09-11T09:31:41.469Z" }), "utf8");
  const dismissed = await readAuditRecord(legacyData);
  if (dismissed?.check !== false) failed.push(`a dismissed schema-1 record must migrate to check:false, got ${JSON.stringify(dismissed)}`);

  await writeFile(legacyPath, JSON.stringify({ ...base, dismissedAt: null }), "utf8");
  const open = await readAuditRecord(legacyData);
  if (open?.check !== true) failed.push(`an undismissed schema-1 record must migrate to check:true, got ${JSON.stringify(open)}`);

  await writeFile(legacyPath, "not json", "utf8");
  if ((await readAuditRecord(legacyData)) !== null) failed.push("an unreadable record must read as absent");
}

await rm(tmp, { recursive: true, force: true });

if (failed.length > 0) {
  for (const item of failed) console.log("FAIL:", item);
  console.log("SESSION AUDIT SMOKE FAILED");
  process.exit(1);
}
console.log("SESSION AUDIT SMOKE PASSED");
