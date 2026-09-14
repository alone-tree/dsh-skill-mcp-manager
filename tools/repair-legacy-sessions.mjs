#!/usr/bin/env node
// One-off repair for historical DSH session logs written by dsh-skill-mcp-manager
// before 1.1.5.
//
// Symptom: after DSH Desktop 2.0.9 the session format became v3, and opening an
// older (v0) session runs the v0 -> v1 -> v2 -> v3 migration chain. The v2 -> v3
// edge audits every message source against a closed set of kinds, and the plugin
// used to write a kind of its own:
//
//   "source":{"kind":"mcp-catalog","digest":"…"}
//
// `mcp-catalog` is not in that set (nor may a `plugin` source carry `digest`), so
// the migration refuses the whole file:
//
//   failed to observe session "…": cannot safely transform unclassified message source
//
// This script rewrites only those source objects, in place, to the shape the
// kernel already models — `{"kind":"plugin","plugin":"dsh-skill-mcp-manager"}` —
// which every released migration edge admits.
//
// Two properties of the session log make this safe and make a naive rewrite wrong:
//
//  1. The log is a **concatenation of independently decodable zstd frames**, one
//     frame per durable append batch, and the first frame is required to be
//     exactly one header line. Decompressing the whole file and recompressing it
//     produces a single frame, which DSH rejects at cold start
//     ("corrupt Zstandard session log: first frame is not exactly one header line")
//     and can leave the app refusing to boot. So: split frames, recompress ONLY
//     the frames that contain a target line, and copy every other frame
//     byte-for-byte.
//  2. Frames are written with a content checksum. Recompressed frames are written
//     with node:zlib and the same checksum flag the writer uses.
//
// Older plugin versions wrote a wider source object
// (`{"kind":"mcp-catalog","form":"catalog","digest":"…","entries":[…]}`), so the
// replacement matches the whole `"source":{…}` object with a brace-aware scanner
// instead of a fixed pattern.
//
// Usage (dry run by default — nothing is written without --apply):
//
//   node repair-legacy-sessions.mjs                 # 只检查，不改任何文件
//   node repair-legacy-sessions.mjs --apply         # 备份后修复
//   node repair-legacy-sessions.mjs --apply --stamp 20260911-1800
//   node repair-legacy-sessions.mjs --cleanup-backups 20260911-1800
//
// Requires Node >= 22.15 / 23.8 / 24 (built-in zstd). No external tools, no
// network, no dependencies.

import { readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, unlinkSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

// ── constants ──────────────────────────────────────────────────────────────

const ZSTD_MAGIC = 0xfd2fb528;
/** The replacement source object, serialized exactly as JSON.stringify would. */
const NEW_SOURCE = '{"kind":"plugin","plugin":"dsh-skill-mcp-manager"}';
/** Marker that identifies a legacy plugin injection. */
const LEGACY_KIND = '"kind":"mcp-catalog"';
/** Same frame options the DSH session writer uses (checksum, default level). */
const FRAME_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const SESSIONS_ROOT = join(homedir(), ".dsh", "sessions");

// ── zstd framing (RFC 8878) ────────────────────────────────────────────────

/**
 * Split a session log into its independent zstd frames.
 * @param buf - complete file bytes.
 * @returns frame byte ranges, in file order.
 */
function splitFrames(buf) {
  const frames = [];
  let pos = 0;
  while (pos < buf.length) {
    const start = pos;
    if (buf.length - pos < 4) throw new Error(`truncated frame magic at byte ${pos}`);
    if (buf.readUInt32LE(pos) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${pos}`);
    pos += 4;
    const descriptor = buf[pos];
    pos += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${start}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    pos += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      if (pos + 3 > buf.length) throw new Error(`truncated block header at byte ${pos}`);
      const blockHeader = buf.readUIntLE(pos, 3);
      pos += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${pos - 3}`);
      pos += blockType === 1 ? 1 : blockSize; // RLE blocks store a single byte
      if (pos > buf.length) throw new Error(`block overruns the file at byte ${pos}`);
      if (lastBlock) break;
    }
    if (checksum) pos += 4;
    if (pos > buf.length) throw new Error(`frame overruns the file at byte ${pos}`);
    frames.push([start, pos]);
  }
  return frames;
}

/**
 * Decompress one complete frame and validate its checksum.
 * @param frame - the frame bytes.
 * @returns the frame plaintext.
 */
