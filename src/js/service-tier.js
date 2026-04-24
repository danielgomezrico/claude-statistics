/* A12 — Service-tier breakdown
 *
 * Per-day stacked bar (priority · standard · batch · unknown) + ratio overlay.
 * Toggle metric: cost · calls.
 * Personas: Marcus, Jake, David.
 *
 * Reads `e.serviceTier` (parser fallback "unknown").
 *
 * Public API: window.ClaudeMeter.serviceTier.render()
 */
(function(){
  const NS = (window.ClaudeMeter = window.ClaudeMeter || {});
  let chart = null;
  let metric = "cost"; // cost · calls
  let mountEl = null;

  const TIERS = ["priority","standard","batch","unknown"];
  const TIER_COLORS = {
    priority: "#ef4444",
    standard: "#6ea8ff",
    batch:    "#22c55e",
    unknown:  "#8a93a6",
  };

  function bucketKey(d, bucket){
    const x = new Date(d);
    if (bucket==="hour"){ x.setMinutes(0,0,0); return x.getTime(); }
    if (bucket==="week"){ const day=x.getDay(); x.setHours(0,0,0,0); x.setDate(x.getDate()-day); return x.getTime(); }
    if (bucket==="month") return new Date(x.getFullYear(), x.getMonth(), 1).getTime();
    x.setHours(0,0,0,0); return x.getTime();
  }
  function fmtBucketLabel(ts, bucket){
    const d = new Date(ts);
    if (bucket==="hour") return d.toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric"});
    if (bucket==="week") return "Wk "+d.toLocaleDateString(undefined,{month:"short",day:"numeric"});
    if (bucket==="month") return d.toLocaleDateString(undefined,{year:"numeric",month:"short"});
    return d.toLocaleDateString(undefined,{month:"short",day:"numeric"});
  }
  function getEvents(){
    const all = (window.STATE && window.STATE.events) || [];
    if (NS.filterBar && typeof NS.filterBar.applyFilters === "function") {
      try { return NS.filterBar.applyFilters(all); } catch(_){ return all; }
    }
    return all;
  }
  function tierOf(e){
    const t = (e.serviceTier || "unknown").toLowerCase();
    if (TIERS.indexOf(t) >= 0) return t;
    return "unknown";
  }

  function aggregate(events, bucket){
    const m = new Map();
    for (const e of events){
      const k = bucketKey(e.ts, bucket);
      if (!m.has(k)){
        const seed = {ts:k};
        for (const t of TIERS){ seed["cost_"+t] = 0; seed["calls_"+t] = 0; }
        m.set(k, seed);
      }
      const a = m.get(k);
      const t = tierOf(e);
      a["cost_"+t] += e.cost || 0;
      a["calls_"+t] += 1;
    }
    return [...m.values()].sort((a,b)=>a.ts-b.ts);
  }

  function mountScaffold(host){
    host.innerHTML = `
      <div class="card big">
        <div class="st-head">
          <h2>Service-tier breakdown <span class="muted" style="font-size:11px">(priority / standard / batch — A12)</span></h2>
          <div class="st-tabs" id="serviceTierTabs">
            <div class="st-tab active" data-m="cost">$ cost</div>
            <div class="st-tab" data-m="calls">calls</div>
          </div>
        </div>
        <canvas id="serviceTierChart"></canvas>
        <div class="st-summary" id="serviceTierSummary"></div>
      </div>`;
    host.querySelectorAll("#serviceTierTabs .st-tab").forEach(t=>{
      t.addEventListener("click",()=>{
        host.querySelectorAll("#serviceTierTabs .st-tab").forEach(x=>x.classList.remove("active"));
        t.classList.add("active");
        metric = t.dataset.m;
        render();
      });
    });
  }

  function render(){
    const host = mountEl || document.getElementById("serviceTier");
    if (!host) return;
    if (!host.querySelector("#serviceTierChart")) mountScaffold(host);
    mountEl = host;
    const canvas = host.querySelector("#serviceTierChart");
    const summary = host.querySelector("#serviceTierSummary");
    const events = getEvents();
    const bucket = (window.STATE && window.STATE.bucket) || "day";
    const data = aggregate(events, bucket);

    if (!data.length){
      if (chart){ chart.destroy(); chart = null; }
      canvas.style.display = "none";
      summary.innerHTML = `<span class="st-empty" style="display:block">No events in current filter range.</span>`;
      return;
    }
    canvas.style.display = "";

    const labels = data.map(d=>fmtBucketLabel(d.ts, bucket));
    const prefix = metric === "cost" ? "cost_" : "calls_";
    const datasets = TIERS.map(t=>({
      label: t, data: data.map(d=>d[prefix+t]),
      backgroundColor: TIER_COLORS[t], stack:"s"
    }));

    if (chart){ chart.destroy(); chart = null; }
    chart = new Chart(canvas, {
      type:"bar",
      data:{labels, datasets},
      options:{
        animation:false,
        plugins:{legend:{labels:{color:"#e6e8ee",boxWidth:12,font:{size:11}}},
                 tooltip:{callbacks:{label:(ctx)=>{
                   const v = ctx.raw||0;
                   if (metric === "cost") return ctx.dataset.label+": $"+v.toFixed(2);
                   return ctx.dataset.label+": "+v.toLocaleString();
                 }}}},
        scales:{
          x:{stacked:true, ticks:{color:"#8a93a6",maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{color:"#262b38"}},
          y:{stacked:true, ticks:{color:"#8a93a6",
             callback: metric === "cost" ? (v=>"$"+v) : (v=>v.toLocaleString())},grid:{color:"#262b38"}}
        }
      }
    });

    // Summary chips
    const totals = {};
    let grandCost = 0, grandCalls = 0;
    for (const t of TIERS){ totals[t] = {cost:0, calls:0}; }
    for (const d of data){
      for (const t of TIERS){
        totals[t].cost += d["cost_"+t];
        totals[t].calls += d["calls_"+t];
        grandCost += d["cost_"+t];
        grandCalls += d["calls_"+t];
      }
    }
    const chips = TIERS.map(t=>{
      const pct = grandCost ? (totals[t].cost/grandCost*100).toFixed(0) : "0";
      return `<span class="st-chip" style="border-color:${TIER_COLORS[t]}55">`+
             `<span style="color:${TIER_COLORS[t]}">${t}</span> · `+
             `<b>$${totals[t].cost.toFixed(2)}</b> · <b>${totals[t].calls.toLocaleString()}</b> calls · ${pct}%`+
             `</span>`;
    }).join("");
    summary.innerHTML = chips;
  }

  NS.serviceTier = { render, _aggregate: aggregate, _tiers: TIERS };
})();
