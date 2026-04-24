/* A13 — Region breakdown (inference_geo)
 *
 * Horizontal ranked bars: region · calls · cost · Δ% (vs prior period).
 * Compliance allowlist: localStorage `cm.regions.allowlist` (CSV of region codes).
 * Off-allowlist regions get a red border + "off-policy" pill.
 *
 * Personas: Sofia (compliance), David.
 *
 * Reads `e.region` (parser fallback null → labelled "unknown").
 *
 * Public API: window.ClaudeMeter.regionBreakdown.render()
 */
(function(){
  const NS = (window.ClaudeMeter = window.ClaudeMeter || {});
  const LS_KEY = "cm.regions.allowlist";
  let mountEl = null;

  function getAllowlist(){
    try {
      const v = localStorage.getItem(LS_KEY);
      if (!v) return [];
      return v.split(",").map(s=>s.trim()).filter(Boolean);
    } catch(_) { return []; }
  }
  function setAllowlist(list){
    try { localStorage.setItem(LS_KEY, (list||[]).join(",")); } catch(_) {}
  }

  function getEvents(){
    const all = (window.STATE && window.STATE.events) || [];
    if (NS.filterBar && typeof NS.filterBar.applyFilters === "function") {
      try { return NS.filterBar.applyFilters(all); } catch(_){ return all; }
    }
    return all;
  }
  function regionOf(e){ return e.region || "unknown"; }

  // Split events into "current" and "prior" halves of the active range.
  function partitionByMidpoint(events){
    if (!events.length) return [[],[]];
    let lo = events[0].ts.getTime ? events[0].ts.getTime() : +events[0].ts;
    let hi = lo;
    for (const e of events){
      const t = e.ts.getTime ? e.ts.getTime() : +e.ts;
      if (t < lo) lo = t; if (t > hi) hi = t;
    }
    const mid = lo + (hi-lo)/2;
    const cur = [], prior = [];
    for (const e of events){
      const t = e.ts.getTime ? e.ts.getTime() : +e.ts;
      if (t >= mid) cur.push(e); else prior.push(e);
    }
    return [cur, prior];
  }

  function aggregate(events){
    const m = new Map();
    for (const e of events){
      const r = regionOf(e);
      if (!m.has(r)) m.set(r, {region:r, calls:0, cost:0});
      const a = m.get(r);
      a.calls += 1;
      a.cost += e.cost || 0;
    }
    return m;
  }

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

  function mountScaffold(host){
    host.innerHTML = `
      <div class="card big">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:8px">
          <h2 style="margin:0">Region breakdown <span class="muted" style="font-size:11px">(inference_geo — A13)</span></h2>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <label style="margin:0;font-size:11px;color:var(--muted)">Compliance allowlist (csv):</label>
            <input type="text" id="rgAllowlist" placeholder="us-east-1,eu-west-1" style="min-width:200px;font-size:12px"/>
            <button type="button" class="btn" id="rgSaveAllow" style="font-size:11px;padding:4px 10px">Save</button>
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:13px" id="rgTable">
          <thead><tr>
            <th>Region</th>
            <th class="num">Calls</th>
            <th class="num">Cost</th>
            <th class="num">Δ% (calls)</th>
            <th></th>
          </tr></thead>
          <tbody></tbody>
        </table>
        <div class="muted" style="font-size:11px;margin-top:8px" id="rgEmpty"></div>
      </div>`;

    const inp = host.querySelector("#rgAllowlist");
    inp.value = getAllowlist().join(",");
    host.querySelector("#rgSaveAllow").addEventListener("click",()=>{
      const list = inp.value.split(",").map(s=>s.trim()).filter(Boolean);
      setAllowlist(list);
      render();
    });
    inp.addEventListener("keydown",(ev)=>{
      if (ev.key === "Enter"){ ev.preventDefault(); host.querySelector("#rgSaveAllow").click(); }
    });
  }

  function render(){
    const host = mountEl || document.getElementById("regionBreakdown");
    if (!host) return;
    if (!host.querySelector("#rgTable")) mountScaffold(host);
    mountEl = host;
    const tbody = host.querySelector("#rgTable tbody");
    const emptyEl = host.querySelector("#rgEmpty");
    const events = getEvents();

    if (!events.length){
      tbody.innerHTML = "";
      emptyEl.textContent = "No events in current filter range.";
      return;
    }
    const [cur, prior] = partitionByMidpoint(events);
    const curAgg = aggregate(cur);
    const priorAgg = aggregate(prior);
    const allowlist = getAllowlist();

    const rows = [...curAgg.values()].sort((a,b)=>b.calls-a.calls);
    const maxCalls = Math.max(1, ...rows.map(r=>r.calls));
    const totalCost = rows.reduce((s,r)=>s+r.cost,0);

    if (!rows.length){
      tbody.innerHTML = "";
      emptyEl.textContent = "No region data parsed (older logs without inference_geo show as 'unknown').";
      return;
    }
    emptyEl.textContent = allowlist.length
      ? `Allowlist: ${allowlist.join(", ")} · regions outside this set are flagged off-policy.`
      : "No allowlist set. Enter comma-separated region codes to flag off-policy traffic.";

    tbody.innerHTML = "";
    for (const r of rows){
      const prev = priorAgg.get(r.region);
      const dPct = prev && prev.calls
        ? ((r.calls - prev.calls)/prev.calls*100)
        : (r.calls > 0 ? 100 : 0);
      const dCls = dPct > 5 ? "good" : (dPct < -5 ? "bad" : "");
      const dTxt = (dPct >= 0 ? "+" : "") + dPct.toFixed(0) + "%";
      const offPolicy = allowlist.length && allowlist.indexOf(r.region) === -1;
      const barW = Math.round((r.calls/maxCalls) * 100);
      const barColor = offPolicy ? "#ef4444" : "#6ea8ff";
      const pct = totalCost ? (r.cost/totalCost*100).toFixed(0) : "0";
      const flag = offPolicy ? `<span class="pill bad" style="margin-left:6px">off-policy</span>` : "";
      tbody.insertAdjacentHTML("beforeend",
        `<tr>
          <td><code>${escapeHtml(r.region)}</code>${flag}</td>
          <td class="num">${r.calls.toLocaleString()}</td>
          <td class="num">$${r.cost.toFixed(2)} <span class="muted" style="font-size:10px">(${pct}%)</span></td>
          <td class="num"><span class="pill ${dCls}">${dTxt}</span></td>
          <td style="width:30%">
            <div style="height:8px;background:var(--panel2);border:1px solid var(--border);border-radius:999px;overflow:hidden">
              <div style="width:${barW}%;height:100%;background:${barColor}"></div>
            </div>
          </td>
        </tr>`);
    }
  }

  NS.regionBreakdown = {
    render,
    getAllowlist, setAllowlist,
    _aggregate: aggregate
  };
})();