function frameText(frame) {
  return zlib.zstdDecompressSync(frame).toString("utf8");
}

/**
 * Compress one plaintext into a single independently decodable, checksummed frame.
 * @param text - JSONL bytes for one append batch.
 * @returns the complete encoded frame.
 */
function compressFrame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, "utf8"), FRAME_OPTIONS);
}

// ── source rewriting ───────────────────────────────────────────────────────

/**
 * Find the end of the JSON object that starts at `start` (which must be `{`),
 * respecting string literals and escapes.
 * @param text - the surrounding text.
 * @param start - index of the opening brace.
 * @returns index just past the matching `}`, or -1 when unbalanced.
 */
function matchBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * Rewrite every legacy `source` object in one text run.
 *
 * A quoted mention of the legacy marker inside a message body is not matched:
 * JSON escapes the quotes there (`\"source\":{`), so the `"source":{` key form
 * only occurs at real object positions.
 * @param text - one frame plaintext, or a whole log's plaintext.
 * @returns `{ok:true, text, count}` or `{ok:false, reason}`.
 */
function rewriteSources(text) {
  let out = "";
  let index = 0;
  let count = 0;
  for (;;) {
    const at = text.indexOf('"source":{', index);
    if (at < 0) {
      out += text.slice(index);
      break;
    }
    const open = at + '"source":'.length;
    const end = matchBrace(text, open);
    if (end < 0) return { ok: false, reason: "unbalanced source object" };
    const objectText = text.slice(open, end);
    if (!objectText.includes(LEGACY_KIND)) {
      out += text.slice(index, end);
      index = end;
      continue;
    }
    // Replace the whole object and re-validate the enclosing JSONL line, so a
    // mis-scoped replacement can never reach the disk.
    const lineStart = text.lastIndexOf("\n", at) + 1;
    let lineEnd = text.indexOf("\n", end);
    if (lineEnd < 0) lineEnd = text.length;
    const originalLine = text.slice(lineStart, lineEnd);
    const patchedLine =
      originalLine.slice(0, open - lineStart) + NEW_SOURCE + originalLine.slice(end - lineStart);
    const valid = validateLine(originalLine, patchedLine);
    if (valid !== true) return { ok: false, reason: valid };
    out += text.slice(index, open) + NEW_SOURCE;
    index = end;
    count += 1;
  }
  return { ok: true, text: out, count };
}

/**
 * Assert one line survives the rewrite unchanged apart from the source value.
 *
 * Both lines must be canonical JSON.stringify output, which is what the session
 * writer produces; a hand-edited or otherwise non-canonical line is refused
 * rather than silently reformatted.
 * @param originalLine - the line as stored.
 * @param patchedLine - the line after the substitution.
 * @returns `true`, or a reason string.
 */
function validateLine(originalLine, patchedLine) {
  let original;
  let patched;
  try {
    original = JSON.parse(originalLine);
  } catch (error) {
    return `original line is not JSON: ${String(error)}`;
  }
  try {
    patched = JSON.parse(patchedLine);
  } catch (error) {
    return `patched line is not JSON: ${String(error)}`;
  }
  if (JSON.stringify(original) !== originalLine) return "original line is not canonical JSON";
  if (JSON.stringify(patched) !== patchedLine) return "patched line is not canonical JSON";
  if (JSON.stringify(original) === JSON.stringify(patched)) return "substitution changed nothing";
  return true;
}

// ── per-file repair ────────────────────────────────────────────────────────

/**
 * Repair one session log file.
 * @param path - absolute path to `session.jsonl.zstd` (or a plaintext log).
 * @param options - `{apply, stamp}`.
 * @returns a result record.
 */
