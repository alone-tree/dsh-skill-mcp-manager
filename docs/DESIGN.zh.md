# DSH Skill & MCP 管理插件 — 设计文档

> 版本：v1.0（讨论稿，全量整合）
> 已定决策：
> ① SKILL 启停走 frontmatter（`disable-model-invocation`）；② 本轮只出设计文档；③ 对齐 Hermes Agent 提案（NousResearch/hermes-agent #84225 / #71290 / #84195 / #84189，作者 alone-tree）；④ 注册表用 **JSON**（`registry.json` / `settings.json`），与系统配置**双写兜底**；⑤ 三档术语 **eager / on-demand / disabled**（不用 resident/off）；⑥ **AB 通道：eager 原生注册，on-demand 走 `mcp_call` 桥（前缀零失效）**；⑦ load=reload 合一，`mcp_load(peek)` 只查看描述；⑧ 启动不刷新，只有加载时刷新注册表；⑨ 只维护插件所在 profile；⑩ 每次启动 reconcile；⑪ add 成功即写系统配置兜底；⑫ 参数通道硬约束：结构化 JSON-RPC，禁止 shell 拼接；⑬ **模型工具面三件套：`mcp_register` / `mcp_load(peek)` / `mcp_call`**，删除/断开无工具（仅 UI，生命周期自动管理，**无空闲超时**）；⑭ **SKILL 零新增工具**；⑮ 递归扫描只见 `<dir>/SKILL.md`（不扫裸 md）；⑯ UI 按 SKILL 路径排序，用系统自带编辑器打开；⑰ 删除跨平台；⑱ 密钥允许明文或 `$VAR`；⑲ 其他插件的技能/工具默认不纳入本插件管理；⑳ on-demand→eager 升档**立即对所有存活会话生效**（各会话在自己的 `agent.ctx` 注册、一次前缀失效、UI 弹窗提示、无需二次确认）；㉑ MCP 单工具启停采用持久化 `disabledTools` 黑名单，新发现工具默认启用，禁用工具对模型完全隐藏且在原生/桥调用边界强制拒绝；㉒ MCP 运行实例按会话隔离，配置仍全局共享

---

## 1. 目标

宿主级插件，把 DSH 的 Skill 与 MCP 变成"可视、可管、可注入"：

- **Skill**：扫描原生 + 外接目录（递归，只认 `SKILL.md`）、按路径排序展示、系统编辑器打开、启用/关闭（frontmatter）、删除（跨平台，整个 SKILL 文件夹）；启用项会话开始注入"名字+描述"，变更后向历史末尾追加替换目录（不改历史、不破坏 KV 缓存）。
- **MCP**：AI 可注册（add 试连成功写 registry + 系统配置兜底）、三档、eager 原生注册 + on-demand `mcp_call` 桥（缓存零失效）、启动注入分档、load 按需加载/热重载 + peek 只读描述、生命周期自动管理、reconcile 保证配置不丢。

---

## 2. 现状盘点（已核实）

### 2.1 Skill（内建机制覆盖核心，缺口在管理面）

| 能力     | 内建件                                  | 说明                                                                                                                                                           |
| -------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注册表   | `ctx.skills`（dsh-skill）             | 分层合并、按名排序、`skills/change` 失效事件                                                                                                                 |
| 文件扫描 | dsh-skill-filesystem                    | 项目/自定义/用户根；`<name>/SKILL.md` bundle 与平铺 `<name>.md`；watcher；**只扫一层**（内建 provider 会发现平铺 `.md`，但本插件只管理 bundle 型） |
| 会话注入 | dsh-tool-skill                          | `agent/pre-step` 渲染持久 user 角色目录（name+截断描述）；digest 变化 → 向历史末尾**追加完整替换目录**（仅追加，KV 缓存友好）                         |
| 启停语义 | frontmatter`disable-model-invocation` | 排除出目录与`skill` 工具，文件仍在磁盘                                                                                                                       |
| 正文加载 | `skill` 工具                          | 对任意 provider 的技能按需加载正文                                                                                                                             |

**缺口**：递归多层扫描（对应 #71290）、frontmatter 写入校验、管理 UI、跨平台删除。

### 2.2 MCP（桥接已内建，管理面全缺）

| 能力       | 内建件                                      | 说明                                                                                                                                                                           |
| ---------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 客户端桥接 | dsh-mcp-client                              | stdio / streamable-http；`mcp__<name>__<tool>` 注册；自动重连（退避+预算+世代替换）；SDK 通道 = JSON-RPC over stdio + spawn 参数数组（不经 shell）；**无空闲超时机制** |
| 配置载体   | `profiles/{web,desktop}/cordis.patch.yml` | 静态实例（web：tavily/siyuan/a-stock-announcements/market-data/market-data-chart；desktop 另有 codegraph）                                                                     |

**缺口**：无动态注册、无三档、无会话注入、无管理 UI、无热重载。

---

## 3. 总体架构

### 3.1 部署位置

挂在插件所在 profile 的 `cordis.patch.yml`（本机当前 web 生效）。先 cordis_define 进程内原型（M0），验证后固化为可安装包 + patch 行。

### 3.2 插件组成

