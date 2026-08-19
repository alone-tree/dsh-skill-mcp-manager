# Capability (能力库) — dsh-skill-mcp-manager

> Turn DSH Skills and MCP servers into a **visual, manageable, injectable** capability library — one place to see, control, and serve them to the model.

A host-level [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. It gives you a settings page to manage every Skill and MCP server, and a lean, digest-driven catalog that tells the model what it can do — without bloating the tool schema.

## Screenshots

| SKILL management | MCP management |
| --- | --- |
| ![SKILL 管理](docs/screenshot-skills.png) | ![MCP 管理](docs/screenshot-mcp.png) |

## Why Capability

- **Single entry point.** Settings → **Capability**, with **SKILL** and **MCP** tabs: enable/disable skills, open them in your system editor, delete them (recycle bin); switch MCP tiers, inspect tools, mask/reveal secrets, delete entries. No more hand-editing `cordis.patch.yml` for MCP.
- **On-demand bridge, zero prefix invalidation.** On-demand MCP servers never register native schemas into the model's tool set — the model only ever sees three small fixed tools (`mcp_load` / `mcp_call` / `mcp_register`), so the KV prefix stays stable across the whole session.
- **Boot-time takeover of native MCPs.** On startup the plugin imports every `@deepseek-ai/dsh-mcp-client` row from the profile's `cordis.patch.yml` into its registry (on-demand by default; already-disabled rows stay disabled) and appends an id-targeted `disabled: true` override, so the native client stops loading them. One restart and the capability library becomes the single source of truth.
- **Auto warm-up.** Entries without a cached snapshot are connected once at boot to capture real tool names and descriptions, so the catalog is useful from the very first session.
- **Server metadata, captured for free.** The initialize handshake's `name / version / title / description / website / instructions / capabilities` are stored per entry and surfaced in `mcp_load`.
- **Three tiers per MCP server.**

| Tier | At session start | Model calls it via |
| --- | --- | --- |
| `eager` | connect + register native tools | `mcp__<server>__<tool>` |
| `on-demand` | no connection, catalog summary only | `mcp_load` → `mcp_call` bridge |
| `disabled` | hidden | — |

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

> **Takeover note:** with `importNativeMcp: true` (default), native `dsh-mcp-client` rows are imported into the capability library and disabled at the native layer — the capability library becomes the single entry point (three tiers, `mcp-catalog`, the UI). Before uninstalling the plugin, run `/mcp prepare-uninstall` to hand the entries back to the native client.

## Usage

### In the UI

Open **Settings → Capability**:

- **SKILL tab** — every managed skill (bundle `SKILL.md`) sorted by path: model-visibility switch (writes `disable-model-invocation`), open in system editor, cross-platform delete. Skills shipped with the deployment (under `node_modules` / `app.asar`) are **read-only**: view + open only.
- **MCP tab** — every registered server with tier badges, tool counts and connection state: switch tier, inspect details (command/env/headers/tools), mask/reveal secrets, load / peek / disconnect, delete entries. A setting row lets you adjust the **tool-description truncation** used by the catalog (default 150 chars).

### Model-facing tools

#### `mcp_register`

Add or modify an MCP entry. It trial-connects (30s) + lists tools, then persists to `registry.json`. The server's own description/version/title/website/instructions are captured automatically during the trial connection. Reuse it to change `tier` / parameters / `notes`. Only connection-contract changes re-connect; changing `notes` or downgrading to `disabled` skips the trial.

```text
mcp_register { name, tier?, transport, command?, args?, env?, cwd?, url?, headers?, notes? }
```

- `tier` ∈ `eager` | `on-demand` | `disabled` (default `on-demand`)
- stdio: `command` + `args` (no shell) + `env` (literal or `$VAR`) + `cwd`
- streamable-http: `url` + `headers`
- `notes` is a **user-maintained note** — never overwritten by developer/server updates.

#### `mcp_load { name, peek? }`

Load (or hot-reload) a server and return its full tool definitions plus the server-declared metadata. `peek: true` only reads the current snapshot / active connection — never connects, registers, or drops a live connection.

#### `mcp_call { name, tool, args? }`

Invoke one on-demand tool through the bridge. The server must be loaded first; calling an unloaded server errors with "call `mcp_load` first". Pass structured `args` only — never shell text, never a temp file.

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| `dataDir` | `~/.dsh/skill-mcp-manager` | Registry/settings directory (`~/` is expanded). |
| `profile` | `web` | Profile whose `cordis.patch.yml` is reconciled. |
| `trialTimeoutMs` | `30000` | Trial-connection timeout used by `mcp_register` / `mcp_load`. |
| `toolCallTimeoutMs` | `60000` | Per `tools/call` timeout. |
| `catalogDescriptionMaxLength` | `500` | Truncation for the server description in the catalog. |
| `toolDescriptionMaxLength` | `150` | Truncation for each tool's **description** in the catalog (tool names are always shown in full). Adjustable in the UI (Settings → Capability → MCP). |
| `importNativeMcp` | `true` | On boot, import native `dsh-mcp-client` rows into the capability library and take them over. |

## Data

- `~/.dsh/skill-mcp-manager/registry.json` — authoritative MCP registry (version 1, `entries[]`).
- `~/.dsh/skill-mcp-manager/settings.json` — plugin settings (`customRecursiveDirs`, `toolDescriptionMaxLength`, …).
- `~/.dsh/skill-mcp-manager/trash.log` — delete audit.
- Env values may be literals or `$VAR` references to the process environment.

## Roadmap / status

**Done & verified end-to-end on a real DSH (desktop profile):**

- M0 — `registry.json` + `mcp_register` / `mcp_load(peek)` / `mcp_call` + pre-step `mcp-catalog` injection + three tiers + A/B channel (eager native / on-demand bridge).
- M1 — recursive Skill provider (any-depth `<dir>/SKILL.md`) + frontmatter parsing + watcher hot-reload (no restart).
- M2 — write-back reconcile (disabled shadow entries in `cordis.patch.yml`) + `/prepare-uninstall`.
- M3 — Client UI: the Capability settings section, SKILL/MCP management, secret masking, read-only guard for shipped skills.
- Native MCP import + takeover at boot.
- Boot warm-up (auto-fetch tool snapshots for entries without a cache).
- Server metadata capture (name/version/title/description/website/instructions/capabilities) surfaced in `mcp_load` and the UI.
- Tool descriptions in the catalog with adjustable truncation.

**Planned / future:** resources & prompts support (server `capabilities` are already recorded), per-entry notes editing in the UI, `warmUpTimeoutMs` config.

## License

MIT
