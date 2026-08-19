window.__ModuleLoader__.load({ id: "dsh-skill-mcp-manager", factory: (require) => {

  // Pure-JS client bundle (no JSX/TS). Registers one "能力库 (Capability)"
  // settings section with 技能/MCP tabs. Talks to the host over same-origin
  // HTTP routes mounted by lib/ui.js.

  const React = require("react");
  const h = React.createElement;
  const { useState, useEffect, useCallback } = React;

  const name = "dsh-skill-mcp-manager";
  const inject = ["slots"];

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
        await refresh();
        setNotice("已更新 \u300c" + skill.name + "\u300d");
      } catch (err) {
        setError(errText(err));
      }
    }

    async function open(skill) {
      try {
        await postJson("/skill-mcp-manager/skills/open", { name: skill.name });
        setNotice("已用系统编辑器打开 " + skill.path);
      } catch (err) {
        setError(errText(err) + " \u2014 " + skill.path);
      }
    }

    async function remove(skill) {
      setConfirming("");
      try {
        await postJson("/skill-mcp-manager/skills/delete", { name: skill.name });
        setNotice("已删除 " + skill.name);
        await refresh();
      } catch (err) {
        setError(errText(err));
      }
    }

    const rows = (skills || []).map((skill) => h("li", { key: skill.name, className: "smx-row" },
      h("div", { className: "smx-row__main" },
        h("div", { className: "smx-row__top" },
          h("span", { className: "smx-row__name" }, skill.name),
          skill.readonly ? h(Badge, { tone: "muted" }, "只读") : null,
          h("span", { className: "smx-row__path" }, skill.path),
        ),
        skill.description ? h("div", { className: "smx-row__desc" }, skill.description) : null,
      ),
      h("div", { className: "smx-row__actions" },
        skill.readonly
          ? h("span", { className: "smx-switchline__label" }, "只读（不可启停）")
          : h("label", { className: "smx-switchline" },
              h(Switch, { checked: skill.modelInvocable, onChange: () => toggle(skill) }),
              h("span", { className: "smx-switchline__label" }, skill.modelInvocable ? "模型可见" : "模型隐藏"),
            ),
        h("button", { type: "button", className: "smx-btn", onClick: () => open(skill) }, "打开"),
        skill.readonly
          ? null
          : confirming === skill.name
            ? h("span", { className: "smx-confirm" },
                h("button", { type: "button", className: "smx-btn smx-btn--danger", onClick: () => remove(skill) }, "确认删除整个文件夹"),
                h("button", { type: "button", className: "smx-btn", onClick: () => setConfirming("") }, "取消"),
              )
            : h("button", { type: "button", className: "smx-btn smx-btn--ghost", onClick: () => setConfirming(skill.name) }, "删除"),
      ),
    ));

    return h("div", { className: "smx" },
      h("div", { className: "smx-head" },
        h("span", { className: "smx-count" }, skills ? String(skills.length) + " 个技能" : ""),
        h("button", { type: "button", className: "smx-btn", onClick: refresh }, "刷新"),
      ),
      notice ? h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice) : null,
      error ? h(Notice, { kind: "error", onDismiss: () => setError("") }, error) : null,
      loading ? h(Empty, null, "加载中\u2026")
        : skills && skills.length === 0 ? h(Empty, null, "没有可管理的技能（bundle 型 SKILL.md）")
        : h("ul", { className: "smx-list" }, rows),
    );
  }

  // ── MCP panel ────────────────────────────────────────────────────────────
  const TIERS = ["eager", "on-demand", "disabled"];
  const TIER_LABEL = { "eager": "常驻", "on-demand": "按需", "disabled": "关闭" };
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

    async function toggleReveal() {
      const next = !reveal;
      setReveal(next);
      await refresh(next);
    }

    async function setTier(entry, tier) {
      try {
        const upgrading = entry.tier === "on-demand" && tier === "eager";
        await postJson("/skill-mcp-manager/mcp/tier", { name: entry.name, tier });
        setNotice(upgrading ? "已升至 eager（运行中注册，前缀失效一次）" : "已切换 \u300c" + entry.name + "\u300d 到 " + tier);
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
        setNotice(peek ? "已查看描述" : "已加载/刷新");
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      }
    }

    async function disconnect(entry) {
      try {
        await postJson("/skill-mcp-manager/mcp/disconnect", { name: entry.name });
        setNotice("已断开 " + entry.name);
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      }
    }

    async function remove(entry) {
      setConfirming("");
      try {
        await postJson("/skill-mcp-manager/mcp/delete", { name: entry.name });
        setNotice("已删除 " + entry.name);
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
        h("div", { className: "smx-detail__label" }, "环境变量"),
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
          h("div", { className: "smx-detail__label" }, "工具"),
          h(Empty, null, "无工具快照（请先加载）"),
        );
      }
      return h("div", { className: "smx-detail__section" },
        h("div", { className: "smx-detail__label" }, "工具 (" + entry.tools.length + ")"),
        h("ul", { className: "smx-tools" },
          entry.tools.map((tool) => h("li", { key: tool.name, className: "smx-tool" },
            h("span", { className: "smx-tool__name" }, tool.name),
            tool.description ? h("span", { className: "smx-tool__desc" }, tool.description) : null,
          )),
        ),
      );
    }

    function detailBlock(entry) {
      return h("div", { className: "smx-detail" },
        h("div", { className: "smx-detail__section" },
          h("div", { className: "smx-detail__label" }, "档位"),
          h("select", {
            className: "smx-select",
            value: entry.tier,
            onChange: (e) => setTier(entry, e.target.value),
          }, TIERS.map((t) => h("option", { key: t, value: t }, TIER_LABEL[t] + " (" + t + ")"))),
        ),
        kv("传输", entry.transport),
        entry.serverDescription ? kv("描述", entry.serverDescription) : null,
        entry.serverName ? kv("服务器自报名", entry.serverName) : null,
        entry.serverVersion ? kv("版本", entry.serverVersion) : null,
        entry.serverTitle ? kv("标题", entry.serverTitle) : null,
        entry.websiteUrl ? kv("网站", entry.websiteUrl) : null,
        entry.command !== null && entry.command !== undefined ? kv("命令", entry.command) : null,
        (entry.args || []).length > 0 ? kv("参数", (entry.args || []).join(" ")) : null,
        entry.url ? kv("URL", entry.url) : null,
        entry.cwd ? kv("工作目录", entry.cwd) : null,
        entry.instructions ? kv("使用说明", entry.instructions) : null,
        entry.notes ? kv("备注", entry.notes) : null,
        entry.lastLoadAt ? kv("上次加载", entry.lastLoadAt) : null,
        envRows(entry),
        headerRows(entry),
        toolsSection(entry),
        h("div", { className: "smx-detail__actions" },
          h("button", { type: "button", className: "smx-btn", onClick: () => run(entry, true) }, "查看描述"),
          h("button", { type: "button", className: "smx-btn", onClick: () => run(entry, false) }, "加载 / 刷新"),
          h("button", { type: "button", className: "smx-btn smx-btn--ghost", onClick: () => disconnect(entry) }, "断开"),
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
            h(Badge, { tone: TIER_TONE[entry.tier] || "muted" }, TIER_LABEL[entry.tier] || entry.tier),
            entry.connected ? h(Badge, { tone: "info" }, "已连接") : null,
            entry.transport ? h("span", { className: "smx-row__meta" }, entry.transport) : null,
            h("span", { className: "smx-row__meta" }, entry.toolCount + " 工具"),
          ),
          entry.serverDescription ? h("div", { className: "smx-row__desc" }, entry.serverDescription) : null,
        ),
        h("div", { className: "smx-row__actions" },
          h("button", { type: "button", className: "smx-btn", onClick: () => setDetail(isOpen ? "" : entry.name) }, isOpen ? "收起" : "详情"),
          confirming === entry.name
            ? h("span", { className: "smx-confirm" },
                h("button", { type: "button", className: "smx-btn smx-btn--danger", onClick: () => remove(entry) }, "确认删除条目"),
                h("button", { type: "button", className: "smx-btn", onClick: () => setConfirming("") }, "取消"),
              )
            : h("button", { type: "button", className: "smx-btn smx-btn--ghost", onClick: () => setConfirming(entry.name) }, "删除"),
        ),
        isOpen ? detailBlock(entry) : null,
      );
    });

    return h("div", { className: "smx" },
      h("div", { className: "smx-head" },
        h("span", { className: "smx-count" }, entries ? String(entries.length) + " 个服务器" : ""),
        h("div", { className: "smx-head__meta" },
          h("button", { type: "button", className: "smx-btn", onClick: toggleReveal }, reveal ? "隐藏密钥" : "显示密钥"),
          h("button", { type: "button", className: "smx-btn", onClick: () => refresh(reveal) }, "刷新"),
        ),
      ),
      notice ? h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice) : null,
      error ? h(Notice, { kind: "error", onDismiss: () => setError("") }, error) : null,
      loading ? h(Empty, null, "加载中\u2026")
        : entries && entries.length === 0 ? h(Empty, null, "没有已注册的 MCP 服务器")
        : h("ul", { className: "smx-list" }, rows),
    );
  }

  // ── capability section (tabs: 技能 / MCP) ────────────────────────────────
  function ManagerSection() {
    const [tab, setTab] = useState("skills");
    return h("div", { className: "smx" },
      h("header", { className: "smx-header" },
        h("h2", { className: "smx-title" }, "能力库 (Capability)"),
        h("div", { className: "smx-subtitle" }, "管理 Agent 的 Skill 与 MCP"),
      ),
      h("div", { className: "smx-tabs" },
        h("button", { type: "button", className: cx("smx-tab", tab === "skills" && "is-active"), onClick: () => setTab("skills") }, "技能"),
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
    ".smx-tool { display:flex; gap:8px; font-size:12px; }",
    ".smx-tool__name { font-family:ui-monospace,monospace; color:var(--dsw-alias-brand-primary); flex-shrink:0; }",
    ".smx-tool__desc { color:var(--dsw-alias-label-secondary); }",
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
    injectCss();
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: "capability",
      order: 35,
      label: "能力库",
    }, ManagerSection));
  }

  return { name, inject, apply };
}});