```
plugin: skill-mcp-manager
├── Host
│   ├── SkillManagerService    递归扫描 provider（只见 SKILL.md）/ 启停(frontmatter) / 删除(跨平台) / 系统编辑器打开
│   ├── McpRegistryService     registry.json / 试连 / 快照（仅加载时刷新）
│   ├── McpSystemConfigSync    系统配置 reconcile（仅所在 profile；add 成功即写兜底）
│   ├── McpRuntimeService      按会话的客户端生命周期（会话结束/dispose 断开，重连兜底，无空闲超时）
│   ├── McpBridge              mcp_call 桥：结构化参数通道 / JSON 容错 / 校验诊断
│   ├── ContextInjector        pre-step enter 注入引擎
│   ├── 工具                   mcp_register / mcp_load(peek) / mcp_call（三件套）
│   └── Client RPC              UI 能力：删除条目 / 刷新快照 / prepare-uninstall
└── Client
    ├── 抽屉：SKILL 管理（按路径排序；系统编辑器打开）
    ├── 抽屉：工具（MCP）管理
    └── 入口（sidebar.footer.action + /skills、/mcp 命令）
```

### 3.3 数据存储（`~/.dsh/skill-mcp-manager/`，JSON）

```
registry.json      # MCP 注册表（权威）
settings.json      # 插件设置（外接技能目录、注入预算等）
trash.log          # 删除审计
tmp/               # 插件内部临时文件（AI 不直接引用；无 args_file 概念）
```

- 只维护所在 profile；add 成功 → registry + 系统配置兜底；reconcile 每次启动执行。

---

## 4. Skill 模块设计

### 4.1 扫描与递归规则（已定）

- **原生目录**：复用内建 filesystem provider（`<dshHome>/skills` 等），UI 经 `ctx.skills.list({ scope })` 展示。内建 `dsh-skill-filesystem` 挂在 agent preset 层，不是本插件的全局层；管理页无当前 agent，要用 `agentPresets.standingKeyFor()` 作为 scope（与 host `skill.list` 冷读一致），否则只能看到本插件递归扫描的 Skill，看不到 `~/.dsh/skills` 里经 Junction 接入的条目（如 `capability-entry`）。
  - **仅管理 bundle 型（`<dir>/SKILL.md`）**：内建 provider 也会发现平铺 `<name>.md`，但本插件只认 bundle——平铺 `.md` 条目在 UI 中过滤不展示、不启停、不删除（避免把无关说明文档当技能管理）。
- **外接递归目录**：自建 provider（`ctx.skills.registerProvider`）：
  - 配置：`customRecursiveDirs`（settings.json），例如只加一个 `global-skills` 文件夹即自动递归扫描其下所有 skill。
  - **递归规则：任意深度下只认 `<dir>/SKILL.md`**；**不扫 `<dir>/<name>.md` 平铺文件**（避免把无关 md 当技能）。
  - 命名：相对路径 kebab-case（`tools/git/SKILL.md` → `tools-git`）；`name` 优先 frontmatter。
  - description：优先 frontmatter；缺失取正文首段前 200 字，UI 标记"自动生成"。
  - 调用策略：默认 `{ modelInvocable: true, userInvocable: true }`，尊重 frontmatter 覆盖。
  - 碰撞：递归 provider 的 rank 低于官方 filesystem provider；重名 UI 提示。
  - watcher：目录成员变化 → `control.invalidate()`。

### 4.2 展示与编辑（已定，简化为系统编辑器）

- **SKILL 管理抽屉**：列出所有 SKILL 的 **名字 / 描述 / 路径**，**按路径排序**（路径天然携带分组与递归层级信息，不做来源分组树、不显示"递归"标记）。
- **点击条目 → 用系统自带编辑器打开对应文件**（Host 侧 shell 打开：Windows `start`、macOS `open`、Linux `xdg-open`；走 `ctx.shell`/受限子进程）。**不做内置 md 阅读器/编辑器**（后期迭代）。
- 启停 Switch 仍内嵌在列表行（写 frontmatter，不需要打开编辑器）；修改正文则走系统编辑器。

### 4.3 模型可见性开关（frontmatter，已定）

- 关闭 → 写 `disable-model-invocation: true`；启用 → 删该键。写入校验：`name` kebab-case、`description` 非空、布尔字段类型正确，否则拒绝。
- 语义：只影响"模型是否可见/可调"，**不影响用户斜杠 `/name` 调用**（`user-invocable` 独立控制，本插件不动它）——因此是"模型可见性开关"，不是完整启停。
- 生效链路（全内建）：原子写 → watcher/`fs/observed` 失效 → pre-step 发现 digest 变化 → 追加替换目录（不改历史）。
- 持久全局；"仅本会话临时关闭"列 v2。

### 4.4 删除（跨平台，已定）

- **删除对象 = 整个 SKILL 文件夹**：`<dir>/SKILL.md` 及其 references/assets/scripts 等（一个 SKILL = 一个文件夹；平铺 `*.md` 不在扫描范围内故不涉及）。
- 平台策略：

