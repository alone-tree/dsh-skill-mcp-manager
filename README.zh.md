# dsh-skill-mcp-manager

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**宿主级插件**：把 MCP 服务器变成"可视、可管、可注入"的目录；Skill 管理在 M1 落地。

每个 MCP 服务器三档：

| 档位 | 会话启动 | 模型调用方式 |
|---|---|---|
| `eager`（常驻） | 连接 + 原生注册工具 | `mcp__<server>__<tool>` |
| `on-demand`（按需） | 不连接，只给目录概要 | `mcp_load` → `mcp_call` 桥 |
| `disabled`（关闭） | 隐藏 | — |

on-demand 桥让"模型可见工具 schema 集合"全程不变（**前缀零失效**）：模型只看到三个恒定小工具 `mcp_load` / `mcp_call` / `mcp_register`，看不到原生 schema。

## 安装

```bash
dsh plugin --profile web add dsh-skill-mcp-manager
```

再在该 profile 的 `cordis.patch.yml` 加一行：

```yaml
- insert:
    - id: skill-mcp-manager
      name: 'dsh-skill-mcp-manager'
      config:
        dataDir: ''        # 空 = ~/.dsh/skill-mcp-manager
        profile: web
        trialTimeoutMs: 30000
        toolCallTimeoutMs: 60000
```

重启 profile 生效。插件挂在宿主组合里，三件套工具对该 profile 下所有会话可见。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `dataDir` | `~/.dsh/skill-mcp-manager` | 注册表/设置目录（`~/` 会展开）。 |
| `profile` | `web` | 要 reconcile 的 profile。 |
| `trialTimeoutMs` | `30000` | `mcp_register` / `mcp_load` 的试连超时。 |
| `toolCallTimeoutMs` | `60000` | 单次 `tools/call` 超时。 |
| `catalogDescriptionMaxLength` | `500` | 目录描述截断长度。 |

## 模型工具面

### `mcp_register`

新增或修改 MCP 条目。试连（30s）+ `tools/list` 成功后写入 `registry.json`。可复用它改档位/参数/备注；只有改连接契约才重连，改 notes / 降 disabled 不试连。

```text
mcp_register { name, description?, tier?, transport, command?, args?, env?, cwd?, url?, headers?, notes? }
```

- `tier` ∈ `eager` | `on-demand` | `disabled`（默认 `on-demand`）
- stdio：`command` + `args`（不经 shell）+ `env`（明文或 `$VAR`）+ `cwd`
- streamable-http：`url` + `headers`

### `mcp_load { name, peek? }`

加载（或热重载）一个服务器并返回完整工具定义。`peek: true` 只读快照/活跃连接，不连接、不注册、不掉线。

### `mcp_call { name, tool, args? }`

通过桥调用某个 on-demand 工具。必须先 `mcp_load`；未加载直接调用会报"请先 mcp_load"。只传结构化 `args`，不传 shell 文本、不写临时文件。

## 数据

- `~/.dsh/skill-mcp-manager/registry.json` —— 权威注册表（version 1，`entries[]`）。
- `~/.dsh/skill-mcp-manager/settings.json` —— 插件设置（`customRecursiveDirs` 等）。
- env 值可为明文或 `$VAR` 进程环境变量引用。

## 进度 / 路线

**已完成（后端）**

- **M0**：`registry.json` + `mcp_register` / `mcp_load(peek)` / `mcp_call` + pre-step `mcp-catalog` 注入 + 三档（eager / on-demand / disabled）+ AB 通道。
- **M1**：递归 Skill provider（任意深度只认 `<dir>/SKILL.md`，含根入口）+ frontmatter 解析 + **watcher 热生效**（改 skill 不用重启）。
- **M2**：回写 reconcile（往 `cordis.patch.yml` 写 `disabled: true` 影子条目，卸载后配置不丢）+ `/prepare-uninstall` 命令（交还原生 dsh-mcp-client）。

以上均已通过真实 DSH（desktop profile）端到端验证。

**待做（Client UI）**

- SKILL 管理抽屉：frontmatter 启停 Switch、跨平台删除（回收站）、系统编辑器打开。
- MCP 管理抽屉：档位切换、删除条目、详情、密钥打码。
- 入口：`sidebar.footer.action` + `/skills`、`/mcp` 命令。

## License

MIT
