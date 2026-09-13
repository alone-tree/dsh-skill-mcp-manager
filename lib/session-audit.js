// One-off audit of legacy `mcp-catalog` session logs (2026-09-11 incident).
//
// Before 1.1.5 this plugin injected its MCP catalog under a source kind of its
// own — `{kind:"mcp-catalog", digest}` — which is not in the closed set of kinds
// the released v0 -> v3 migration edge audits message sources against. Every
// session written that way therefore refuses to open once DSH reaches 2.0.9:
//
//   failed to observe session "…": cannot safely transform unclassified message source
//
// 1.1.5 stops writing that shape, but that alone cannot rescue logs already on
// disk. This module only *detects* them so the UI can point at the repair guide
// (repo issue #2). It reads session logs and never writes to one; its only write
// is the plugin's own audit record.
//
// The whole mechanism is one boolean, `check`, in the record below:
//
//   check is false  -> do nothing at all; no scan, no notice
//   check is true   -> scan; then report only if something is affected, and if
//                      nothing is, silently retire the check
//
// There is no dismiss action and no UI control: an accidental click must never
// be able to hide the notice while the problem is real, and this is a one-off
// cleanup for a format change that can no longer happen, so it leaves no
// machinery behind. Retiring on a clean scan is what keeps a machine that has
// already been repaired — or one that never had legacy logs — from paying for a
// scan on every start.

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import zlib from "node:zlib";

const ZSTD_MAGIC = 0xfd2fb528;
/** The marker that identifies a legacy injection. */
const LEGACY_KIND = '"kind":"mcp-catalog"';
const AUDIT_FILE = "session-audit.json";
const AUDIT_SCHEMA = 1;
/**
 * How long the scan may hold the main thread before yielding.
 *
 * Frames are decoded synchronously on purpose. The async zstd API is 4-5x
 * slower here — every frame becomes a thread-pool round trip, and a legacy log
 * carries one frame per append batch (measured on-machine: 574 logs need 31s
 * synchronously, 72s at four-way async concurrency, 144s serially). Yielding
 * between files keeps the longest uninterrupted slice at a single log.
 */
const YIELD_INTERVAL_MS = 100;
/** How many affected session directories the record keeps for display. */
const SAMPLE_LIMIT = 5;

/** Legacy v0 log names. The current generation never runs the v0 -> v3 chain. */
const LEGACY_FILE_NAMES = ["session.jsonl.zstd", "session.jsonl"];

/**
 * Walk the session tree and collect the logs the migration path applies to.
 *
 * Only the released v0 names are collected: a `session.v<N>.jsonl[.zstd]` log is
 * already in a released current generation and is never migrated.
 * @param root - the sessions root (`<DSH_HOME>/sessions`).
 * @returns absolute paths, in directory order.
 */
export function collectLegacyCandidates(root) {
  const targets = [];
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return targets;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    let sessions;
    try {
      sessions = readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      for (const fileName of LEGACY_FILE_NAMES) {
        const path = join(projectPath, session.name, fileName);
        if (existsSync(path)) targets.push(path);
      }
    }
  }
  return targets;
}

/**
 * Slice one session log into its independent zstd frames (RFC 8878), without
 * decompressing any of them.
 *
 * The frame structure is needed because the decoders cannot be trusted with the
 * whole file: both `zstdDecompressSync` and the streaming decoder stop after the
 * first frame and silently return that frame alone (measured on-node: 574 logs
 * yield 135 KB total, one header line each, instead of 917 MB). The repair tool
 * in `tools/repair-legacy-sessions.mjs` carries the same parser — it has to stay
 * self-contained because the repair guide embeds its full source.
 * @param buf - complete file bytes.
 * @returns frame byte ranges, or null when the file is not scannable.
 */
function frameRanges(buf) {
  const frames = [];
  let pos = 0;
  while (pos < buf.length) {
    const start = pos;
    if (buf.length - pos < 4 || buf.readUInt32LE(pos) !== ZSTD_MAGIC) return null;
    pos += 4;
    const descriptor = buf[pos];
    pos += 1;
    if ((descriptor & 24) !== 0) return null;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    pos += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      if (pos + 3 > buf.length) return null;
      const blockHeader = buf.readUIntLE(pos, 3);
      pos += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      if (blockType === 3) return null;
      pos += blockType === 1 ? 1 : blockHeader >>> 3;
      if (pos > buf.length) return null;
      if (lastBlock) break;
    }
    if (checksum) pos += 4;
    if (pos > buf.length) return null;
    frames.push([start, pos]);
  }
  return frames;
}