| 平台            | 实现                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Windows         | `Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory(path, 'OnlyErrorDialogs', 'SendToRecycleBin')`（受限 PowerShell 执行） |
| macOS           | `osascript -e 'tell application "Finder" to delete POSIX file "<path>"'` 或 `mv` 到 `~/.Trash/`                             |
| Linux           | `gio trash <path>`（GLib，多数桌面环境内置）；无 `gio` 时 fallback 到插件 trash 目录或直接删除（设置项）                      |
| 无条件 fallback | 移动到`~/.dsh/skill-mcp-manager/trash/`（保留相对路径，可恢复）                                                                 |

- 安全：路径必须位于受管根内；`trash.log` 审计；删除在 UI 内二次确认。

### 4.5 注入与 token 预算

- 完全复用内建 `skill-catalog`；`catalogDescriptionMaxLength`（默认 500）UI 可调 + 截断标记（对齐 #84195）。

### 4.6 技能覆盖边界（其他插件的技能）

- 本插件**只扫描自己的根**（原生根 + `customRecursiveDirs`），**不会自动纳入其他插件的技能**。
- 其他插件注册的 runtime/embed 技能（无文件或文件在插件包内）无法用 frontmatter 启停/删除 → 一律不纳入管理，避免混乱。
- 若用户显式把某插件技能的目录加入 `customRecursiveDirs`，会扫描到并可能与插件自带注册重名——按技能注册表规则裁决（同层 rank / 近层胜），UI 提示冲突；v1 不推荐，文档说明即可。
- 其他插件的**工具**同理不纳入：它们不是 MCP 服务器，没有 MCP 生命周期/凭据，无法用三档管理（#84225 的"全工具分级"愿景列为远期，v1 仅 MCP）。

---

## 5. MCP 模块设计

### 5.1 注册表（`registry.json`）

```json
{
  "version": 1,
  "entries": [
    {
      "id": "github",
      "name": "github",
      "description": "GitHub 仓库与 issue 管理",
      "tier": "on-demand",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_xxxxxxxx" },
      "cwd": null, "url": null, "headers": {},
      "notes": "优先用 search 工具定位仓库",
      "systemEntryId": "mcp-github", "managed": true,
      "registeredAt": "...", "lastLoadAt": null, "lastSyncAt": null,
      "tools": [ { "name": "search", "description": "...", "inputSchema": {} } ],
      "disabledTools": ["delete_repository"]
    }
  ]
}
```

### 5.2 密钥策略（已放宽，已定）

- **明文与 `$VAR` 引用都允许**：值以 `$NAME` 开头视为进程环境变量引用，否则按字面值使用（某些 MCP 对变量引用不友好时可直接写值，避免 `$VAR` 引入 bug）。
- 注入内容**永不包含** key 值（只出现名字/描述/工具信息）；UI 默认打码显示敏感字段值（可切换"显示/隐藏"）。

### 5.3 工具：`mcp_register`（add 语义）

- 参数：`name`、`description`、`tier`(默认 on-demand)、`transport`、`command`/`args`/`env`/`cwd` 或 `url`/`headers`、`notes`。
- 时序：校验唯一性/命名/必填互斥 → **尝试加载**（试连 + `tools/list`，限时 30s）→ **成功**：写 registry（含快照）+ **同步写系统配置兜底实例**（§5.10）→ **失败**：返回报错给 AI，不写库、不写系统配置。
- 可复用本工具修改档位（tier）/参数/notes（见 §11 流程 6）。**试连范围**：改参数（command/args/env/url）→ 试连 30s + `tools/list`；升 eager → 试连 + 原生注册；改 notes / 降 disabled → 不试连。

### 5.4 三档语义（eager / on-demand / disabled）

| 档位                        | 会话启动                   | 注入内容                           | 调用方式                                  | token / 缓存                        |
| --------------------------- | -------------------------- | ---------------------------------- | ----------------------------------------- | ----------------------------------- |
| **eager（常驻）**     | 该会话连接 + 在 `agent.ctx` 原生注册全部工具 | 名字+描述+工具名+工具描述+参数概要 | 原生`mcp__<name>__<tool>`               | schema 每请求计入；前缀自首请求稳定 |
| **on-demand（按需）** | 不连接，只读 registry 快照 | 名字+描述+工具名（+notes）         | **`mcp_call` 桥**（加载后仍走桥） | 恒定小 schema；**前缀零失效** |
| **disabled（关闭）**  | 不加载、不注入             | 无                                 | —                                        | 无                                  |

- 档位为全局持久状态；运行实例按会话隔离。`mcp_load` 只加载/热重载当前会话的实例。
- 快照刷新时机：add 成功、修改成功、会话内 `mcp_load`、管理页「刷新快照」。启动预热与「刷新快照」都是一次性试连后关闭，不留下可被多会话复用的实例。
- 断开：**自动管理**——每个会话的连接保持到该会话结束/插件 dispose；断线由自动重连兜底；**无空闲超时**。管理页不再提供「已连接」或「断开」。
- **单工具黑名单**：每个条目用 `disabledTools: string[]` 持久保存禁用的原始工具名；服务器后续新增工具默认启用。管理页仍展示全部快照工具，工具名前提供“启用/禁用”二档下拉框。
- 禁用工具对模型完全隐藏：不进入 eager 原生注册、`mcp-catalog` 或 `mcp_load`/peek 返回；`mcp_call` 与 eager 工具 `execute` 入口均再次检查黑名单，防止模型根据历史名称或旧 schema 绕过。禁用不强制中断已经开始执行的调用，只拒绝之后的新调用。
- `mcp_register` 不暴露 `disabledTools` 参数，AI 不能通过模型工具修改黑名单；黑名单仅由管理 UI 修改。

