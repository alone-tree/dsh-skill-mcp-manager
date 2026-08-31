# 能力库 (Capability) —— dsh-skill-mcp-manager

[English](README.md) | [简体中文](README.zh.md)

一站式SKILL和MCP管理器，面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**宿主级插件，并提供MCP工具按需加载功能，再也不用担心MCP工具太多浪费token啦**

## 页面截图

MCP 管理
![MCP 管理](docs/screenshot-mcp.png)

SKILL 管理
![SKILL 管理](docs/screenshot-skills.png)

## 核心特性

### 1. 一站式可视化管理

安装了哪些 Skill **和** MCP？是否启用？每个SKILL和MCP是什么？都在设置页直接查看，**不用层层翻找**。前端页面直接管理MCP和Skill启停、删除，支持点击SKILL查看原文（使用本地默认的md阅读器）。每个 MCP 工具也可单独启用或禁用，禁用后 AI 无法调用，不影响同服务器的其他工具。

### 2. MCP 按需加载（核心功能，花了好多心思打磨）

会话开始时，on-demand 服务器只暴露**名字 + 简短工具描述**。AI 知道每个工具的存在和功能，但看不到完整 schema。因此：

- **在token账单和完整上下文之间平衡**——只暴露MCP管理器，其他都需要调用工具查看。这会导致AI意识不到有这个东西，进而不会去主动查看有哪些工具可用。但把完整参数发送给AI，又会导致上下文膨胀。本插件将MCP和SKILL一视同仁，提供基础的名字+描述，让AI自己选择调用。
- **没有启动延迟**——服务器只在 AI 真正需要时才连接；
- **不会加载失败导致不可用**——按需加载，失败了非致命（可重试 / 稍后重载）。

### 3. 会话内 MCP 热重载

改了自己的本地 MCP 服务器？在会话里 `mcp_load` 一下即可——重连、重拉工具、新快照。**无需新开会话、无需重启 DSH，对MCP开发极度友好。**

### 4. SKILL 多层扫描、外接库、临时隐藏

- **任意深度递归**发现 `<dir>/SKILL.md`——支持连接任意数量的外部技能库目录、支持任意层深度，因此可以进行灵活的SKILL分组。插件只扫描 `<dir>/SKILL.md`，避免把文件夹里的其他文档也扫进来，比如readme.md、reference.md、备份文件.md
- 关闭某技能 = 模型不可见（写 `disable-model-invocation`），但你的 `/name` 斜杠命令**照常可用**。
- 点击删除后整个 `<dir>/` 文件夹移动到回收站。必要时可以恢复。

## 其他辅助特征

为了让各位能用的顺手、放心，本插件还有以下设计

### 5. 原生 MCP 配置接管，卸载不丢

安装时自动接管原有MCP配置：把 profile 里所有 `@deepseek-ai/dsh-mcp-client` 条目导入注册表并接管（默认按需加载；原本禁用的保持禁用）。

卸载安全：本插件在新增MCP后，会在原有配置文件同步写入MCP配置，但保持禁用。`/mcp prepare-uninstall` 会将禁用的MCP转为启用，把每条托管条目连同完整配置交还原生客户端。不会因为删除插件而丢失MCP配置。

### 6. 每个 MCP 都能写你的备注

给任意MCP附加一条用户备注，会话目录里会展示给 AI，并且**不被服务器/开发者更新覆盖**。你可以写“A插件挂了就用B插件作为替补”

### 7. 自动预热

安装后插件会连接一次、抓取真实工具名与描述，目录立刻可用。每次加载MCP后都会自动更新缓存。

### 8. 注册自动校验

`mcp_register` 会**先试连 + 列工具，通过才持久化**——只有配置正确的服务器才会被放行。

### 9. 只管理所在 profile

插件只管理它安装进的 profile——不越权、不错位。

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
        profile: web           # 要用在哪里就写哪个 profile
        trialTimeoutMs: 30000
        toolCallTimeoutMs: 60000
        catalogDescriptionMaxLength: 500
        toolDescriptionMaxLength: 150   # 目录里每条工具的描述截断长度（允许手动修改）
        importNativeMcp: true           # boot 时接管原生 dsh-mcp-client 条目
