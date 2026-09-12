window.__ModuleLoader__.load({ id: "dsh-skill-mcp-manager", factory: (require) => {

  // Pure-JS client bundle (no JSX/TS). Registers one "能力库 (Capability)"
  // settings section with 技能/MCP tabs. Talks to the host over same-origin
  // HTTP routes mounted by lib/ui.js.

  const React = require("react");
  const h = React.createElement;
  const { useState, useEffect, useCallback } = React;

  const name = "dsh-skill-mcp-manager";
  const inject = ["slots", "locale"];

  // ── i18n ─────────────────────────────────────────────────────────────────
  // English is the default; Chinese only when the host locale service (or,
  // failing that, the browser language) reports a zh locale.
  const I18N = {
    en: {
      sectionLabel: "Capability",
      title: "Capability",
      subtitle: "Manage the agent's skills and MCP servers",
      tabSkills: "Skills",
      loading: "Loading\u2026",
      refresh: "Refresh",
      cancel: "Cancel",
      delete: "Delete",
      skNoSkills: "No manageable skills (bundle-style SKILL.md)",
      skCount: "{total} skills \u00b7 {visible} visible to the model",
      skOpenedEditor: "Opened {path} in the system editor",
      skDeleted: "Deleted {name}",
      skReadonly: "Read-only",
      skReadonlyHint: "Read-only (no toggle)",
      skModelVisible: "Visible to model",
      skModelHidden: "Hidden from model",
      skOpen: "Open",
      skConfirmDelete: "Delete entire folder",
      tierEager: "Eager",
      tierOnDemand: "On-demand",
      tierDisabled: "Off",
      mcpServers: "{total} servers",
      mcpReveal: "Show secrets",
      mcpHide: "Hide secrets",
      mcpNoEntries: "No MCP servers registered",
      mcpToolDescLabel: "Tool description truncation (chars)",
      mcpSave: "Save",
      mcpCurrent: "Current {value}",
      mcpToolDescInvalid: "Tool description truncation must be an integer between 1 and 5000",
      mcpToolDescUpdated: "Tool description truncation updated to {value}",
      mcpUpgraded: "Upgraded to eager (registered live; prefix invalidation happens once)",
      mcpSwitched: "Switched \u201c{name}\u201d to {tier}",
      mcpToolEnabled: "Enabled {name}/{tool}",
      mcpToolDisabled: "Disabled {name}/{tool}",
      mcpPeeked: "Description viewed",
      mcpPeekAction: "View description",
      mcpRefreshed: "Snapshot refreshed",
      mcpRefreshAction: "Refresh snapshot",
      mcpDeleted: "Deleted {name}",
      mcpEnvLabel: "Environment variables",
      mcpToolsLabel: "Tools",
      mcpNoTools: "No tool snapshot (refresh the snapshot)",
      mcpToolsCount: "Tools ({count})",
      mcpToolTierAria: "{name} tier",
      mcpOptEnabled: "Enabled",
      mcpOptDisabled: "Disabled",
      mcpTierLabel: "Tier",
      kvTransport: "Transport",
      kvDescription: "Description",
      kvServerName: "Server self-reported name",
      kvVersion: "Version",
      kvTitle: "Title",
      kvWebsite: "Website",
      kvCommand: "Command",
      kvArgs: "Args",
      kvCwd: "Working directory",
      kvInstructions: "Instructions",
      kvNotes: "Notes",
      kvLastLoad: "Last snapshot refresh",
      mcpToolCount: "{count} tools",
      mcpCollapse: "Collapse",
      mcpDetails: "Details",
      mcpConfirmDeleteEntry: "Delete entry",
    },
    zh: {
      sectionLabel: "能力库",
      title: "能力库 (Capability)",
      subtitle: "管理 Agent 的 Skill 与 MCP",
      tabSkills: "技能",
      loading: "加载中\u2026",
      refresh: "刷新",
      cancel: "取消",
      delete: "删除",
      skNoSkills: "没有可管理的技能（bundle 型 SKILL.md）",
      skCount: "{total} 个技能 \u00b7 模型可见 {visible} 个",
      skOpenedEditor: "已用系统编辑器打开 {path}",
      skDeleted: "已删除 {name}",
      skReadonly: "只读",
      skReadonlyHint: "只读（不可启停）",
      skModelVisible: "模型可见",
      skModelHidden: "模型隐藏",
      skOpen: "打开",
      skConfirmDelete: "确认删除整个文件夹",
      tierEager: "常驻",
      tierOnDemand: "按需",
      tierDisabled: "关闭",
      mcpServers: "{total} 个服务器",
      mcpReveal: "显示密钥",
      mcpHide: "隐藏密钥",
      mcpNoEntries: "没有已注册的 MCP 服务器",
      mcpToolDescLabel: "工具描述截断（字符）",
      mcpSave: "保存",
      mcpCurrent: "当前 {value}",
      mcpToolDescInvalid: "工具描述截断必须是 1–5000 的正整数",
      mcpToolDescUpdated: "已更新工具描述截断为 {value}",
      mcpUpgraded: "已升至 eager（运行中注册，前缀失效一次）",
      mcpSwitched: "已切换\u300c{name}\u300d到 {tier}",
      mcpToolEnabled: "已启用 {name}/{tool}",
      mcpToolDisabled: "已禁用 {name}/{tool}",
      mcpPeeked: "已查看描述",
      mcpPeekAction: "查看描述",
      mcpRefreshed: "已刷新快照",
      mcpRefreshAction: "刷新快照",
      mcpDeleted: "已删除 {name}",
      mcpEnvLabel: "环境变量",
      mcpToolsLabel: "工具",
      mcpNoTools: "无工具快照（请刷新快照）",
      mcpToolsCount: "工具 ({count})",
      mcpToolTierAria: "{name} 档位",
      mcpOptEnabled: "启用",
      mcpOptDisabled: "禁用",
      mcpTierLabel: "档位",
      kvTransport: "传输",
      kvDescription: "描述",
      kvServerName: "服务器自报名",
      kvVersion: "版本",
      kvTitle: "标题",
      kvWebsite: "网站",
      kvCommand: "命令",
      kvArgs: "参数",
      kvCwd: "工作目录",
      kvInstructions: "使用说明",
      kvNotes: "备注",
      kvLastLoad: "上次刷新快照",
      mcpToolCount: "{count} 工具",
      mcpCollapse: "收起",
      mcpDetails: "详情",
      mcpConfirmDeleteEntry: "确认删除条目",
    },
  };

  /** Host locale sync — the snapshot shape is { active, locales, revision }. */
  function detectLang(ctx) {
    try {
      const snap = ctx && ctx.locale && ctx.locale.snapshot && ctx.locale.snapshot();
      const code = String((snap && (snap.active || snap.locale || snap.language)) || "");
      if (/^zh/i.test(code)) return "zh";
      if (/^en/i.test(code)) return "en";
    } catch (e) { /* runtime without locale service */ }
    try {
      const nav = String((typeof navigator !== "undefined" && navigator.language) || "");
      if (/^zh/i.test(nav)) return "zh";
    } catch (e) { /* no navigator */ }
    return "en";
  }

  let LANG = null;

  function t(key, params) {
    let out = (I18N[LANG === "zh" ? "zh" : "en"][key]) ?? I18N.en[key] ?? key;
    if (params) {
      for (const k of Object.keys(params)) out = out.split("{" + k + "}").join(String(params[k]));
    }
    return out;
  }


  // ── fetch ────────────────────────────────────────────────────────────────
  async function getJson(path) {
    const res = await fetch(path, { cache: "no-store" });
    const data = await res.json().catch(() => ({ ok: false, error: "HTTP " + res.status }));
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }

  async function postJson(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({ ok: false, error: "HTTP " + res.status }));
    if (!res.ok || data.ok === false) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }

  function cx() {
    return Array.prototype.filter.call(arguments, Boolean).join(" ");
  }

  function errText(error) {
    return String(error && error.message ? error.message : error);
  }

  // ── primitives ───────────────────────────────────────────────────────────
  function Switch(props) {
    const checked = props.checked === true;
    const disabled = props.disabled === true;
    return h("button", {
      type: "button",
      role: "switch",
      "aria-checked": checked ? "true" : "false",
      className: cx("smx-switch", checked && "is-on"),
      disabled,
      onClick: () => props.onChange(!checked),
    }, h("span", { className: "smx-switch__knob" }));
  }

  function Badge(props) {
    return h("span", { className: cx("smx-badge", props.tone ? "smx-badge--" + props.tone : "") }, props.children);
  }

  function Notice(props) {
    return h("div", { className: cx("smx-notice", props.kind ? "smx-notice--" + props.kind : "") },
      h("span", null, props.children),
      props.onDismiss
        ? h("button", { type: "button", className: "smx-notice__close", onClick: props.onDismiss }, "\u00d7")
        : null,
    );
  }

  function Empty(props) {
    return h("div", { className: "smx-empty" }, props.children);
  }

  function kv(key, value) {
    return h("div", { className: "smx-kv", key },
      h("span", { className: "smx-kv__k" }, key),
      h("span", { className: "smx-kv__v" }, value === null || value === undefined || value === "" ? "\u2014" : String(value)),
    );
  }

  // ── Skills panel ─────────────────────────────────────────────────────────
  function SkillsPanel() {
    const [skills, setSkills] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [confirming, setConfirming] = useState("");

    const refresh = useCallback(async () => {
      setLoading(true);
      setError("");
      try {
        const data = await getJson("/skill-mcp-manager/skills");
        setSkills(data.skills || []);
      } catch (err) {
        setError(errText(err));
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    async function toggle(skill) {
      try {
        await postJson("/skill-mcp-manager/skills/toggle", { name: skill.name, enabled: !skill.modelInvocable });
        setSkills((current) => current && current.map((item) =>
          item.name === skill.name ? { ...item, modelInvocable: !skill.modelInvocable } : item,
        ));
      } catch (err) {
        setError(errText(err));
      }
    }

    async function open(skill) {
      try {
        await postJson("/skill-mcp-manager/skills/open", { name: skill.name });
        setNotice(t("skOpenedEditor", { path: skill.path }));
      } catch (err) {
        setError(errText(err) + " \u2014 " + skill.path);
      }
    }

    async function remove(skill) {
      setConfirming("");
      try {
        await postJson("/skill-mcp-manager/skills/delete", { name: skill.name });
        setNotice(t("skDeleted", { name: skill.name }));
        await refresh();
      } catch (err) {
        setError(errText(err));
      }
    }

    const rows = (skills || []).map((skill) => h("li", { key: skill.name, className: "smx-row" },
      h("div", { className: "smx-row__main" },
        h("div", { className: "smx-row__top" },
          h("span", { className: "smx-row__name" }, skill.name),
          skill.readonly ? h(Badge, { tone: "muted" }, t("skReadonly")) : null,
          h("span", { className: "smx-row__path" }, skill.path),
        ),
        skill.description ? h("div", { className: "smx-row__desc" }, skill.description) : null,
      ),
      h("div", { className: "smx-row__actions" },
        skill.readonly
          ? h("span", { className: "smx-switchline__label" }, t("skReadonlyHint"))
          : h("label", { className: "smx-switchline" },
              h(Switch, { checked: skill.modelInvocable, onChange: () => toggle(skill) }),
              h("span", { className: "smx-switchline__label" }, skill.modelInvocable ? t("skModelVisible") : t("skModelHidden")),
            ),
        h("button", { type: "button", className: "smx-btn", onClick: () => open(skill) }, t("skOpen")),
        skill.readonly
          ? null
          : confirming === skill.name
            ? h("span", { className: "smx-confirm" },
                h("button", { type: "button", className: "smx-btn smx-btn--danger", onClick: () => remove(skill) }, t("skConfirmDelete")),
                h("button", { type: "button", className: "smx-btn", onClick: () => setConfirming("") }, t("cancel")),
              )
            : h("button", { type: "button", className: "smx-btn smx-btn--ghost", onClick: () => setConfirming(skill.name) }, t("delete")),
      ),
    ));

    return h("div", { className: "smx" },
      h("div", { className: "smx-head" },
        h("span", { className: "smx-count" }, skills
          ? t("skCount", { total: skills.length, visible: skills.filter((s) => s.modelInvocable).length })
          : ""),
        h("button", { type: "button", className: "smx-btn", onClick: refresh }, t("refresh")),
      ),
      notice ? h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice) : null,
      error ? h(Notice, { kind: "error", onDismiss: () => setError("") }, error) : null,
      loading ? h(Empty, null, t("loading"))
        : skills && skills.length === 0 ? h(Empty, null, t("skNoSkills"))
        : h("ul", { className: "smx-list" }, rows),
    );
  }

  // ── MCP panel ────────────────────────────────────────────────────────────
  const TIERS = ["eager", "on-demand", "disabled"];
  const TIER_LABEL = () => ({ "eager": t("tierEager"), "on-demand": t("tierOnDemand"), "disabled": t("tierDisabled") });
  const TIER_TONE = { "eager": "success", "on-demand": "info", "disabled": "muted" };

  function McpPanel() {
    const [entries, setEntries] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [reveal, setReveal] = useState(false);
    const [detail, setDetail] = useState("");
    const [confirming, setConfirming] = useState("");
    const [output, setOutput] = useState("");
    const [toolDescMax, setToolDescMax] = useState(150);
    const [toolDescDraft, setToolDescDraft] = useState("150");

    const refresh = useCallback(async (rv) => {
      setLoading(true);
      setError("");
      try {
        const data = await getJson("/skill-mcp-manager/mcp" + (rv ? "?reveal=1" : ""));
        setEntries(data.entries || []);
      } catch (err) {
        setError(errText(err));
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => { refresh(false); }, [refresh]);

    useEffect(() => {
      getJson("/skill-mcp-manager/settings")
        .then((data) => {
          const value = data.toolDescriptionMaxLength;
          if (typeof value === "number" && value > 0) {
            setToolDescMax(value);
            setToolDescDraft(String(value));
          }
        })
        .catch(() => {});
    }, []);

    async function saveToolDesc() {
      const value = Number(toolDescDraft);
      if (!Number.isInteger(value) || value <= 0 || value > 5000) {
        setError(t("mcpToolDescInvalid"));
        return;
      }
      try {
        await postJson("/skill-mcp-manager/settings", { toolDescriptionMaxLength: value });
        setToolDescMax(value);
        setNotice(t("mcpToolDescUpdated", { value }));
      } catch (err) {
        setError(errText(err));
      }
    }

    async function toggleReveal() {
      const next = !reveal;
      setReveal(next);
      await refresh(next);
    }

    async function setTier(entry, tier) {
      try {
        const upgrading = entry.tier === "on-demand" && tier === "eager";
        await postJson("/skill-mcp-manager/mcp/tier", { name: entry.name, tier });
        setNotice(upgrading ? t("mcpUpgraded") : t("mcpSwitched", { name: entry.name, tier }));
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      }
    }

    async function setToolEnabled(entry, tool, enabled) {
      try {
        await postJson("/skill-mcp-manager/mcp/tool-tier", {
          name: entry.name,
          tool: tool.name,
          enabled,
        });
        setNotice(enabled ? t("mcpToolEnabled", { name: entry.name, tool: tool.name }) : t("mcpToolDisabled", { name: entry.name, tool: tool.name }));
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      }
    }

    async function run(entry, peek) {
      setOutput("");
      try {
        const data = await postJson("/skill-mcp-manager/mcp/load", { name: entry.name, peek: peek === true });
        setOutput(data.text || "");
        setNotice(peek ? t("mcpPeeked") : t("mcpRefreshed"));
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      }
    }

    async function remove(entry) {
      setConfirming("");
      try {
        await postJson("/skill-mcp-manager/mcp/delete", { name: entry.name });
        setNotice(t("mcpDeleted", { name: entry.name }));
        setDetail("");
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      }
    }

    function envRows(entry) {
      const keys = Object.keys(entry.env || {});
      if (keys.length === 0) return null;
      return h("div", { className: "smx-detail__section" },
        h("div", { className: "smx-detail__label" }, t("mcpEnvLabel")),
        keys.map((k) => kv(k, entry.env[k])),
      );
    }

    function headerRows(entry) {
      const keys = Object.keys(entry.headers || {});
      if (keys.length === 0) return null;
      return h("div", { className: "smx-detail__section" },
        h("div", { className: "smx-detail__label" }, "Headers"),
        keys.map((k) => kv(k, entry.headers[k])),
      );
    }

    function toolsSection(entry) {
      if (!entry.tools || entry.tools.length === 0) {
        return h("div", { className: "smx-detail__section" },
          h("div", { className: "smx-detail__label" }, t("mcpToolsLabel")),
          h(Empty, null, t("mcpNoTools")),
        );
      }
      return h("div", { className: "smx-detail__section" },
        h("div", { className: "smx-detail__label" }, t("mcpToolsCount", { count: entry.tools.length })),
        h("ul", { className: "smx-tools" },
          entry.tools.map((tool) => h("li", {
            key: tool.name,
            className: cx("smx-tool", tool.enabled === false && "is-disabled"),
          },
            h("select", {
              className: cx("smx-tool__tier", tool.enabled === false && "is-disabled"),
              value: tool.enabled === false ? "disabled" : "enabled",
              "aria-label": t("mcpToolTierAria", { name: tool.name }),
              onChange: (event) => setToolEnabled(entry, tool, event.target.value === "enabled"),
            },
              h("option", { value: "enabled" }, t("mcpOptEnabled")),
              h("option", { value: "disabled" }, t("mcpOptDisabled")),
            ),
            h("span", { className: "smx-tool__name" }, tool.name),
            tool.description ? h("span", { className: "smx-tool__desc" }, tool.description) : null,
          )),
        ),
      );
    }

    function detailBlock(entry) {
      return h("div", { className: "smx-detail" },
        h("div", { className: "smx-detail__section" },
          h("div", { className: "smx-detail__label" }, t("mcpTierLabel")),
          h("select", {
            className: "smx-select",
            value: entry.tier,
            onChange: (e) => setTier(entry, e.target.value),
          }, TIERS.map((tier) => h("option", { key: tier, value: tier }, TIER_LABEL()[tier] + " (" + tier + ")"))),
        ),
        kv(t("kvTransport"), entry.transport),
        entry.serverDescription ? kv(t("kvDescription"), entry.serverDescription) : null,
        entry.serverName ? kv(t("kvServerName"), entry.serverName) : null,
        entry.serverVersion ? kv(t("kvVersion"), entry.serverVersion) : null,
        entry.serverTitle ? kv(t("kvTitle"), entry.serverTitle) : null,
        entry.websiteUrl ? kv(t("kvWebsite"), entry.websiteUrl) : null,
        entry.command !== null && entry.command !== undefined ? kv(t("kvCommand"), entry.command) : null,
        (entry.args || []).length > 0 ? kv(t("kvArgs"), (entry.args || []).join(" ")) : null,
        entry.url ? kv("URL", entry.url) : null,
        entry.cwd ? kv(t("kvCwd"), entry.cwd) : null,
        entry.instructions ? kv(t("kvInstructions"), entry.instructions) : null,
        entry.notes ? kv(t("kvNotes"), entry.notes) : null,
        entry.lastLoadAt ? kv(t("kvLastLoad"), entry.lastLoadAt) : null,
        envRows(entry),
        headerRows(entry),
        toolsSection(entry),
        h("div", { className: "smx-detail__actions" },
          h("button", { type: "button", className: "smx-btn", onClick: () => run(entry, true) }, t("mcpPeekAction")),
          h("button", { type: "button", className: "smx-btn", onClick: () => run(entry, false) }, t("mcpRefreshAction")),
        ),
        output ? h("pre", { className: "smx-output" }, output) : null,
      );
    }

    const rows = (entries || []).map((entry) => {
      const isOpen = detail === entry.name;
      return h("li", { key: entry.name, className: "smx-row smx-row--col" },
        h("div", { className: "smx-row__main" },
          h("div", { className: "smx-row__top" },
            h("span", { className: "smx-row__name" }, entry.name),
            h(Badge, { tone: TIER_TONE[entry.tier] || "muted" }, TIER_LABEL()[entry.tier] || entry.tier),
            entry.transport ? h("span", { className: "smx-row__meta" }, entry.transport) : null,
            h("span", { className: "smx-row__meta" }, t("mcpToolCount", { count: entry.toolCount })),
          ),
          entry.serverDescription ? h("div", { className: "smx-row__desc" }, entry.serverDescription) : null,
        ),
        h("div", { className: "smx-row__actions" },
          h("button", { type: "button", className: "smx-btn", onClick: () => setDetail(isOpen ? "" : entry.name) }, isOpen ? t("mcpCollapse") : t("mcpDetails")),
          confirming === entry.name
            ? h("span", { className: "smx-confirm" },
                h("button", { type: "button", className: "smx-btn smx-btn--danger", onClick: () => remove(entry) }, t("mcpConfirmDeleteEntry")),
                h("button", { type: "button", className: "smx-btn", onClick: () => setConfirming("") }, t("cancel")),
              )
            : h("button", { type: "button", className: "smx-btn smx-btn--ghost", onClick: () => setConfirming(entry.name) }, t("delete")),
        ),
        isOpen ? detailBlock(entry) : null,
      );
    });

    return h("div", { className: "smx" },
      h("div", { className: "smx-head" },
        h("span", { className: "smx-count" }, entries ? t("mcpServers", { total: entries.length }) : ""),
        h("div", { className: "smx-head__meta" },
          h("button", { type: "button", className: "smx-btn", onClick: toggleReveal }, reveal ? t("mcpHide") : t("mcpReveal")),
          h("button", { type: "button", className: "smx-btn", onClick: () => refresh(reveal) }, t("refresh")),
        ),
      ),
      h("div", { className: "smx-setting" },
        h("span", { className: "smx-setting__label" }, t("mcpToolDescLabel")),
        h("input", {
          type: "number",
          className: "smx-input",
          value: toolDescDraft,
          min: 1,
          max: 5000,
          onChange: (e) => setToolDescDraft(e.target.value),
        }),
        h("button", { type: "button", className: "smx-btn", onClick: saveToolDesc }, t("mcpSave")),
        h("span", { className: "smx-count" }, t("mcpCurrent", { value: toolDescMax })),
      ),
      notice ? h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice) : null,
      error ? h(Notice, { kind: "error", onDismiss: () => setError("") }, error) : null,
      loading ? h(Empty, null, t("loading"))
        : entries && entries.length === 0 ? h(Empty, null, t("mcpNoEntries"))
        : h("ul", { className: "smx-list" }, rows),
    );
  }

  // ── capability section (tabs: 技能 / MCP) ────────────────────────────────
  function ManagerSection() {
    const [tab, setTab] = useState("skills");
    return h("div", { className: "smx" },
      h("header", { className: "smx-header" },
        h("h2", { className: "smx-title" }, t("title")),
        h("div", { className: "smx-subtitle" }, t("subtitle")),
      ),
      h("div", { className: "smx-tabs" },
        h("button", { type: "button", className: cx("smx-tab", tab === "skills" && "is-active"), onClick: () => setTab("skills") }, t("tabSkills")),
        h("button", { type: "button", className: cx("smx-tab", tab === "mcp" && "is-active"), onClick: () => setTab("mcp") }, "MCP"),
      ),
      tab === "skills" ? h(SkillsPanel) : h(McpPanel),
    );
  }

  // ── CSS ──────────────────────────────────────────────────────────────────
  const CSS = [
    ".smx { display:flex; flex-direction:column; gap:12px; min-width:0; }",
    ".smx-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }",
    ".smx-title { margin:0; font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary); }",
    ".smx-head__meta { display:flex; align-items:center; gap:8px; }",
    ".smx-setting { display:flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); }",
    ".smx-setting__label { font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-input { font-size:12px; padding:5px 8px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); width:72px; }",
    ".smx-count { font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-btn { font-size:12px; line-height:1; padding:6px 10px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); cursor:pointer; }",
    ".smx-btn:hover { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }",
    ".smx-btn--ghost { border-color:var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }",
    ".smx-btn--danger { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }",
    ".smx-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }",
    ".smx-row { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:10px 12px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); }",
    ".smx-row--col { flex-direction:column; }",
    ".smx-row__main { min-width:0; flex:1; }",
    ".smx-row__top { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }",
    ".smx-row__name { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }",
    ".smx-row__path { font-size:11px; color:var(--dsw-alias-label-secondary); word-break:break-all; }",
    ".smx-row__meta { font-size:11px; color:var(--dsw-alias-label-secondary); }",
    ".smx-row__desc { margin-top:4px; font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-row__actions { display:flex; align-items:center; gap:8px; flex-shrink:0; }",
    ".smx-switchline { display:flex; align-items:center; gap:6px; }",
    ".smx-switchline__label { font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-switch { position:relative; width:30px; height:17px; border-radius:999px; border:none; background:var(--dsw-alias-border-l2); cursor:pointer; padding:0; flex-shrink:0; }",
    ".smx-switch.is-on { background:var(--dsw-alias-brand-primary); }",
    ".smx-switch__knob { position:absolute; top:2px; left:2px; width:13px; height:13px; border-radius:50%; background:#fff; transition:left .12s ease; }",
    ".smx-switch.is-on .smx-switch__knob { left:15px; }",
    ".smx-badge { font-size:10px; padding:2px 6px; border-radius:999px; border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-secondary); white-space:nowrap; }",
    ".smx-badge--success { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); }",
    ".smx-badge--info { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }",
    ".smx-badge--muted { color:var(--dsw-alias-label-secondary); border-color:var(--dsw-alias-border-l1); }",
    ".smx-notice { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px; border-radius:6px; font-size:12px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }",
    ".smx-notice--success { border-color:var(--dsw-alias-state-success-primary); }",
    ".smx-notice--error { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }",
    ".smx-notice__close { border:none; background:none; color:inherit; cursor:pointer; font-size:14px; padding:0 2px; }",
    ".smx-empty { padding:18px; text-align:center; font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-confirm { display:inline-flex; gap:6px; align-items:center; }",
    ".smx-detail { display:flex; flex-direction:column; gap:8px; border-top:1px solid var(--dsw-alias-border-l1); padding-top:10px; }",
    ".smx-detail__section { display:flex; flex-direction:column; gap:4px; }",
    ".smx-detail__label { font-size:11px; font-weight:600; color:var(--dsw-alias-label-secondary); }",
    ".smx-detail__actions { display:flex; gap:8px; flex-wrap:wrap; }",
    ".smx-kv { display:flex; gap:8px; font-size:12px; }",
    ".smx-kv__k { flex-shrink:0; color:var(--dsw-alias-label-secondary); }",
    ".smx-kv__v { color:var(--dsw-alias-label-primary); word-break:break-all; }",
    ".smx-select { font-size:12px; padding:5px 8px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }",
    ".smx-tools { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px; }",
    ".smx-tool { display:flex; align-items:flex-start; gap:8px; font-size:12px; }",
    ".smx-tool__tier { flex-shrink:0; min-width:58px; font-size:11px; padding:2px 4px; border-radius:5px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }",
    ".smx-tool__tier.is-disabled { color:var(--dsw-alias-label-secondary); }",
    ".smx-tool__name { font-family:ui-monospace,monospace; color:var(--dsw-alias-label-primary); flex-shrink:0; }",
    ".smx-tool__desc { color:var(--dsw-alias-label-secondary); }",
    ".smx-tool.is-disabled .smx-tool__name, .smx-tool.is-disabled .smx-tool__desc { color:var(--dsw-alias-label-secondary); }",
    ".smx-output { margin:0; padding:8px; border-radius:6px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-size:11px; white-space:pre-wrap; word-break:break-word; max-height:220px; overflow:auto; }",
    ".smx-header { display:flex; flex-direction:column; gap:2px; }",
    ".smx-subtitle { font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-tabs { display:flex; gap:4px; border-bottom:1px solid var(--dsw-alias-border-l1); padding-bottom:8px; }",
    ".smx-tab { font-size:12px; padding:6px 12px; border-radius:6px; border:1px solid transparent; background:none; color:var(--dsw-alias-label-secondary); cursor:pointer; }",
    ".smx-tab.is-active { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); }",
  ].join("\n");

  function injectCss() {
    if (typeof document === "undefined") return;
    const tagId = "@deepseek-ai/dsh-skill-mcp-manager";
    if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-skill-mcp-manager";
    tag.dataset.pluginCss = tagId;
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }

  // ── apply ────────────────────────────────────────────────────────────────
  function apply(ctx) {
    LANG = detectLang(ctx);
    try {
      ctx.on("locale/change", () => { LANG = detectLang(ctx); });
    } catch (e) { /* no locale events */ }
    injectCss();
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: "capability",
      order: 35,
      label: t("sectionLabel"),
    }, ManagerSection));
  }

  return { name, inject, apply, __i18n: { t, I18N } };
}});