### 5.5 运行时加载器

- 复用 `@modelcontextprotocol/sdk`；stdio / streamable-http；eager 条目在各会话的 `agent.ctx` 上原生注册 `mcp__<name>__<tool>`；会话销毁时随 Agent scope 清理。
- **作用域（已定）**：同一 MCP 配置在每个 DSH 会话（含子代理）各自创建、持有和销毁独立实例。stdio 各起子进程，HTTP 各建连接。配置（注册表、档位、黑名单、密钥、备注）全局共享。同一会话内保留现有并发语义。

### 5.6 AB 通道与调用（已定）

- **eager → 原生通道**：schema 进请求头、按 schema 生成参数、框架校验；前缀自首请求稳定。掉线/需重连时 AI 可 `mcp_load` 手动恢复（一次前缀失效，可接受）。
- **on-demand → `mcp_call` 桥**：load 后不注册原生 schema；前缀零失效。目录刻意只给"MCP 描述 + 工具名"（省 token，不含工具描述/参数 schema）——模型构造 args 前先 `mcp_load` 拿参数定义，再 `mcp_call`；未 load 直接 call 会报"请先 `mcp_load`"。
- on-demand → eager 升级**立即对所有存活会话生效**（各会话在自己的 `agent.ctx` 注册；运行中切换一次前缀失效，UI 弹窗提示、无需二次确认）。
- KV 影响总表（仅"模型可见工具 schema 集合运行中变化"会破坏一次前缀）：

| 会破坏（一次前缀失效）                         | 不会破坏（前缀稳定）                  |
| ---------------------------------------------- | ------------------------------------- |
| 中途 on-demand→eager 并运行中注册             | 启动即 eager 注册好的工具             |
| eager 中途`mcp_load` 重连/原生注册（可接受） | `mcp_call` 桥调用（schema 恒定）    |
| 热重载后工具描述/参数/数量变化                 | 全部注入消息 / 工具结果 / mcp-catalog |
| UI 删除已注册的 eager 条目 / 改 disabled       | `load(peek)`（不注册、不持久连接）  |

### 5.7 参数可靠性设计（mcp_call 桥加固）

**根因**：用户 Capability-Library 的"复杂 args 报错"，根因是 Windows 命令行/CLI 转义（参数经 shell 拼接被字符层破坏），不是模型拼错。Hermes 免疫：参数为结构化 JSON 经 JSON-RPC/stdin、spawn 参数数组不经 shell。DSH 的 MCP 通道同构（SDK `StdioClientTransport` = JSON-RPC over stdio），天然免疫，前提是守住约束：

1. **禁止 shell/命令行拼接**：`mcp_call` 只接受结构化 `args` 对象，内部永远 `JSON.stringify → client.callTool`；禁止把 args 拼进命令行、禁止 cmd/pwsh 字符串插值转发。
2. **spawn 层**：`spawn(command, argsArray, { shell:false })`；command 经 `subprocess.resolveExecutable` 白名单解析；Windows 特殊字符参数校验，必要时 `windowsVerbatimArguments`；env 对象直传；启动失败把命令与退出码结构化返回。
3. **JSON 容错修复**（借鉴 Hermes robust parsing）：收到字符串形态 args 先剥代码围栏、修尾逗号、修裸引号再 parse。
4. **schema 校验 + 纠错诊断**：调用前用注册表 `inputSchema`（zod/ajv）校验；失败返回 `{ ok:false, errors:[{path, expected, got, message}] }`。
5. **无 args 文件转存（AI 透明）**：args 直接以 JSON 传给 `client.callTool`（MCP = JSON-RPC over stdin，无 shell/argv 长度限制）；AI 永远只传结构化 `args`，**不写临时文件、不传 `args_file`**。
6. **错误规范化**：`{ ok, data | error }`；isError → 结构化错误；超时/断连 → 明确状态（自动重连兜底）。

| 维度             | 原生通道（eager）            | `mcp_call` 桥（on-demand）    |
| ---------------- | ---------------------------- | ------------------------------- |
| 参数可靠性       | 最高（schema 引导+框架校验） | 高（容错+校验诊断），略低于原生 |
| Windows 转义风险 | 无                           | 无（硬约束）                    |
| token（请求头）  | 全量 schema 每请求计入       | 恒定小 schema                   |
| 前缀缓存         | 启动稳定                     | 全程零失效                      |

### 5.8 模型工具面：三件套（已定）

- **`mcp_register`**：add / 改档位 / 改参数 / 备注（§5.3）。唯一配置变更点。
- **`mcp_load {name, peek?}`**（服务所有非 disabled 条目；**本身就是工具，调用即 return 该 MCP 的完整配置说明**——工具名/描述/参数，作为工具结果自然进对话，无需额外注入机制）：
  - `peek=false`（默认，加载/热重载）：未连接 → 连接 + listTools + 更新快照 + return 完整定义；已连接 → 热重载（断开→重连→listTools→世代替换→快照更新→return 新定义）。**再次调用即 reload，无需重启 DSH**。eager 条目 → 重连 + 原生注册（一次前缀失效，已接受）。热重载只是 load 对"已连接条目"的另一种行为，不是独立机制。
  - `peek=true`（只查看）：只读活跃连接或最新快照的工具描述，不注册、不建立持久连接、不重启生命周期（浏览器等状态敏感 MCP 不掉线）；快照缺失时一次性连接刷新后断开。**参数名定为 `peek`**。