```

重启 profile 生效。插件挂在宿主组合里，工具对该 profile 下所有会话可见。

> **接管说明**：`importNativeMcp: true`（默认）时，原生 `dsh-mcp-client` 条目会被导入能力库并在原生层禁用——能力库成为唯一入口（三档、`mcp-catalog`、UI）。卸载插件前先跑 `/mcp prepare-uninstall` 交还条目。

## 使用

### 界面

打开 **设置 → 能力库**：

- **SKILL tab** —— 所有托管技能（bundle 型 `SKILL.md`）按路径排序：模型可见性开关、系统编辑器打开、跨平台删除。部署自带技能（`node_modules` / `app.asar` 下）为**只读**：仅查看 + 打开。
- **MCP tab** —— 所有已注册服务器（档位徽标、工具数）：切档位、查详情（命令 / env / headers / 工具）、逐工具“启用/禁用”（黑名单，新工具默认启用）、密钥打码/显示、查看描述、刷新快照、删除条目。刷新快照只试连并更新注册表，不留下运行实例。禁用工具不向 AI 暴露，并在实际调用入口强制拒绝。顶部设置行可调目录的**工具描述截断长度**（默认 150 字符）。

### 模型工具面

插件会提供三个恒定小工具，以管理所有的按需加载MCP。

- **`mcp_register`** —— 新增或修改 MCP 条目。试连（30s）+ 列出工具后持久；服务器自报的描述 / 版本 / 标题 / 网站 / 说明自动抓取。可复用它改档位 / 参数 / 备注；只有改连接契约才重连。

  ```text
  mcp_register { name, tier?, transport, command?, args?, env?, cwd?, url?, headers?, notes? }
  ```

  `tier` ∈ `eager` | `on-demand` | `disabled`（默认 `on-demand`）。`notes` 是用户维护、不被开发者更新MCP所覆盖。
- **`mcp_load { name, peek? }`** —— 加载 / 热重载服务器，返回完整工具定义 + 服务器自报元信息。`peek: true` 只读快照，不连接、不掉线，用于当AI忘记MCP工具参数时偷看一眼而不打断MCP工具的生命进程。对于浏览器控制等需要连续操作的MCP尤其友好。
- **`mcp_call { name, tool, args? }`** —— 调用某个 on-demand 工具（需先 `mcp_load`）。只传结构化 `args`，不传 shell 文本、不写临时文件。

## 配置

| 字段                            | 默认                         | 含义                                                               |
| ------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `dataDir`                     | `~/.dsh/skill-mcp-manager` | 注册表/设置目录（`~/` 会展开）。                                 |
| `profile`                     | `web`                      | 要 reconcile 的 profile。                                          |
| `trialTimeoutMs`              | `30000`                    | `mcp_register` / `mcp_load` 的试连超时。                       |
| `toolCallTimeoutMs`           | `60000`                    | 单次 `tools/call` 超时。                                         |
| `catalogDescriptionMaxLength` | `500`                      | 目录里服务器描述的截断长度。                                       |
| `toolDescriptionMaxLength`    | `150`                      | 目录里每条工具描述的截断长度（工具名始终完整显示）。可在 UI 调整。 |
| `importNativeMcp`             | `true`                     | boot 时导入原生 `dsh-mcp-client` 条目到能力库并接管。            |

## 数据

- `~/.dsh/skill-mcp-manager/registry.json` —— 权威 MCP 注册表（version 1，`entries[]`）。
- `~/.dsh/skill-mcp-manager/settings.json` —— 插件设置（`customRecursiveDirs`、`toolDescriptionMaxLength` 等）。
- `~/.dsh/skill-mcp-manager/trash.log` —— 删除审计。
- env 值可为明文或 `$VAR` 进程环境变量引用。

## 未来方向

- **支持 MCP Resources & prompts** —— 当前只支持MCP的工具调用，后期会扩充MCP协议中的其他内容支持。
- UI 内编辑每条MCP备注（notes）。
- UI 内查看和编辑SKILL。

## License

MIT
