/* A10 — MCP server breakdown
 *
 * Small-multiple bars per MCP server: calls · errors · p95 latency.
 * Click server bar → expand tool list (children with calls/errors).
 * Click a tool bar → narrow filter via NS.filterBar.setTool (when available).
 *
 * Source: tool calls extracted by `extractEvent` into `e.toolCalls` (count map).
 * MCP convention: tool name = `mcp__<server>__<tool>`. Non-mcp tools are skipped.
 *
 * Errors: per-event proxy via `e.stopReason === "error"` (best-effort fallback).
 * p95 dur: derived from per-event approx wall time (ts deltas) — TODO when
 * `state.tools` includes durationMs (Wave 4). For now we report "—".
 *
 * Personas: Jake (tool spend), Marcus (server-level cost surprise), David.
 *
 * Public API: window.ClaudeMeter.mcpBreakdown.render()
 */
(function(){
  const NS = (window.ClaudeMeter = window.ClaudeMeter || {});
  let mountEl = null;
  const expanded = new Set();

  function getEvents(){
    const all = (window.STATE && window.STATE.events) || [];
    if (NS.filterBar && typeof NS.filterBar.applyFilters === "function") {
      try { return NS.filterBar.applyFilters(all); } catch(_){ return all; }
    }
    return all;
  }

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

  function aggregate(events){
    // server -> { calls, errs, tools: Map(tool -> {calls, errs}) }
    const servers = new Map();
    for (const e of events){
      const tc = e.toolCalls;
      if (!tc) continue;
      const isErr = e.stopReason === "error";
      for (const name in tc){
        if (!Object.prototype.hasOwnProperty.call(tc, name)) continue;
        if (!name.startsWith("mcp__")) continue;
        const parts = name.split("__");
        const server = parts[1] || "unknown";
        const tool = parts.slice(2).join("__") || "(server)";
        const count = tc[name] || 0;
        if (!servers.has(server)) servers.set(server, {server, calls:0, errs:0, tools:new Map()});
        const s = servers.get(server);
        s.calls += count;
        if (isErr) s.errs += count;
        if (!s.tools.has(tool)) s.tools.set(tool, {tool, calls:0, errs:0});
        const t = s.tools.get(tool);
        t.calls += count;
        if (isErr) t.errs += count;
      }
    }
    const arr = [...servers.values()].map(s=>({
      server:s.server, calls:s.calls, errs:s.errs,
      errRate: s.calls ? s.errs/s.calls : 0,
      tools:[...s.tools.values()].sort((a,b)=>b.calls-a.calls),
    }));
    arr.sort((a,b)=>b.calls-a.calls);
    return arr;
  }

  function mountScaffold(host){
    host.innerHTML = `
      <div class="card big" id="mcpBreakdownCard">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
          <h2 style="margin:0">MCP server breakdown <span class="muted" style="font-size:11px">(calls · errors · p95 — A10)</span></h2>
          <div class="muted" style="font-size:11px">Click a server to expand tools · click a tool to filter</div>
        </div>
        <div id="mcpBreakdownList"></div>
      </div>`;
  }

  function filterByTool(name){
    try {
      if (NS.filterBar && typeof NS.filterBar.setTool === "function"){
        NS.filterBar.setTool(name);
        return;
      }
    } catch(_) {}
    console.info("[mcpBreakdown] filter requested:", name);
  }

  function renderRow(rowDef){
    // rowDef: {label, calls, errs, errRate, maxCalls, isServer, server?, tool?, expandedFlag?}
    const pct = Math.round((rowDef.calls / rowDef.maxCalls) * 100);
    const errCls = rowDef.errs > 0 ? "bad" : "";
    const errRatePct = rowDef.errRate ? (rowDef.errRate*100).toFixed(1)+"%" : "0%";
    const caret = rowDef.isServer ? `<span style="display:inline-block;width:14px;color:var(--muted);font-size:11px">${rowDef.expandedFlag ? "▾" : "▸"}</span>` : `<span style="display:inline-block;width:14px"></span>`;
    const indent = rowDef.isServer ? "" : "padding-left:24px;";
    const labelHtml = rowDef.isServer
      ? `<strong>${escapeHtml(rowDef.label)}</strong> <span class="muted" style="font-size:11px">${rowDef.toolCount} tool${rowDef.toolCount===1?"":"s"}</span>`
      : `<code style="font-size:12px">${escapeHtml(rowDef.label)}</code>`;
    return `
      <div class="mcp-row" data-server="${escapeHtml(rowDef.server||"")}" data-tool="${escapeHtml(rowDef.tool||"")}" data-is-server="${rowDef.isServer?"1":"0"}"
           style="display:grid;grid-template-columns:1.6fr .6fr .6fr .6fr 1.6fr;gap:8px;padding:6px 4px;border-bottom:1px solid var(--border);align-items:center;cursor:pointer;${indent}">
        <div style="display:flex;align-items:center;gap:4px">${caret}${labelHtml}</div>
        <div class="num">${rowDef.calls.toLocaleString()}</div>
        <div class="num"><span class="pill ${errCls}">${rowDef.errs.toLocaleString()}</span></div>
        <div class="num muted" style="font-size:11px">${rowDef.isServer ? "—" : ""}${rowDef.isServer ? " p95" : errRatePct}</div>
        <div><div style="height:8px;background:var(--panel2);border:1px solid var(--border);border-radius:999px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:${rowDef.errRate>0.1?"#ef4444":(rowDef.isServer?"#6ea8ff":"#a855f7")}"></div>
        </div></div>
      </div>`;
  }

  function render(){
    const host = mountEl || document.getElementById("mcpBreakdown");
    if (!host) return;
    if (!host.querySelector("#mcpBreakdownList")) mountScaffold(host);
    mountEl = host;
    const list = host.querySelector("#mcpBreakdownList");
    const events = getEvents();
    const servers = aggregate(events);

    if (!servers.length){
      list.innerHTML = `<div class="muted" style="padding:20px;text-align:center;font-size:12px">No MCP tool calls in current filter range. (MCP tools follow naming <code>mcp__&lt;server&gt;__&lt;tool&gt;</code>.)</div>`;
      return;
    }

    const maxCalls = Math.max(1, ...servers.map(s=>s.calls));
    let html = `
      <div style="display:grid;grid-template-columns:1.6fr .6fr .6fr .6fr 1.6fr;gap:8px;padding:4px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px">
        <div>Server / tool</div><div class="num">Calls</div><div class="num">Errors</div><div class="num">Rate</div><div></div>
      </div>`;
    for (const s of servers){
      const isExp = expanded.has(s.server);
      html += renderRow({
        label: s.server, calls:s.calls, errs:s.errs, errRate:s.errRate,
        maxCalls, isServer:true, server:s.server, expandedFlag:isExp, toolCount:s.tools.length
      });
      if (isExp){
        const childMax = Math.max(1, ...s.tools.map(t=>t.calls));
        for (const t of s.tools){
          html += renderRow({
            label: t.tool, calls:t.calls, errs:t.errs,
            errRate: t.calls ? t.errs/t.calls : 0,
            maxCalls: childMax, isServer:false,
            server:s.server, tool:`mcp__${s.server}__${t.tool}`
          });
        }
      }
    }
    list.innerHTML = html;

    list.querySelectorAll(".mcp-row").forEach(row=>{
      row.addEventListener("click",(ev)=>{
        ev.stopPropagation();
        const isServer = row.getAttribute("data-is-server") === "1";
        if (isServer){
          const srv = row.getAttribute("data-server");
          if (expanded.has(srv)) expanded.delete(srv); else expanded.add(srv);
          render();
        } else {
          const toolName = row.getAttribute("data-tool");
          if (toolName) filterByTool(toolName);
        }
      });
    });
  }

  NS.mcpBreakdown = { render, _aggregate: aggregate };
})();