- **`mcp_call {name, tool, args?}`**：on-demand 桥（§5.7）。**目标条目未加载（未 `mcp_load`）时，直接返回"该 MCP 未加载，请先 `mcp_load`"，不自动加载。**
- **无删除/断开工具**：删除（uninstall）仅 UI（§7）；断开自动管理（§5.4）。

### 5.9 启动注入（ContextInjector）

- `agent/pre-step` enter 模式，source kind `mcp-catalog`：eager 全量（名字+描述+工具名+工具描述+参数概要）；on-demand 概要（名字+描述+工具名+notes）。数据源 = registry 快照（只读不连接）；digest 驱动追加替换。是否已注入以会话 surface 上可见的 `mcp-catalog` 为准（对齐内建 `skill-catalog`）：压缩把旧目录移出 surface 后，即使 registry 未变也重新追加；不要用进程内 WeakMap 记住 digest。
- 参数概要预算：properties 键名 + 必填标记 + 单项描述截断（默认每工具 ≤ 300 字，settings.json 可调）。

### 5.10 系统配置 reconcile（防"删插件丢配置"，仅所在 profile）

> 1.1.1 起为**全量合并架构**：注册表是唯一事实源，托管块是它的编译产物，一个 MCP 在补丁里只有一行。

1. **吸收（adopt，全文扫描）**：启动时扫描**整个补丁文件**（托管块上方、内部、下方）的 `@deepseek-ai/dsh-mcp-client` insert 行，按**行 id（systemEntryId）**对账——没有任何条目认领的行被吸收为新条目（原生 `disabled: true` 则入 disabled 档）。名字（serverName）只作新条目的初始名，不参与对账，改名场景安全。`importNativeMcp: false` 时跳过吸收。
2. **托管块整体重生成**：注册表每一条目在托管块里恰好一行（`disabled: true`，配置由能力库驱动时该行不加载）；配置取吸收时的**原始 config（`rawConfig`）**并把 serverName 对齐到当前条目名，注册表原生条目则按字段模型合成。生成器对**重复 loader id 拒绝写盘**——同 id 双 insert 的"无法启动"故障从结构上不可能写出。
3. **托管块外零残留**：托管块外被认领的 dsh-mcp-client 行从原位置移除（空的 `- insert:` 块一并清理）；未认领行（`importNativeMcp: false` 等）保持原样。非 MCP 内容 byte-for-byte 保留，夹在托管标记之间的非 MCP 行挪到结束标记之后。写前备份 `.bak-<timestamp>`。
4. **回写时机**：每次启动 + 每次注册表变更（`mcp_register`、档位、单工具启停、删除）都会整体重生成托管块；`rawConfig` 在用户经 `mcp_register` 修改条目后丢弃，改按字段模型重生成（超出模型的字段以 `mcp_register` 契约为准）。
5. **卸载保障**（两个不同操作，勿混）：
   - **删除单个 MCP 条目**（UI"删除条目"）：整条从 `registry.json` 移除，托管块重生成后该行消失（补丁随注册表走）。
   - **卸载整个插件**：`/mcp prepare-uninstall` 把托管块整体替换为 HANDOVER 块——所有条目以**完整、启用**的 insert 写回（disabled 档保留 disabled），交还系统原生 dsh-mcp-client；原生无 on-demand 概念，交还后按 **eager** 加载，此为预期行为。若没跑 prepare-uninstall 就直接卸载插件，托管行以 `disabled: true` 残留（配置完整），手动去除即可恢复。SKILL 无需卸载处理（递归 provider 随插件消失）。
   - 插件临时禁用（stop）不触发任何恢复。

### 5.11 热重载总览

| 触发                  | 机制                                                       | 重启 DSH     |
| --------------------- | ---------------------------------------------------------- | ------------ |
| MCP 代码变化（stdio） | `mcp_load` 重连新生进程                                  | 否           |
| 工具列表/描述变化     | `mcp_load` → listTools → 世代替换 + 快照 + digest 追加 | 否           |
| 只看描述不动生命周期  | `mcp_load(peek=true)`                                    | 否（不掉线） |
| 插件自身更新          | 换包                                                       | 一次         |

---

## 6. 注入与 KV 缓存设计（统一原则）

1. 只追加不改写；digest 驱动；source kinds：`skill-catalog`（内建 `dsh-tool-skill`）、`mcp-catalog`（本插件）。两者都以会话 surface 上是否还有可见目录判断是否重注；压缩后旧目录不在 surface 上则重新追加。
2. 前缀失效仅发生在"模型可见工具 schema 集合运行中变化"（§5.6 总表）；注入消息永远只走尾部追加。

---

## 7. UI 设计（Slots）

