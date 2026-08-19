# 能力库 (Capability) —— dsh-skill-mcp-manager

> 把 DSH 的 Skill 与 MCP 服务器变成"可视、可管、可注入"的能力库——一个地方看、控、喂给模型。

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**宿主级插件**：给你一个设置页管理所有 Skill 与 MCP 服务器，同时用一份**精简、digest 驱动**的目录告诉模型它能干什么——不撑爆工具 schema。

## 截图

| SKILL 管理 | MCP 管理 |
| --- | --- |
| ![SKILL 管理](docs/screenshot-skills.png) | ![MCP 管理](docs/screenshot-mcp.png) |

## 为什么用能力库

- **单一入口**。设置 → **能力库**，带 **SKILL / MCP** 两个 tab：技能启停、系统编辑器打开、跨平台删除（回收站）；MCP 档位切换、工具查看、密钥打码/显示、删除条目。MCP 再也不用手改 `cordis.patch.yml`。
- **on-demand 桥，前缀零失效**。按需 MCP 从不把原生 schema 注册进模型的工具集——模型永远只看到三个恒定小工具（`mcp_load` / `mcp_call` / `mcp_register`），整个会话 KV 前缀稳定。
- **boot 自动接管原生 MCP**。启动时把 profile 里所有 `@deepseek-ai/dsh-mcp-client` 条目导入注册表（默认 on-demand；原本 disabled 的保持 disabled），并追加 id 定向 `disabled: true` 覆盖行，让原生客户端不再加载。重启一次，能力库成为唯一入口。
- **自动预热**。没有缓存的条目在启动时连接一次、抓取真实工具名与描述，首会话目录就有内容。
- **服务器元信息，零成本抓到**。`initialize` 握手里的 `name / version / title / description / website / instructions / capabilities` 全部入库，`mcp_load` 与 UI 里都能看到。
- **每个 MCP 三档**。

| 档位 | 会话启动 | 模型调用方式 |
| --- | --- | --- |
| `eager`（常驻） | 连接 + 原生注册工具 | `mcp__<server>__<tool>` |
| `on-demand`（按需） | 不连接，只给目录概要 | `mcp_load` → `mcp_call` 桥 |
| `disabled`（关闭） | 隐藏 | — |

## 安装

```bash
dsh plugin --profile <profile> add dsh-skill-mcp-manager
```

再在该 profile 的 `cordis.patch.yml` 加一行（参考 [`cordis.patch.example.yml`](cordis.patch.example.yml)）：

```yaml
- insert:
    - id: skill-mcp-manager
      name: 'dsh-skill-mcp-manager'
      config:
        dataDir: ''            # 空 = ~/.dsh/skill-mcp-manager
        profile: web           # 要 reconcile 的 profile
        trialTimeoutMs: 30000
        toolCallTimeoutMs: 60000
        catalogDescriptionMaxLength: 500
        toolDescriptionMaxLength: 150   # 目录里每条工具的描述截断长度
        importNativeMcp: true           # boot 时接管原生 dsh-mcp-client 条目
```

重启 profile 生效。插件挂在宿主组合里，工具对该 profile 下所有会话可见。

> **接管说明**：`importNativeMcp: true`（默认）时，原生 `dsh-mcp-client` 条目会被导入能力库并在原生层禁用——能力库成为唯一入口（三档、`mcp-catalog`、UI）。卸载插件前先跑 `/mcp prepare-uninstall` 把条目交还原生。

## 使用

### 界面

打开 **设置 → 能力库**：

- **SKILL tab** —— 所有托管技能（bundle 型 `SKILL.md`）按路径排序：模型可见性开关（写 `disable-model-invocation`）、系统编辑器打开、跨平台删除。部署自带的技能（`node_modules` / `app.asar` 下）为**只读**：仅查看 + 打开。
- **MCP tab** —— 所有已注册服务器（档位徽标、工具数、连接状态）：切档位、查详情（命令/env/headers/工具）、密钥打码/显示、加载/查看描述/断开、删除条目。顶部还有一行设置，可调整目录用的**工具描述截断长度**（默认 150 字符）。

