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

  // ── legacy session notice ────────────────────────────────────────────────
  // Sessions written before 1.1.5 cannot be opened once DSH reaches 2.0.9. The
  // host scans for them on every start while its `check` flag is set, reports the
  // count, and retires the flag by itself once a scan finds nothing. This only
  // points at the repair guide — nothing here repairs anything, and there is no
  // dismiss: an accidental click must not be able to hide a real problem.
  const REPAIR_GUIDE_URL = "https://github.com/alone-tree/dsh-skill-mcp-manager/issues/2";
  const AUDIT_POLL_MS = 5000;
  const AUDIT_POLL_LIMIT = 36;

  // The host answers `pending` until this start's scan lands, and the scan may
  // take tens of seconds on a large library — so a record read early can still
  // be the previous start's. Poll while either is in flight, otherwise a notice
  // for a problem that has just been repaired would stay on screen all session.
  function useLegacyAudit() {
    const [audit, setAudit] = useState(null);
    useEffect(() => {
      let cancelled = false;
      let timer = null;
      let attempts = 0;
      const load = async () => {
        try {
          const data = await getJson("/skill-mcp-manager/session-audit");
          if (cancelled) return;
          setAudit(data);
          const unsettled = data.pending === true || data.affected > 0;
          if (unsettled && attempts < AUDIT_POLL_LIMIT) {
            attempts += 1;
            timer = setTimeout(load, AUDIT_POLL_MS);
          }
        } catch {
          /* advisory only — a failed fetch stays silent */
        }
      };
      load();
      return () => {
        cancelled = true;
        if (timer !== null) clearTimeout(timer);
      };
    }, []);
    return audit;
  }

  function legacySessionsOpen(audit) {
    return audit !== null && audit.pending !== true && audit.check !== false && audit.affected > 0;
  }

  // Settings-page banner: the full explanation and the repair link. It carries
  // no close control — it disappears when the host retires the check, which
  // happens as soon as a scan finds nothing left to report.
  function LegacySessionBanner() {
    const audit = useLegacyAudit();
    if (!legacySessionsOpen(audit)) return null;
    return h(Notice, { kind: "error" },
      h("span", { className: "smx-legacy" },
        h("span", { className: "smx-legacy__title" }, `因 DSH 版本升级，有 ${audit.affected} 个历史会话无法查看`),
        h("span", null,
          "DSH 升级后调整了 MCP 注入消息的格式规范，旧会话的 MCP 注入消息不再被支持，打开时会显示",
          h("code", { className: "smx-legacy__code" }, "历史加载失败：failed to observe session … cannot safely transform unclassified message source"),
          "。请按本项目 issue 的",
          h("a", { className: "smx-legacy__link", href: REPAIR_GUIDE_URL, target: "_blank", rel: "noreferrer" }, "一次性修复指引"),
          "完成修复（脚本会先备份，验收通过后再删除备份）。",
        ),
        h("span", { className: "smx-legacy__note" },
          "修好后不需要手动关闭：下次启动扫描到 0 会自动停止。若你决定不修复这些会话，把 ",
          h("code", { className: "smx-legacy__code" }, "~/.dsh/skill-mcp-manager/session-audit.json"),
          " 里的 ",
          h("code", { className: "smx-legacy__code" }, `"check": false`),
          " 写入即可停止提示。",
        ),
      ),
    );
  }

  // Frame-wide notice: re-appears on every start while the check is set. Its
  // close only hides it for this session — no state is written, so a stray click
  // costs nothing.
  function LegacySessionOverlay() {
    const audit = useLegacyAudit();
    const [hidden, setHidden] = useState(false);
    if (hidden || !legacySessionsOpen(audit)) return null;
    return h("div", { className: "smx-toast", role: "status" },
      h("div", { className: "smx-toast__main" },
        h("div", { className: "smx-toast__title" }, `因 DSH 版本升级，有 ${audit.affected} 个历史会话无法查看`),
        h("div", { className: "smx-toast__text" }, "详情见「设置 → 能力库」，内含一次性修复指引。"),
      ),
      h("button", {
        type: "button",
        className: "smx-toast__close",
        title: "本次不再显示",
        onClick: () => setHidden(true),
      }, "\u00d7"),
    );
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
        h("span", { className: "smx-count" }, skills
          ? String(skills.length) + " 个技能 · 模型可见 " + skills.filter((s) => s.modelInvocable).length + " 个"
          : ""),
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
        setError("工具描述截断必须是 1–5000 的正整数");
        return;
      }
      try {
        await postJson("/skill-mcp-manager/settings", { toolDescriptionMaxLength: value });
        setToolDescMax(value);
        setNotice("已更新工具描述截断为 " + value);
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
        setNotice(upgrading ? "已升至 eager（运行中注册，前缀失效一次）" : "已切换 \u300c" + entry.name + "\u300d 到 " + tier);
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
        setNotice("已" + (enabled ? "启用 " : "禁用 ") + entry.name + "/" + tool.name);
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
        setNotice(peek ? "已查看描述" : "已刷新快照");
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
          h(Empty, null, "无工具快照（请刷新快照）"),
        );
      }
      return h("div", { className: "smx-detail__section" },
        h("div", { className: "smx-detail__label" }, "工具 (" + entry.tools.length + ")"),
        h("ul", { className: "smx-tools" },
          entry.tools.map((tool) => h("li", {
            key: tool.name,
            className: cx("smx-tool", tool.enabled === false && "is-disabled"),
          },
            h("select", {
              className: cx("smx-tool__tier", tool.enabled === false && "is-disabled"),
              value: tool.enabled === false ? "disabled" : "enabled",
              "aria-label": tool.name + " 档位",
              onChange: (event) => setToolEnabled(entry, tool, event.target.value === "enabled"),
            },
              h("option", { value: "enabled" }, "启用"),
              h("option", { value: "disabled" }, "禁用"),
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
        entry.lastLoadAt ? kv("上次刷新快照", entry.lastLoadAt) : null,
        envRows(entry),
        headerRows(entry),
        toolsSection(entry),
        h("div", { className: "smx-detail__actions" },
          h("button", { type: "button", className: "smx-btn", onClick: () => run(entry, true) }, "查看描述"),
          h("button", { type: "button", className: "smx-btn", onClick: () => run(entry, false) }, "刷新快照"),
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
      h("div", { className: "smx-setting" },
        h("span", { className: "smx-setting__label" }, "工具描述截断（字符）"),
        h("input", {
          type: "number",
          className: "smx-input",
          value: toolDescDraft,
          min: 1,
          max: 5000,
          onChange: (e) => setToolDescDraft(e.target.value),
        }),
        h("button", { type: "button", className: "smx-btn", onClick: saveToolDesc }, "保存"),
        h("span", { className: "smx-count" }, "当前 " + toolDescMax),
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
      h(LegacySessionBanner),
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
    ".smx-legacy { display:flex; flex-direction:column; gap:4px; line-height:1.6; text-align:left; }",
    ".smx-legacy__title { font-weight:600; }",
    ".smx-legacy__code { font-family:var(--ds-font-family-code); font-size:11px; padding:1px 4px; border-radius:4px; background:var(--dsw-alias-bg-layer-2); }",
    ".smx-legacy__link { color:var(--dsw-alias-brand-primary); }",
    ".smx-legacy__note { color:var(--dsw-alias-label-secondary); }",
    // The shell overlay layer is a pointer-events:none frame-sized layer whose
    // direct children stay interactive, so the toast sizes and anchors itself.
    ".smx-toast { position:absolute; right:16px; bottom:16px; display:flex; align-items:flex-start; gap:10px; max-width:360px; padding:10px 12px; border-radius:10px; border:1px solid var(--dsw-alias-state-error-primary); background:var(--dsw-alias-bg-layer-1); box-shadow:0 8px 28px rgba(0,0,0,.18); pointer-events:auto; }",
    ".smx-toast__main { min-width:0; }",
    ".smx-toast__title { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }",
    ".smx-toast__text { margin-top:4px; font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-toast__close { border:none; background:none; color:var(--dsw-alias-label-secondary); cursor:pointer; font-size:15px; line-height:1; padding:0 2px; }",
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
    injectCss();
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: "capability",
      order: 35,
      label: "能力库",
    }, ManagerSection));
    // Frame-wide notices belong in the shell overlay, not in a settings page:
    // `shell.overlay` is a root-scope `list` slot rendered with no props inside
    // the frame's pointer-events:none layer, so the occupant positions itself
    // and everything around it stays click-through.
    ctx.slots.inject("shell.overlay", () => ctx.slots.register({
      name: "shell.overlay",
      id: "capability-legacy-sessions",
      order: 80,
    }, LegacySessionOverlay));
  }

  return { name, inject, apply };
}});
