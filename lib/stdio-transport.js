// Resilient stdio client transport for the MCP TypeScript SDK.
//
// Wire behaviour is identical to the SDK's StdioClientTransport (cross-spawn,
// newline-delimited JSON-RPC over stdin/stdout, same close ladder). The one
// deliberate difference is what happens when a single incoming message
// exceeds the read-buffer limit: the SDK transport throws from its read
// buffer, fires onerror and closes — so one oversized tool response (e.g. a
// server that inlines base64 images into one reply) kills the whole
// connection and every in-flight call fails with "-32000 Connection closed".
//
// This transport keeps the connection alive instead:
//   1. the moment a message is known to exceed the limit, only its first
//      kilobyte is kept (enough to recover the JSON-RPC id) and the rest is
//      drained up to the next newline, so memory peaks at the limit, not at
//      the message size, and the byte stream stays aligned;
//   2. a synthetic JSON-RPC error response (code -32603, with the received
//      size and the limit in `data`) is fed to onmessage once the drain
//      completes, so exactly the one waiting call fails with a structured,
//      actionable error;
//   3. notifications (no id, `"method"` in the prefix) and messages whose id
//      cannot be recovered are dropped without a synthetic reply — nothing
//      can be waiting on them by id.
//
// There is no ceiling on maxBufferSize beyond the SDK's own semantics: the
// official parameter is an unvalidated number, and this plugin does not
// invent an extra limit on top of it.
//
// MAINTENANCE: this file mirrors SDK 1.30.0's client/stdio.js. When upgrading
// @modelcontextprotocol/sdk, diff this file against the official
// dist/esm/client/stdio.js — fixes there do not propagate here. The e2e
// section of test/stdio-transport-smoke.mjs drives a real SDK Client through
// this transport and must be run in a real terminal (it self-skips under
// sandboxes that forbid piped subprocesses).

import process from "node:process";
import { PassThrough } from "node:stream";
import spawn from "cross-spawn";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/sdk/shared/stdio.js";

/**
 * Environment variables to inherit by default, if an environment is not
 * explicitly given. Mirrors the SDK (sudo-inspired list, Windows-safe).
 */
const DEFAULT_INHERITED_ENV_VARS = process.platform === "win32"
    ? [
        "APPDATA",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PROCESSOR_ARCHITECTURE",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "USERNAME",
        "USERPROFILE",
        "PROGRAMFILES",
      ]
    : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

function getDefaultEnvironment() {
  const env = {};
  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    const value = process.env[key];
    if (value === undefined) continue;
    if (value.startsWith("()")) continue; // security risk, same as the SDK
    env[key] = value;
  }
  return env;
}

const NEWLINE = 10; // "\n"
const ID_HEAD_BYTES = 1024; // prefix kept from an oversized message for id recovery
const OVERSIZED_CODE = -32603;

export function resolveMaxBufferSize(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : STDIO_DEFAULT_MAX_BUFFER_SIZE;
}

export class ResilientStdioTransport {
  constructor(server = {}) {
    this._serverParams = server;
    this._maxBufferSize = resolveMaxBufferSize(server.maxBufferSize);
    this._process = undefined;
    this._stderrStream = null;
    // Read state. `_buffer` holds buffered stream bytes between messages
    // (normal mode). When a message is known to exceed the limit, `_draining`
    // turns on and incoming bytes are counted (`_drained`) instead of stored
    // until the framing newline; the id is recovered from `_oversizeHead`.
    this._buffer = undefined;
    this._draining = false;
    this._drained = 0;
    this._oversizeHead = undefined;
    this._oversizePrefixBytes = 0;
    this.onclose = undefined;
    this.onerror = undefined;
    this.onmessage = undefined;
  }

  /** The resolved byte limit used for oversized-message decisions. */
  get maxBufferSize() {
    return this._maxBufferSize;
  }

  get stderr() {
    if (this._stderrStream) return this._stderrStream;
    return this._process?.stderr ?? null;
  }