### 模型工具面

#### `mcp_register`

新增或修改 MCP 条目。试连（30s）+ `tools/list` 成功后写入 `registry.json`；服务器的描述/版本/标题/网站/说明在试连时自动抓取。可复用它改档位/参数/备注；只有改连接契约才重连，改 notes / 降 disabled 不试连。

```text
mcp_register { name, tier?, transport, command?, args?, env?, cwd?, url?, headers?, notes? }
```

- `tier` ∈ `eager` | `on-demand` | `disabled`（默认 `on-demand`）
- stdio：`command` + `args`（不经 shell）+ `env`（明文或 `$VAR`）+ `cwd`
- streamable-http：`url` + `headers`
- `notes` 是**用户维护的备注**——永不被开发者/服务器更新覆盖。

#### `mcp_load { name, peek? }`

加载（或热重载）一个服务器，返回完整工具定义 + 服务器自报元信息。`peek: true` 只读快照/活跃连接，不连接、不注册、不掉线。

#### `mcp_call { name, tool, args? }`

通过桥调用某个 on-demand 工具。必须先 `mcp_load`；未加载直接调用会报"请先 mcp_load"。只传结构化 `args`，不传 shell 文本、不写临时文件。

## 配置

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `dataDir` | `~/.dsh/skill-mcp-manager` | 注册表/设置目录（`~/` 会展开）。 |
| `profile` | `web` | 要 reconcile 的 profile。 |
| `trialTimeoutMs` | `30000` | `mcp_register` / `mcp_load` 的试连超时。 |
| `toolCallTimeoutMs` | `60000` | 单次 `tools/call` 超时。 |
| `catalogDescriptionMaxLength` | `500` | 目录里服务器描述的截断长度。 |
| `toolDescriptionMaxLength` | `150` | 目录里每条工具的**描述**截断长度（工具名始终完整显示）。可在 UI 调整（设置 → 能力库 → MCP）。 |
| `importNativeMcp` | `true` | boot 时导入原生 `dsh-mcp-client` 条目到能力库并接管。 |

## 数据

- `~/.dsh/skill-mcp-manager/registry.json` —— 权威 MCP 注册表（version 1，`entries[]`）。
- `~/.dsh/skill-mcp-manager/settings.json` —— 插件设置（`customRecursiveDirs`、`toolDescriptionMaxLength` 等）。
- `~/.dsh/skill-mcp-manager/trash.log` —— 删除审计。
- env 值可为明文或 `$VAR` 进程环境变量引用。

## 进度 / 路线

**已完成，并在真实 DSH（desktop profile）端到端验证：**

- M0 —— `registry.json` + `mcp_register` / `mcp_load(peek)` / `mcp_call` + pre-step `mcp-catalog` 注入 + 三档 + AB 通道（eager 原生 / on-demand 桥）。
- M1 —— 递归 Skill provider（任意深度只认 `<dir>/SKILL.md`）+ frontmatter 解析 + watcher 热生效（改 skill 不用重启）。
- M2 —— 回写 reconcile（`cordis.patch.yml` 写 `disabled: true` 影子条目）+ `/prepare-uninstall`。
- M3 —— Client UI：能力库设置页、SKILL/MCP 管理、密钥打码、shipped 技能只读护栏。
- 原生 MCP 导入 + 接管（boot）。
- boot 预热（自动抓取无缓存条目的工具快照）。
- 服务器元信息抓取（name/version/title/description/website/instructions/capabilities），`mcp_load` 与 UI 可见。
- 目录注入「工具名 + 描述」，截断长度可调。

**规划 / 未来**：resources & prompts 支持（服务器 `capabilities` 已入库）、UI 内编辑每条 `notes`、`warmUpTimeoutMs` 独立配置。

## License

MIT