function repairFile(path, options) {
  const name = basename(path);
  const raw = readFileSync(path);
  const isPlain = !name.endsWith(".zstd");

  if (isPlain) {
    // `compression: 'none'` logs are newline-separated plaintext; same rewrite,
    // no framing to preserve.
    const text = raw.toString("utf8");
    const result = rewriteSources(text);
    if (!result.ok) return { status: "aborted", reason: result.reason };
    if (result.count === 0) return { status: "clean", count: 0 };
    if (options.apply) {
      backup(path, options.stamp);
      writeFileSync(path, result.text, "utf8");
    }
    return { status: "patched", count: result.count };
  }

  let ranges;
  try {
    ranges = splitFrames(raw);
  } catch (error) {
    return { status: "aborted", reason: `frame scan failed: ${String(error.message ?? error)}` };
  }
  const originalFrames = ranges.map(([start, end]) => raw.subarray(start, end));
  const plaintexts = [];
  const lineCounts = [];
  for (const frame of originalFrames) {
    let text;
    try {
      text = frameText(frame);
    } catch (error) {
      return { status: "aborted", reason: `frame decode failed: ${String(error.message ?? error)}` };
    }
    plaintexts.push(text);
    lineCounts.push(text.split("\n").length - 1);
  }
  const joined = plaintexts.join("");

  const whole = rewriteSources(joined);
  if (!whole.ok) return { status: "aborted", reason: whole.reason };
  if (whole.count === 0) return { status: "clean", count: 0 };

  const patchedFrames = [];
  let frameTotal = 0;
  for (const [frameIndex, text] of plaintexts.entries()) {
    const result = rewriteSources(text);
    if (!result.ok) return { status: "aborted", reason: `frame ${frameIndex}: ${result.reason}` };
    frameTotal += result.count;
    patchedFrames.push(result.count > 0 ? result.text : undefined);
  }
  // A source object spanning a frame boundary would be patched twice or not at
  // all; the counts disagreeing is how that shows up.
  if (frameTotal !== whole.count) {
    return { status: "aborted", reason: `source object spans frames (whole=${whole.count} frames=${frameTotal})` };
  }

  const next = Buffer.concat(
    originalFrames.map((frame, index) => (patchedFrames[index] === undefined ? frame : compressFrame(patchedFrames[index]))),
  );

  const problem = verify(raw, next, whole.text, lineCounts);
  if (problem !== true) return { status: "aborted", reason: problem };

  if (options.apply) {
    backup(path, options.stamp);
    writeFileSync(path, next);
  }
  return { status: "patched", count: whole.count, frames: originalFrames.length };
}

/**
 * Re-read the produced bytes and prove the only difference is the rewrite.
 * @param before - original file bytes.
 * @param after - produced file bytes.
 * @param expected - the plaintext the frames must decode to.
 * @param lineCounts - per-frame line counts of the original.
 * @returns `true`, or a reason string.
 */
function verify(before, after, expected, lineCounts) {
  let beforeFrames;
  let afterFrames;
  try {
    beforeFrames = splitFrames(before);
    afterFrames = splitFrames(after);
  } catch (error) {
    return `re-read failed: ${String(error.message ?? error)}`;
  }
  if (beforeFrames.length !== afterFrames.length) {
    return `frame count changed (${beforeFrames.length} -> ${afterFrames.length})`;
  }
  // The first frame holds the header line and must stay byte-identical.
  const [beforeFirst] = beforeFrames;
  const [afterFirst] = afterFrames;
  if (!before.subarray(...beforeFirst).equals(after.subarray(...afterFirst))) {
    return "the header frame changed";
  }
  const texts = [];
  for (const [index, [start, end]] of afterFrames.entries()) {
    let text;
    try {
      text = frameText(after.subarray(start, end));
    } catch (error) {
      return `re-read frame ${index} failed: ${String(error.message ?? error)}`;
    }
    const lines = text.split("\n").length - 1;
    if (lines !== lineCounts[index]) return `frame ${index} line count changed (${lineCounts[index]} -> ${lines})`;
    texts.push(text);
  }
  const actual = texts.join("");
  if (actual !== expected) return "re-read plaintext differs from the expected rewrite";
  if (actual.includes(LEGACY_KIND)) return "legacy marker still present after the rewrite";
  return true;
}

/**
 * Copy a file aside before its first write in this run.
 * @param path - the original path.
 * @param stamp - backup suffix.
 */
function backup(path, stamp) {
  const target = `${path}.bak-${stamp}`;
  if (existsSync(target)) throw new Error(`backup already exists, refusing to overwrite: ${target}`);
  copyFileSync(path, target);
}

// ── session tree walk ──────────────────────────────────────────────────────

/**
 * Collect the session logs this repair applies to.
 *
 * Only v0 logs matter: `.dsh/sessions/<project>/<session>/session.jsonl[.zstd]`.
 * The current generation (`session.v<N>.jsonl[.zstd]`) never runs the v0 -> v3
 * migration chain, so it is left alone.
 * @param root - sessions root.
 * @returns absolute paths, in directory order.
 */