  async start() {
    if (this._process) throw new Error("ResilientStdioTransport already started!");
    return new Promise((resolve, reject) => {
      this._process = spawn(this._serverParams.command, this._serverParams.args ?? [], {
        // Merge default env with server env because the MCP server needs some env vars.
        env: {
          ...getDefaultEnvironment(),
          ...this._serverParams.env,
        },
        stdio: ["pipe", "pipe", this._serverParams.stderr ?? "inherit"],
        shell: false,
        windowsHide: process.platform === "win32",
        cwd: this._serverParams.cwd,
      });
      this._process.on("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      this._process.on("spawn", () => resolve());
      this._process.on("close", () => {
        this._process = undefined;
        this.onclose?.();
      });
      this._process.stdin?.on("error", (error) => this.onerror?.(error));
      this._process.stdout?.on("data", (chunk) => this._onData(chunk));
      this._process.stdout?.on("error", (error) => this.onerror?.(error));
      if ((this._serverParams.stderr === "pipe" || this._serverParams.stderr === "overlapped") && this._process.stderr) {
        this._stderrStream = new PassThrough();
        this._process.stderr.pipe(this._stderrStream);
      }
    });
  }

  async close() {
    if (this._process) {
      const processToClose = this._process;
      this._process = undefined;
      const closePromise = new Promise((resolve) => {
        processToClose.once("close", () => resolve());
      });
      try {
        processToClose.stdin?.end();
      } catch {
        // ignore
      }
      await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
      if (processToClose.exitCode === null) {
        try {
          processToClose.kill("SIGTERM");
        } catch {
          // ignore
        }
        await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
      }
      if (processToClose.exitCode === null) {
        try {
          processToClose.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    this._buffer = undefined;
    this._draining = false;
    this._drained = 0;
    this._oversizeHead = undefined;
    this._oversizePrefixBytes = 0;
  }

  send(message) {
    return new Promise((resolve) => {
      if (!this._process?.stdin) {
        throw new Error("Not connected");
      }
      const json = `${JSON.stringify(message)}\n`;
      if (this._process.stdin.write(json)) {
        resolve();
      } else {
        this._process.stdin.once("drain", resolve);
      }
    });
  }

  _onData(chunk) {
    if (this._draining) {
      const index = chunk.indexOf(NEWLINE);
      if (index === -1) {
        this._drained += chunk.length;
        return;
      }
      // Bytes up to the framing newline belong to the discarded message; the
      // newline itself is framing, not payload.
      this._drained += index;
      const rest = chunk.subarray(index + 1);
      this._finishDrain();
      if (rest.length === 0) return;
      this._buffer = rest;
    } else {
      this._buffer = this._buffer === undefined ? chunk : Buffer.concat([this._buffer, chunk]);
    }
    this._processReadBuffer();
  }

  _processReadBuffer() {
    while (this._buffer !== undefined) {
      const index = this._buffer.indexOf(NEWLINE);
      if (index === -1) {
        if (this._buffer.length > this._maxBufferSize) {
          // The oversized message is still arriving. Keep only the head for
          // id recovery and switch to counting mode; the synthetic error is
          // emitted once the framing newline arrives and the size is exact.
          this._oversizePrefixBytes = this._buffer.length;
          this._oversizeHead = Buffer.from(this._buffer.subarray(0, ID_HEAD_BYTES));
          this._buffer = undefined;
          this._draining = true;
          this._drained = 0;
        }
        break;
      }
      const line = this._buffer.subarray(0, index);
      this._buffer = this._buffer.subarray(index + 1);
      if (line.length > this._maxBufferSize) {
        this._emitOversizedError(Buffer.from(line.subarray(0, ID_HEAD_BYTES)), line.length);
        continue;
      }
      let message;
      try {
        message = JSON.parse(line.toString("utf8"));
      } catch (error) {
        this.onerror?.(error);
        continue;
      }
      this.onmessage?.(message);
    }
  }

  _finishDrain() {
    const received = this._oversizePrefixBytes + this._drained;
    const head = this._oversizeHead;
    this._draining = false;
    this._drained = 0;
    this._oversizePrefixBytes = 0;
    this._oversizeHead = undefined;
    if (head !== undefined) this._emitOversizedError(head, received);
  }

  _emitOversizedError(head, received) {
    const text = head.toString("utf8");
    // Notifications must never be answered; requests we cannot identify have
    // no safe reply either (the id may sit beyond the kept head). Drop them.
    if (/^\s*\{[\s\S]{0,64}?"method"\s*:/.test(text)) {
      console.error(`[skill-mcp-manager] stdio: dropped an oversized request/notification (${received} bytes) without reply`);
      return;
    }
    const idMatch = /^\s*\{[\s\S]{0,128}?"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+|null)/.exec(text);
    if (idMatch === null) {
      console.error(`[skill-mcp-manager] stdio: dropped an oversized message without a recoverable id (${received} bytes)`);
      return;
    }
    let id;
    try {
      id = idMatch[1].startsWith('"') ? JSON.parse(idMatch[1]) : idMatch[1] === "null" ? null : Number(idMatch[1]);
    } catch {
      return;
    }
    const limit = this._maxBufferSize;
    this.onmessage?.({
      jsonrpc: "2.0",
      id,
      error: {
        code: OVERSIZED_CODE,
        message:
          `oversized stdio response discarded: received ${received} bytes (${(received / 1048576).toFixed(1)} MB), ` +
          `over the maxBufferSize limit of ${limit} bytes (${(limit / 1048576).toFixed(0)} MB). The connection stays open. ` +
          `If this payload is legitimate, raise "stdioMaxBufferSizeMb" in the plugin settings, then mcp_load again.`,
        data: { received, limit },
      },
    });
  }
}
