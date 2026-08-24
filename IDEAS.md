# 功能想法

> 记录尚未确定、尚未进入实现的想法。

## Skill 开关后保持当前位置

- 关闭或开启某个 Skill 后，不要因页面立即刷新而跳回顶部；应保持当前浏览位置，方便连续处理列表下方的 Skill。

## Skill 搜索

- 在 Skill 管理页顶部增加搜索框，输入关键词后自动筛选。
- 筛选范围包括 Skill 路径、名称和描述。

## 接入 Better Sidebar

- 希望能从 Better Sidebar 直接进入能力库管理页面，在侧边栏中观察和修改 Skill、MCP，而不必跳转到 VS Code 等 Markdown 编辑器。
- Better Sidebar 与能力库是两个插件，两者应如何关联、是否能够集成，目前尚不清楚，需确认。

## capability-entry 能进会话，但能力库管理页未纳入

- 当前会话 Skill 列表能看到 `capability-entry`。
- 能力库管理页未列出它：`GET /skill-mcp-manager/skills` 共 123 条，匹配数为 0。
- 文件在 `D:\HermesSync\capability-library\capability-entry\SKILL.md`。插件 `customRecursiveDirs` 只有 `D:\HermesSync\global-skills` 和 DSH 内置 Cordis Skills，不含 `capability-library`。
- 它进入会话的路径：`C:\Users\Zinger\.dsh\skills\capability-entry`（以及 `C:\Users\Zinger\.agents\skills\capability-entry`）是指向上述目录的 Junction，由原生 `dsh-skill-filesystem` 单层扫描发现。
- 为何管理页未接管：需确认。插件 UI 理论上会列出 `ctx.skills` 里的 bundle Skill，但实测没有这条。未改代码。
