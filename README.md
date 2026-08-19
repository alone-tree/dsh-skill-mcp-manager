# Capability (能力库) — dsh-skill-mcp-manager

> Manage DSH Skills and MCP servers from one visual page — and only ever let the model see what it needs.

A host-level [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that turns Skills and MCP servers into a **visual, manageable, injectable** capability library.

## Screenshots

| SKILL management | MCP management |
| --- | --- |
| ![SKILL 管理](docs/screenshot-skills.png) | ![MCP 管理](docs/screenshot-mcp.png) |

## Core features

### 1. One-stop management, one plugin
Skills **and** MCP servers live in a single Settings page — no two separate plugins. Toggle a skill's model-visibility, delete it to the recycle bin, open it in your system editor; switch an MCP's tier, inspect its tools, mask its secrets, delete it. MCP configuration no longer requires hand-editing `cordis.patch.yml`.

### 2. Skills: deep scan, external libraries, temporary hide
- Recursively discovers `<dir>/SKILL.md` at **any depth** — point the plugin at an external skill library and every skill under it appears automatically.
- Hide a skill from the model (writes `disable-model-invocation`) while your own `/name` slash command **still works** — a temporary hide, not a deletion.

### 3. MCP on-demand loading — the core idea
At session start an on-demand server exposes only its **name + short tool descriptions**. The AI knows each tool exists and what it does, without the full schemas. That means:

- **no context bloat** — schemas never enter the request header;
- **no startup latency** — the server connects only when the AI actually needs it;
- **no failed-load dead end** — loading is on demand, and a failed load is non-fatal (retry or reload later).

### 4. MCP hot reload
Updated your own local MCP server? `mcp_load` it right in the session — reconnect, re-list tools, fresh snapshot. **No new session, no DSH restart.**

### 5. Native MCP config takeover — nothing lost on uninstall
On install, the plugin imports every `@deepseek-ai/dsh-mcp-client` row from the profile's `cordis.patch.yml` into its registry (on-demand by default; already-disabled stays disabled) and takes them over. Uninstall is safe: `/mcp prepare-uninstall` hands every managed entry back to the native client with its full config.

### 6. Your note on every MCP
Attach a user note to any server; it is surfaced to the AI in the session catalog and is **never overwritten** by server/developer updates.

### 7. Auto warm-up
After install, the plugin connects once to fetch real tool names and descriptions, so the catalog is immediately useful — then stays cached.

### 8. Profile-scoped
The plugin only manages the profile it is installed into — no cross-profile overreach.

### 9. Validated registration
`mcp_register` trial-connects and lists tools **before** persisting — only correctly configured servers are admitted.

## Install

```bash
dsh plugin --profile <profile> add dsh-skill-mcp-manager
```

Then add one row to that profile's `cordis.patch.yml` (see [`cordis.patch.example.yml`](cordis.patch.example.yml)):

```yaml
- insert:
    - id: skill-mcp-manager
      name: 'dsh-skill-mcp-manager'
      config:
        dataDir: ''            # empty = ~/.dsh/skill-mcp-manager
        profile: web           # the profile whose cordis.patch.yml this plugin reconciles
        trialTimeoutMs: 30000
        toolCallTimeoutMs: 60000
        catalogDescriptionMaxLength: 500
        toolDescriptionMaxLength: 150   # per-tool description truncation in the catalog
        importNativeMcp: true           # take over native dsh-mcp-client rows on boot
```

Restart the profile. The plugin lives in the Host composition, so its tools become available to every session in that profile.

> **Takeover note:** with `importNativeMcp: true` (default), native `dsh-mcp-client` rows are imported into the capability library and disabled at the native layer — the capability library becomes the single entry point (three tiers, `mcp-catalog`, the UI). Run `/mcp prepare-uninstall` before uninstalling to hand the entries back.

## Usage

### In the UI

Open **Settings → Capability**:

- **SKILL tab** — every managed skill (bundle `SKILL.md`), sorted by path: model-visibility switch, open in system editor, cross-platform delete. Skills shipped with the deployment (under `node_modules` / `app.asar`) are read-only: view + open only.
- **MCP tab** — every registered server with tier badges, tool counts and connection state: switch tier, inspect details (command / env / headers / tools), mask or reveal secrets, load / peek / disconnect, delete entries. A setting row adjusts the catalog's **tool-description truncation** (default 150 chars).

### Model-facing tools

Three small, fixed tools — the model never sees the native schemas of on-demand servers.

- **`mcp_register`** — add or modify an MCP entry. Trial-connects (30s) + lists tools, then persists. The server's own description / version / title / website / instructions are captured automatically. Reuse it to change tier / parameters / notes; only connection-contract changes re-connect.
  ```text
  mcp_register { name, tier?, transport, command?, args?, env?, cwd?, url?, headers?, notes? }
  ```
  `tier` ∈ `eager` | `on-demand` | `disabled` (default `on-demand`). `notes` is user-maintained and never overwritten.
- **`mcp_load { name, peek? }`** — load / hot-reload a server and get its full tool definitions + server-declared metadata. `peek: true` only reads the snapshot, never connects or drops a live connection.
- **`mcp_call { name, tool, args? }`** — invoke one on-demand tool through the bridge (must `mcp_load` first). Structured `args` only — never shell text, never a temp file.

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| `dataDir` | `~/.dsh/skill-mcp-manager` | Registry/settings directory (`~/` is expanded). |
| `profile` | `web` | Profile whose `cordis.patch.yml` is reconciled. |
| `trialTimeoutMs` | `30000` | Trial-connection timeout used by `mcp_register` / `mcp_load`. |
| `toolCallTimeoutMs` | `60000` | Per `tools/call` timeout. |
| `catalogDescriptionMaxLength` | `500` | Truncation for the server description in the catalog. |
| `toolDescriptionMaxLength` | `150` | Truncation for each tool's description in the catalog (tool names always shown in full). Adjustable in the UI. |
| `importNativeMcp` | `true` | On boot, import native `dsh-mcp-client` rows into the capability library and take them over. |

## Data

- `~/.dsh/skill-mcp-manager/registry.json` — authoritative MCP registry (version 1, `entries[]`).
- `~/.dsh/skill-mcp-manager/settings.json` — plugin settings (`customRecursiveDirs`, `toolDescriptionMaxLength`, …).
- `~/.dsh/skill-mcp-manager/trash.log` — delete audit.
- Env values may be literals or `$VAR` references to the process environment.

## Future directions

- **Resources & prompts** — server `capabilities` are already recorded at connect time; wiring them up is the next step.
- **Editing notes in the UI.**
- **Per-session / per-agent MCP scoping** — today eager servers register host-globally (matching the built-in client); per-agent scoping is a future direction.

## License

MIT
