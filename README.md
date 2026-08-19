# Capability (能力库) — dsh-skill-mcp-manager

A **host-level [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin** that turns Skills and MCP servers into a visual, manageable, injectable catalog.

Three tiers per MCP server:

| Tier | At session start | Model calls it via |
|---|---|---|
| `eager` | connect + register native tools | `mcp__<server>__<tool>` |
| `on-demand` | no connection, catalog summary only | `mcp_load` → `mcp_call` bridge |
| `disabled` | hidden | — |

The on-demand bridge keeps the model-facing tool-schema set **constant** (no KV-prefix invalidation): the model never sees a native schema, only the small, fixed `mcp_load` / `mcp_call` / `mcp_register` tools.

## Install

```bash
dsh plugin --profile web add dsh-skill-mcp-manager
```

Then add one row to that profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: skill-mcp-manager
      name: 'dsh-skill-mcp-manager'
      config:
        dataDir: ''        # empty = ~/.dsh/skill-mcp-manager
        profile: web
        trialTimeoutMs: 30000
        toolCallTimeoutMs: 60000
```

Restart the profile. The plugin lives in the Host composition, so its three tools become available to every session in that profile.

## Config

| Field | Default | Meaning |
|---|---|---|
| `dataDir` | `~/.dsh/skill-mcp-manager` | Registry/settings directory (`~/` is expanded). |
| `profile` | `web` | Profile whose `cordis.patch.yml` is reconciled. |
| `trialTimeoutMs` | `30000` | Trial-connection timeout used by `mcp_register` / `mcp_load`. |
| `toolCallTimeoutMs` | `60000` | Per `tools/call` timeout. |
| `catalogDescriptionMaxLength` | `500` | Truncation for the pre-step catalog. |
| `importNativeMcp` | `true` | On boot, import native `dsh-mcp-client` rows from `cordis.patch.yml` into the capability library (default on-demand; disabled when the native row is disabled) and take them over. |

> Takeover: with it enabled, native `dsh-mcp-client` rows are imported into the capability library and an id-targeted `disabled: true` override is appended, so the native client stops loading them — the capability library becomes the single entry point (three tiers, `mcp-catalog`, the "Capability" UI). Run `/mcp prepare-uninstall` before uninstalling to hand them back.

## Model-facing tools

### `mcp_register`

Add or modify an MCP entry. It trial-connects (30s) + lists tools, then persists to `registry.json`. Reuse it to change `tier` / parameters / `notes`. Only connection-contract changes re-connect; changing `notes` or downgrading to `disabled` skips the trial.

```text
mcp_register { name, description?, tier?, transport, command?, args?, env?, cwd?, url?, headers?, notes? }
```

- `tier` ∈ `eager` | `on-demand` | `disabled` (default `on-demand`)
- stdio: `command` + `args` (no shell) + `env` (literal or `$VAR`) + `cwd`
- streamable-http: `url` + `headers`

### `mcp_load { name, peek? }`

Load (or hot-reload) a server and return its full tool definitions. `peek: true` only reads the current snapshot / active connection — never connects, registers, or drops a live connection.

### `mcp_call { name, tool, args? }`

Invoke one on-demand tool through the bridge. The server must be loaded first; calling an unloaded server errors with "call `mcp_load` first". Pass structured `args` only — never shell text, never a temp file.

## Data

- `~/.dsh/skill-mcp-manager/registry.json` — authoritative registry (version 1, `entries[]`).
- `~/.dsh/skill-mcp-manager/settings.json` — plugin settings (`customRecursiveDirs`, etc.).
- Env values may be literals or `$VAR` references to the process environment.

## Status / roadmap

**Done (backend)**

- **M0**: `registry.json` + `mcp_register` / `mcp_load(peek)` / `mcp_call` + pre-step `mcp-catalog` injection + three tiers (eager / on-demand / disabled) + A/B channel.
- **M1**: recursive Skill provider (any-depth `<dir>/SKILL.md`, including the root itself) + frontmatter parsing + **watcher hot-reload** (no restart to pick up skill changes).
- **M2**: write-back reconcile (`disabled: true` shadow entries in `cordis.patch.yml`, so config survives uninstall) + `/prepare-uninstall` command (hand entries back to native dsh-mcp-client).

All of the above verified end-to-end in a real DSH (desktop profile).

**Done (Client UI)**

- "Capability (能力库)" section in Settings with Skills / MCP tabs.
- Skill management: frontmatter enable/disable switch, cross-platform delete (recycle bin), system-editor open; shipped/read-only skills are view-only.
- MCP management: tier switching, delete entry, details, secret masking, peek/load/disconnect.
- Commands: `/skills`, `/mcp` (text summaries in chat).

## License

MIT