- `settings.section` 两个抽屉页（root scope，replaceRisk=none）：
  - **SKILL 管理**：列表（名字 / 描述 / 路径，**按路径排序**）；行内启停 Switch；点击条目 → 系统编辑器打开（§4.2）；删除按钮（整个 SKILL 文件夹，跨平台回收站/trash，二次确认）；"添加外接目录"（`ctx.directoryPicker`）。
  - **工具（MCP）管理**：注册表列表（档位徽标、调用通道 Native/Bridge、工具数、notes、reconcile 状态）→ 详情（工具表格、描述、schema 查看、备注编辑、密钥打码/显示；每个工具名前有“启用/禁用”二档下拉框，启用为正常文字、禁用后下拉框/名称/描述变灰）→ "查看描述"(=peek 只读快照)、"刷新快照"（一次性试连并更新 registry，不留下实例）、档位切换（立即对存活会话生效；升级时弹窗提示"一次前缀失效"、无需二次确认）、**删除条目（仅 UI；= registry + patch 整条 entry 一起删，非翻 disabled、非只删一行）**、"/mcp prepare-uninstall"（= 卸载整个插件时交还原生）。
- 入口：`sidebar.footer.action` + `/skills`、`/mcp` 命令；状态同步经 RPC 推送。

---

## 8. 模型可见工具清单（完整体）

| 工具             | 用途                                                                                          | 备注                                      |
| ---------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `mcp_register` | add / 改档位（tier）/ 改参数 / 备注；试加载 → 写 registry + 系统配置兜底；失败报错           | 唯一配置变更点                            |
| `mcp_load`     | peek=false 加载/热重载（on-demand 供桥；eager 重连+原生注册）；peek=true 只查看参数描述不掉线 | 结果 = 完整定义（工具返回值，自然进对话） |
| `mcp_call`     | on-demand 桥（结构化参数/JSON 容错/校验诊断）                                      | eager 不经过此桥                          |

> 删除（uninstall）与断开（disconnect）**无模型工具**：断开自动管理（会话结束/dispose，无空闲超时）；删除仅 UI。
> SKILL：**零新增工具**（§4.6）——加载正文用内建 `skill` 工具，清单由内建目录注入，启停用 fs 工具或 UI Switch，编辑走系统编辑器。

---

## 9. 安全

- 路径校验：删除/编辑/扫描仅限受管根；拒绝路径穿越。
- 密钥：明文与 `$VAR` 均允许（§5.2）；注入不含 key；UI 默认打码可切换；registry.json 与 patch 拷贝加入 `.gitignore` 提示。
- 命令注入：`command` 白名单解析（`resolveExecutable`）；spawn 不经 shell。
- 单工具禁用：模型侧隐藏只是减少误用；真正的权限边界是 eager `execute` 和 `mcp_call` 在发出 MCP `tools/call` 前检查 `disabledTools`。旧工具名、历史 schema 或手工构造桥调用均不能绕过。
- 系统配置写入：YAML 结构合并 + 备份 + 回滚；只动托管区块；只写所在 profile。

---

## 10. 边界、风险与缓解

| 风险                                     | 缓解                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| eager 全量注入 token 高                  | 参数概要截断 + 预算可调 + 实测校准                                                              |
| eager 全局注册的 schema 进入所有会话请求 | 与内建 dsh-mcp-client 一致（host 级全局注册，非缺陷）；on-demand 走桥无此成本；per-scope 列远期 |
| 桥接参数可靠性（历史 Windows 转义问题）  | 硬约束（§5.7-1/2）+ JSON 容错 + 校验诊断 + 转存；与 Hermes 通道同构                            |
| 双写不一致 / AI 改原生配置               | 每次启动 reconcile；备份；UI 同步状态                                                           |
| 双注册                                   | 托管兜底 disabled；拒绝与未 disabled 实例重名                                                   |
| 中途升档/热重载破坏前缀                  | 每次动作一次失效（已接受）；peek/桥不破坏；UI 明示                                              |
| 浏览器等状态敏感 MCP 被 reload 打断      | peek 模式；加载/热重载前 UI 提示                                                                |
| 插件卸载后配置消失                       | patch 兜底 + prepare-uninstall + 文档                                                           |
| 跨 profile 越权                          | 只维护所在 profile                                                                              |
| 递归扫描误纳入无关 md                    | 只认`<dir>/SKILL.md`（§4.1）                                                                 |
| 系统编辑器打开失败（无默认打开方式）     | fallback：显示文件路径并提示用 fs 工具编辑；记录日志                                            |
| 回收站平台差异                           | Windows/macOS/Linux 三平台策略 + 通用 trash 目录 fallback（§4.4）                              |
| 其他插件技能/工具混入                    | 默认不纳入（§4.6）；显式加目录才扫描，重名裁决 + UI 提示                                       |
| frontmatter 编辑损坏文件                 | 原子写 + 校验 + 回滚                                                                            |

---

## 11. 端到端使用流程（用户视角）

> 约定：**人** = 在 Web GUI 操作的用户；**AI** = 会话里的模型（经工具调用）。"下一轮/下次会话"指注入生效边界。

### 流程 1：新增外接技能目录（人）