function collectTargets(root) {
  const targets = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    for (const session of readdirSync(projectPath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const sessionPath = join(projectPath, session.name);
      for (const candidate of ["session.jsonl.zstd", "session.jsonl"]) {
        const path = join(sessionPath, candidate);
        if (existsSync(path)) targets.push(path);
      }
    }
  }
  return targets;
}

/**
 * Delete the backups a previous run left behind.
 * @param root - sessions root.
 * @param stamp - the backup suffix to remove.
 * @returns number of files removed.
 */
function cleanupBackups(root, stamp) {
  let removed = 0;
  for (const path of collectTargets(root)) {
    const target = `${path}.bak-${stamp}`;
    if (!existsSync(target)) continue;
    unlinkSync(target);
    removed += 1;
  }
  return removed;
}

// ── entry point ────────────────────────────────────────────────────────────

/**
 * Parse argv into `{apply, stamp, root, cleanup}`.
 * @returns the options, or `{help:true}`.
 */
function parseArgs(argv) {
  const options = { apply: false, stamp: undefined, root: SESSIONS_ROOT, cleanup: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--root") options.root = argv[++index];
    else if (arg === "--stamp") options.stamp = argv[++index];
    else if (arg === "--cleanup-backups") options.cleanup = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function stampNow() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`参数错误：${String(error.message ?? error)}\n用 --help 查看用法。`);
    process.exit(2);
  }
  if (options.help) {
    console.log(readFileSync(new URL(import.meta.url)).toString("utf8").split("\n").slice(0, 46).filter((line) => line.startsWith("//")).map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }
  if (!existsSync(options.root)) {
    console.error(`会话根目录不存在：${options.root}`);
    process.exit(2);
  }

  if (options.cleanup !== undefined) {
    const removed = cleanupBackups(options.root, options.cleanup);
    console.log(`已删除备份 ${removed} 个（后缀 .bak-${options.cleanup}）。`);
    return;
  }

  const stamp = options.stamp ?? stampNow();
  const startedAt = Date.now();
  const targets = collectTargets(options.root);
  const summary = { patched: [], clean: 0, aborted: [] };
  let occurrences = 0;

  for (const path of targets) {
    // A file about to be read while DSH holds it open is fine; a file DSH is
    // mid-append on would fail its own readback check and be reported, not
    // half-written. Close DSH before applying if any file reports torn bytes.
    let result;
    try {
      result = repairFile(path, { apply: options.apply, stamp });
    } catch (error) {
      result = { status: "aborted", reason: String(error.message ?? error) };
    }
    if (result.status === "patched") {
      summary.patched.push(path);
      occurrences += result.count;
    } else if (result.status === "clean") {
      summary.clean += 1;
    } else {
      summary.aborted.push({ path, reason: result.reason });
    }
  }

  const mode = options.apply ? "已应用" : "试运行（未写入任何文件）";
  console.log(`\n模式：${mode}`);
  console.log(`备份后缀：.bak-${stamp}`);
  console.log(`扫描 v0 会话日志：${targets.length}`);
  console.log(`需要修复：${summary.patched.length}（共 ${occurrences} 处 source）`);
  console.log(`无需修复：${summary.clean}`);
  console.log(`中止：${summary.aborted.length}`);
  console.log(`耗时：${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);
  for (const item of summary.aborted.slice(0, 30)) console.log(`  - ${item.path}\n    ${item.reason}`);
  if (summary.aborted.length > 30) console.log(`  …还有 ${summary.aborted.length - 30} 个`);
  if (summary.patched.length > 0) {
    console.log("\n受影响文件（前 20 个）：");
    for (const path of summary.patched.slice(0, 20)) console.log(`  ${path}`);
    if (summary.patched.length > 20) console.log(`  …还有 ${summary.patched.length - 20} 个`);
  }
  if (!options.apply && summary.patched.length > 0) {
    console.log(`\n确认无误后执行：node ${basename(process.argv[1])} --apply --stamp ${stamp}`);
  }
  if (options.apply) {
    console.log(`\n验证通过后删除备份：node ${basename(process.argv[1])} --cleanup-backups ${stamp}`);
    console.log("验证方法：重启 DSH 并逐个打开原先报错的会话。");
  }
  if (summary.aborted.length > 0) process.exit(1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { splitFrames, frameText, compressFrame, rewriteSources, validateLine, repairFile, verify, collectTargets, cleanupBackups, NEW_SOURCE, LEGACY_KIND };
