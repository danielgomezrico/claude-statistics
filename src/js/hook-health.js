/* Zone D · A9 — Hook Health Panel
 *
 * Horizontal bar list: hook name · invocations · errors · p95 dur · last seen.
 * Derived from:
 *   - progress[hook_progress]        → data.hookName + data.hookEvent (live fire)
 *   - system[stop_hook_summary]      → hookInfos[] (durations) + hookErrors[]
 *   - generic events tagged as PreToolUse/PostToolUse/Stop/SubagentStop
 *
 * Expected input (from parser — see index.html ingest):
 *   window.ClaudeMeter.state.hooks = [
 *     { name, event, ts(Date), session, durationMs?, isError? }
 *   ]
 *
 * Public API:
 *   window.ClaudeMeter.hookHealth.render(mountEl)
 */
(function () {
  const NS = (window.ClaudeMeter = window.ClaudeMeter || {});
  NS.state = NS.state || {};

  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[idx];
  }
  function fmtMs(n) {
    if (!n || n < 1) return "—";
    if (n < 1000) return Math.round(n) + "ms";
    return (n / 1000).toFixed(n < 10000 ? 2 : 1) + "s";
  }
  function fmtRel(ts) {
    if (!ts) return "—";
    const now = Date.now();
    const then = ts instanceof Date ? ts.getTime() : +new Date(ts);
    const diff = Math.max(0, now - then);
    const s = diff / 1000;
    if (s < 60) return Math.floor(s) + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 86400 * 30) return Math.floor(s / 86400) + "d ago";
    return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    }[c]));
  }

  function aggregate(hooks) {
    const map = new Map();
    for (const h of hooks) {
      // Compose a display key: prefer explicit name; fall back to event label.
      const key = h.name || h.event || "unknown";
      if (!map.has(key)) {
        map.set(key, {
          name: key,
          event: h.event || "",
          invocations: 0,
          errors: 0,
          durs: [],
          lastTs: null,
          errorSessions: new Set()
        });
      }
      const r = map.get(key);
      r.invocations++;
      if (h.isError) {
        r.errors++;
        if (h.session) r.errorSessions.add(h.session);
      }
      if (typeof h.durationMs === "number" && isFinite(h.durationMs)) r.durs.push(h.durationMs);
      const ts = h.ts instanceof Date ? h.ts : (h.ts ? new Date(h.ts) : null);
      if (ts && (!r.lastTs || ts > r.lastTs)) r.lastTs = ts;
    }
    const rows = [];
    for (const r of map.values()) {
      const sorted = r.durs.slice().sort((a, z) => a - z);
      rows.push({
        name: r.name,
        event: r.event,
        invocations: r.invocations,
        errors: r.errors,
        errorRate: r.invocations ? r.errors / r.invocations : 0,
        p95: percentile(sorted, 0.95),
        lastTs: r.lastTs,
        errorSessions: [...r.errorSessions]
      });
    }
    rows.sort((a, z) => (z.errors - a.errors) || (z.invocations - a.invocations));
    return rows;
  }

  function openHookFailureSession(row) {
    try {
      const target = row.errorSessions[0];
      if (NS.sessionExplorer && typeof NS.sessionExplorer.openSession === "function") {
        NS.sessionExplorer.openSession(target || null);
        return;
      }
    } catch (_) { /* ignore */ }
    const msg = row.errors
      ? `${row.name}: ${row.errors} error${row.errors === 1 ? "" : "s"} across ${row.errorSessions.length} session(s).\nSession explorer not available yet (Stream 5).`
      : `${row.name}: no errors recorded.`;
    alert(msg);
  }

  function mountScaffold(mount) {
    mount.innerHTML = `
      <div class="card big" id="zd-hook-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
          <h2 style="margin:0">Hook health</h2>
          <div class="zone-sub">A9 · Stop · SubagentStop · PreToolUse · PostToolUse</div>
        </div>
        <div class="hook-header">
          <div>Hook</div>
          <div class="num">Calls</div>
          <div class="num">Errors</div>
          <div class="num">p95 dur</div>
          <div class="hook-bar-col">Last seen</div>
        </div>
        <div class="hook-list" id="zd-hook-list"></div>
      </div>`;
  }

  function render(mount) {
    if (!mount) return;
    if (!mount.querySelector("#zd-hook-list")) mountScaffold(mount);
    const list = mount.querySelector("#zd-hook-list");
    if (!list) return;
    list.innerHTML = "";

    const hooks = (NS.state && NS.state.hooks) || [];
    if (!hooks.length) {
      const empty = document.createElement("div");
      empty.className = "hook-empty";
      empty.textContent = "No hook events in current filter range.";
      list.appendChild(empty);
      return;
    }

    const rows = aggregate(hooks);
    const maxCalls = Math.max(...rows.map(r => r.invocations), 1);

    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "hook-row" + (r.errors > 0 ? " has-errors" : "");
      row.title = `${r.name}${r.event && r.event !== r.name ? " · " + r.event : ""}`;
      const pct = Math.round((r.invocations / maxCalls) * 100);
      const errCls = r.errors > 0 ? "num err" : "num err zero";
      row.innerHTML =
        `<div class="hook-name">${escapeHtml(r.name)}</div>` +
        `<div class="num">${r.invocations.toLocaleString()}</div>` +
        `<div class="${errCls}">${r.errors.toLocaleString()}</div>` +
        `<div class="num">${fmtMs(r.p95)}</div>` +
        `<div class="hook-bar-col" style="display:flex;align-items:center;gap:8px">` +
          `<div class="hook-bar" style="flex:1"><div style="width:${pct}%"></div></div>` +
          `<span class="last-seen">${escapeHtml(fmtRel(r.lastTs))}</span>` +
        `</div>`;
      row.addEventListener("click", () => openHookFailureSession(r));
      list.appendChild(row);
    }
  }

  NS.hookHealth = { render, _aggregate: aggregate };
})();