- **谁/场景**：用户想把自己维护的一批技能（如 `global-skills/`）纳入管理，让 AI 可用。
- **操作**：打开 SKILL 管理抽屉 → "添加外接目录" → `ctx.directoryPicker` 选中 `global-skills/` → 确认。
- **看到**：抽屉列表按路径排序出现所有 `**/SKILL.md` 技能（名字/描述/路径）；平铺 `.md` 不出现。
- **发生**：目录写入 `settings.json.customRecursiveDirs` → 自建递归 provider 扫描（任意深度只认 `<dir>/SKILL.md`）→ watcher 监听。
- **效果**：技能进入 `ctx.skills`；会话开始注入"名字+描述"；AI 用内建 `skill` 工具按需加载正文。

### 流程 2：关闭/开启某个技能（模型可见性开关）（人）

- **谁/场景**：用户暂时不想让 AI 调某技能，但自己还想用斜杠触发。
- **操作**：列表行 Switch 切到"关"（或"开"）。
- **看到**：行状态变为"模型不可见"（或恢复）。
- **发生**：写 `disable-model-invocation: true`（开 = 删该键）→ watcher/`fs/observed` 失效 → 目录 digest 变化 → 历史末尾追加替换目录（不改历史）。
- **效果**：模型目录与 `skill` 工具不再暴露该技能（关闭时）；用户斜杠 `/name` 始终仍可触发（`user-invocable` 未动）。

### 流程 3：修改技能正文/描述（人）

- **谁/场景**：用户要改某个技能的说明或步骤。
- **操作**：点击列表条目 → 系统编辑器打开 `<dir>/SKILL.md` → 编辑保存。
- **看到**：系统编辑器（非内置阅读器；Windows `start` / macOS `open` / Linux `xdg-open`）。
- **发生**：watcher 检测文件变化 → provider 失效重扫 → 描述/元数据更新。
- **效果**：下一轮起模型看到新描述，`skill` 工具加载到新正文；本插件不额外写入。

### 流程 4：删除技能（人）

- **谁/场景**：用户确定某技能不再需要。
- **操作**：列表行点"删除" → 二次确认。
- **看到**：确认框提示"删除整个 SKILL 文件夹"。
- **发生**：路径校验在受管根内 → 整个文件夹进回收站（三平台策略，兜底 `~/.dsh/skill-mcp-manager/trash/`）→ `trash.log` 审计。
- **效果**：技能从列表与注入消失；文件可经回收站/trash 恢复。

### 流程 5：新增 MCP（AI 主导）

- **谁/场景**：用户说"帮我加一个 GitHub MCP"；AI 负责落地配置。
- **操作**：AI 调 `mcp_register`，给 `name/description/transport/command/args/env(GITHUB_TOKEN)/tier(on-demand)`。
- **看到（AI）**：试连中 → 成功返回"已注册 + 快照（工具名/描述）"；失败返回结构化报错。
- **发生**：校验 → 试连 30s + `tools/list` → 成功写 `registry.json`（含快照）+ 往 `cordis.patch.yml` 写整条 shadow 条目（`disabled: true`）；失败不写任何库。注：**所有档位（含 on-demand）都记 shadow 条目**，不只 eager。
- **效果**：AI 可立即 `mcp_load`/`mcp_call`；下一轮注入带上 on-demand 概要（名字+描述+工具名）；系统原生 dsh-mcp-client 因 `disabled` 不会重复加载。

### 流程 6：修改 MCP（改档位/参数/备注）（AI 或人）

- **谁/场景**：把 github 从 on-demand 升 eager，或改 token/notes。
- **操作**：AI 调 `mcp_register` 改 `tier`/`env`/`notes`；或用户在 MCP 详情改档位/备注。
- **看到（AI/人）**：修改成功后的内容。
- **发生**：校验 → **按需试连**（改参数/升 eager → 试连 30s + `tools/list`；改 notes / 降 disabled → 不试连）→ 成功写 `registry.json`（含快照）+ 整条目回写 `cordis.patch.yml` shadow 条目（`disabled: true` 不变）；失败不写任何库并提示修改失败。
- **效果**：持久化。on-demand→eager 对所有会话立即生效（中途升档会导致前缀失效一次，UI 调整后弹窗提示，无需二次确认）；eager→disabled 注销原生工具（一次前缀失效，已接受）。

### 流程 7：使用 on-demand MCP（AI）

- **谁/场景**：会话里 AI 要用 github 的某个工具。
- **操作**：先 `mcp_load{name: github}` 拿完整定义 → 再 `mcp_call{name: github, tool: search, args: {...}}`。
- **看到（AI）**：load 返回工具名/描述/参数 schema；call 返回 `{ok, data}` 或 `{ok:false, error}`。
- **发生**：load 连接 + listTools + 更新快照；call 走桥（JSON.stringify → client.callTool；schema 校验/容错）。**AI 永远只传结构化 `args`、不写临时文件、不传 `args_file`**——一次性调用成功，无临时文件中转。
- **效果**：前缀零失效（不注册原生 schema）。**未 load 直接 call → 报"该 MCP 未加载，请先 `mcp_load`"**。eager 条目不经过桥，直接原生 `mcp__github__search`。

### 流程 8：删除 MCP 条目（人）