/**
 * Does one legacy log carry a plugin injection from the affected era?
 *
 * Decoding stops at the first frame that contains the marker: injections are
 * written from the first pre-step onward, so an affected log answers almost
 * immediately. An unreadable or torn file counts as unaffected rather than
 * throwing in the startup path.
 * @param path - absolute path to a session log.
 * @returns whether the log needs the repair guide.
 */
export function hasLegacySource(path) {
  let raw;
  try {
    raw = readFileSync(path);
  } catch {
    return false;
  }
  if (!path.endsWith(".zstd")) {
    // `compression: 'none'` logs are plaintext lines.
    return raw.toString("utf8").includes(LEGACY_KIND);
  }
  const ranges = frameRanges(raw);
  if (ranges === null) return false;
  for (const [start, end] of ranges) {
    let text;
    try {
      text = zlib.zstdDecompressSync(raw.subarray(start, end)).toString("utf8");
    } catch {
      return false;
    }
    if (text.includes(LEGACY_KIND)) return true;
  }
  return false;
}

/**
 * Scan every legacy log once, yielding the main thread between logs.
 * @param root - the sessions root.
 * @returns `{scanned, affected, samples}`; `samples` holds session directory names.
 */
export async function auditSessions(root) {
  const targets = collectLegacyCandidates(root);
  let affected = 0;
  const samples = [];
  let sliceStartedAt = Date.now();
  for (const path of targets) {
    if (hasLegacySource(path)) {
      affected += 1;
      if (samples.length < SAMPLE_LIMIT) samples.push(basename(dirname(path)));
    }
    if (Date.now() - sliceStartedAt >= YIELD_INTERVAL_MS) {
      await new Promise((resolve) => setImmediate(resolve));
      sliceStartedAt = Date.now();
    }
  }
  return { scanned: targets.length, affected, samples };
}

/**
 * Read the audit record.
 * @param dataDir - the plugin's data directory.
 * @returns the record, or null when the audit has never run.
 */
export async function readAuditRecord(dataDir) {
  try {
    const record = JSON.parse(await readFile(join(dataDir, AUDIT_FILE), "utf8"));
    return record?.schema === AUDIT_SCHEMA ? record : null;
  } catch {
    return null;
  }
}

/**
 * Write the audit record atomically.
 * @param dataDir - the plugin's data directory.
 * @param record - the record to store.
 */
async function writeAuditRecord(dataDir, record) {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, AUDIT_FILE);
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/**
 * Scan unless the `check` flag has already been retired.
 *
 * The flag is the whole mechanism, on purpose — this is a one-off cleanup for a
 * format change that can no longer happen, so it must not leave machinery
 * behind:
 *
 *  - `check` false: nothing to do, not even a scan.
 *  - `check` true: scan. Something affected keeps the flag true, so the notice
 *    re-appears on every start until it is dealt with; nothing affected retires
 *    the flag instead of reporting, which also stops the per-start cost for a
 *    machine that is already clean — a clean library scans *slower*, because a
 *    log with no marker cannot be abandoned after a frame or two.
 *
 * A scan that throws leaves the previous record untouched, so the check is
 * retried on the next start.
 * @param dataDir - the plugin's data directory.
 * @param sessionsRoot - the sessions root.
 * @param logger - the host logger.
 * @returns the audit record that now applies, or null when none exists yet.
 */
export async function runAuditIfNeeded(dataDir, sessionsRoot, logger) {
  const existing = await readAuditRecord(dataDir);
  if (existing !== null && existing.check === false) return existing;
  const startedAt = Date.now();
  const { scanned, affected, samples } = await auditSessions(sessionsRoot);
  const record = {
    schema: AUDIT_SCHEMA,
    check: affected > 0,
    checkedAt: new Date().toISOString(),
    scanned,
    affected,
    samples,
  };
  await writeAuditRecord(dataDir, record);
  logger.info(
    `skill-mcp-manager: session audit scanned ${scanned} legacy log(s), ${affected} affected in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
  return record;
}

export { AUDIT_FILE, LEGACY_KIND };