- **谁/场景**：用户确定不再用某个 MCP。
- **操作**：MCP 管理点"删除条目" → 二次确认。
- **看到**：确认框。
- **发生**：先 dispose 自己该条目的连接（注销工具）→ `registry.json` 删条目 → `cordis.patch.yml` **删整条 insert entry**（`id`+`name`+`config`+`disabled` 整块；不是只删 `disabled` 行、不是翻 `disabled`）。
- **效果**：两边干净移除；eager 条目注销原生工具 → 一次前缀失效；on-demand 无此代价。

### 流程 9：卸载整个插件（人）

- **谁/场景**：用户要移除 skill-mcp-manager 插件本身，但想保留已托管的 MCP 给系统原生加载。
- **操作**：先跑 `/mcp prepare-uninstall` → 再从 `cordis.patch.yml` 移除插件条目。
- **看到**：prepare-uninstall 返回"已把 N 个托管条目交还原生"（含 on-demand 条目）。注：外接 SKILL 目录无需额外处理——插件卸载后递归 provider 随之消失，技能自动退回内建 filesystem 单层发现。
- **发生**：插件把仍存在的 managed 条目 `disabled: true → false`；patch 是热的 → 原生 dsh-mcp-client **当前会话立即**接管并注册工具（一次前缀失效；若条目是 eager 且插件尚未移除完，有短暂双注册窗口）→ 随后移除插件条目，插件消失。
- **效果**：MCP 配置不丢，交还系统原生管理。交还后的条目（含原 on-demand）由原生按 **eager** 加载（原生无 on-demand 概念，符合预期）。**若跳过 prepare-uninstall 直接卸载**：托管条目以 `disabled: true` 残留（配置完整），手动改 `false` 即可。插件临时 stop 不触发交还。

---

## 12. 里程碑

- **M0 原型（cordis_define 进程内）**：registry.json + `mcp_register` + `mcp_load(peek)` + `mcp_call` 桥（含容错/校验）+ pre-step 注入 + reconcile（只读所在 profile）；验证 KV 缓存行为与 Windows 特殊字符 spawn 用例。
- **M1 Skill**：递归 provider（只认 SKILL.md）+ 启停（frontmatter）+ 系统编辑器打开 + 跨平台删除 + SKILL 管理抽屉。
- **M2 MCP**：三档 + 启动注入 + 加载器（生命周期自动管理）+ 热重载 + reconcile + 工具管理抽屉 + prepare-uninstall。
- **M3 打磨**：固化可安装包 + patch；token 实测调参；审计/文档。

---

## 13. 对齐 Hermes Agent

| Hermes issue（alone-tree）                                                                        | 本插件设计对应                                                                                                           |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [#84225 Unified on-demand tool loading](https://github.com/NousResearch/hermes-agent/issues/84225) | 注册表（§5.1）、add 验证（§5.3）、三档（§5.4）、load 结果入对话尾部（§5.8）                                          |
| §A 三档                                                                                          | §5.4 eager/on-demand/disabled；全工具分级列为远期，v1 仅 MCP                                                            |
| §B 注册表 + 验证连接 + notes                                                                     | §5.1 notes + load 附带给模型                                                                                            |
| §C load 更新 registry；"no tool_call bridge hop if possible"                                     | §5.8 load 更新快照。**偏差**：DSH 前缀缓存敏感，on-demand 走 `mcp_call` 桥（零失效），eager 才原生直调（§5.6） |
| **tool call 参数可靠性**                                                                    | §5.7：结构化 JSON-RPC 不经 shell + 容错 + 错误闭环，与 Hermes 通道同构                                                  |
| §D 审批边界                                                                                      | `mcp_register` 唯一配置变更点；删除仅 UI                                                                               |
| [#71290 嵌套 skill 分类](https://github.com/NousResearch/hermes-agent/issues/71290)                | §4.1 递归多层扫描（只认 SKILL.md）                                                                                      |
| [#84195 描述截断](https://github.com/NousResearch/hermes-agent/issues/84195)                       | §4.5 可调上限 + 截断标记                                                                                                |
| [#84189 编辑审批模态](https://github.com/NousResearch/hermes-agent/issues/84189)                   | 简化决策：v1 用系统编辑器打开（不做内置编辑器与审批模态），后期迭代                                                      |

**超出 hermes 提案的部分**：AB 通道分工（§5.6）、桥加固（§5.7）、reconcile 兜底（§5.10）、生命周期自动管理（§5.4）、跨平台删除（§4.4）、密钥明文/VAR 双支持（§5.2）。

---

## 附录：关键参考（本机核实）

- `@deepseek-ai/dsh-skill` / `dsh-skill-filesystem` / `dsh-tool-skill`（README + `lib/index.js`：pre-step enter、digest、追加替换）。
- `@deepseek-ai/dsh-mcp-client`（README + `lib/index.js`：静态实例、命名、重连、世代替换、SDK 通道；**无 idle 机制**）。
- 运行时组合：`C:\Users\Zinger\.dsh\profiles\{web,desktop}\cordis.patch.yml`。
- Slots 树（client Inspect）：`settings.section`、`sidebar.footer.action`。
- 用户参考实现（桥接 args 文件 workaround 的教训来源）：[alone-tree/Capability-Library](https://github.com/alone-tree/Capability-Library)。

