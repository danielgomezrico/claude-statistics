/* A7 — Extended-thinking cost section
 *
 * Stacked bar per period: thinking-tokens vs output-tokens.
 * Toggle metric: cost · tokens · ratio (thinking/(thinking+output)).
 * Personas: Marcus (thinking-cost surprise), David.
 *
 * Reads `e.thinkTok` (parser fallback 0). Cost uses output price
 * (thinking is billed as output by Anthropic — fallback assumption).
 *
 * Public API: window.ClaudeMeter.extThinking.render()
 */
(function(){
  const NS = (window.ClaudeMeter = window.ClaudeMeter || {});
  let chart = null;
  let metric = "cost"; // cost · tokens · ratio
  let mountEl = null;

  function priceFor(model){
    const PR = window.PRICING || [];
    const m = (model||"").toLowerCase();
    return PR.find(p=>p.match && m.includes(p.match)) || PR[PR.length-1] || {in:3,out:15,cacheRead:0.3,cacheWrite:3.75};
  }
  function bucketKey(d, bucket){
    const x = new Date(d);
    if (bucket==="hour"){ x.setMinutes(0,0,0); return x.getTime(); }
    if (bucket==="day"){ x.setHours(0,0,0,0); return x.getTime(); }
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

  function aggregate(events, bucket){
    const m = new Map();
    for (const e of events){
      const k = bucketKey(e.ts, bucket);
      if (!m.has(k)) m.set(k,{ts:k,thinkTok:0,outTok:0,thinkCost:0,outCost:0});
      const a = m.get(k);
      const p = priceFor(e.model);
      const tt = e.thinkTok || 0;
      a.thinkTok += tt;
      a.outTok += e.outTok || 0;
      // thinking billed at output rate (fallback assumption)
      a.thinkCost += tt * p.out / 1e6;
      a.outCost += (e.outTok||0) * p.out / 1e6;
    }
    return [...m.values()].sort((a,b)=>a.ts-b.ts);
  }

  function mountScaffold(host){
    host.innerHTML = `
      <div class="card big">
        <div class="ext-head">
          <h2>Extended-thinking cost <span class="muted" style="font-size:11px">(thinking vs output — A7)</span></h2>
          <div class="ext-tabs" id="extThinkingTabs">
            <div class="ext-tab active" data-m="cost">$ cost</div>
            <div class="ext-tab" data-m="tokens">tokens</div>
            <div class="ext-tab" data-m="ratio">ratio</div>
          </div>
        </div>
        <canvas id="extThinkingChart"></canvas>
        <div class="ext-summary" id="extThinkingSummary"></div>
      </div>`;
    host.querySelectorAll("#extThinkingTabs .ext-tab").forEach(t=>{
      t.addEventListener("click",()=>{
        host.querySelectorAll("#extThinkingTabs .ext-tab").forEach(x=>x.classList.remove("active"));
        t.classList.add("active");
        metric = t.dataset.m;
        render();
      });
    });
  }

  function render(){
    const host = mountEl || document.getElementById("extThinking");
    if (!host) return;
    if (!host.querySelector("#extThinkingChart")) mountScaffold(host);
    mountEl = host;
    const canvas = host.querySelector("#extThinkingChart");
    const summary = host.querySelector("#extThinkingSummary");
    const events = getEvents();
    const bucket = (window.STATE && window.STATE.bucket) || "day";
    const data = aggregate(events, bucket);
    const totalThink = data.reduce((s,d)=>s+d.thinkTok,0);
    const totalOut = data.reduce((s,d)=>s+d.outTok,0);
    const totalThinkCost = data.reduce((s,d)=>s+d.thinkCost,0);
    const totalOutCost = data.reduce((s,d)=>s+d.outCost,0);

    if (!data.length || (totalThink === 0 && totalOut === 0)){
      if (chart){ chart.destroy(); chart = null; }
      canvas.style.display = "none";
      summary.innerHTML = `<span class="ext-empty" style="display:block">No thinking/output tokens in current filter range. (Older logs without <code>thinking_tokens</code> count as 0.)</span>`;
      return;
    }
    canvas.style.display = "";

    const labels = data.map(d=>fmtBucketLabel(d.ts, bucket));
    let datasets, yCallback, yTitle;
    if (metric === "cost"){
      datasets = [
        {label:"Thinking $", data:data.map(d=>d.thinkCost), backgroundColor:"#a855f7", stack:"s"},
        {label:"Output $",   data:data.map(d=>d.outCost),   backgroundColor:"#d97757", stack:"s"},
      ];
      yCallback = v=>"$"+v;
    } else if (metric === "tokens"){
      datasets = [
        {label:"Thinking tok", data:data.map(d=>d.thinkTok), backgroundColor:"#a855f7", stack:"s"},
        {label:"Output tok",   data:data.map(d=>d.outTok),   backgroundColor:"#d97757", stack:"s"},
      ];
      yCallback = v=>fmtTokAxis(v);
    } else { // ratio
      datasets = [{
        label:"Thinking / (thinking+output)",
        data:data.map(d=>{ const denom = d.thinkTok+d.outTok; return denom ? d.thinkTok/denom : 0; }),
        backgroundColor:"#a855f7", borderColor:"#a855f7"
      }];
      yCallback = v=>(v*100).toFixed(0)+"%";
    }

    if (chart){ chart.destroy(); chart = null; }
    chart = new Chart(canvas, {
      type:"bar",
      data:{labels, datasets},
      options:{
        animation:false,
        plugins:{legend:{labels:{color:"#e6e8ee",boxWidth:12,font:{size:11}}}},
        scales:{
          x:{stacked: metric!=="ratio", ticks:{color:"#8a93a6",maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{color:"#262b38"}},
          y:{stacked: metric!=="ratio", ticks:{color:"#8a93a6",callback:yCallback},grid:{color:"#262b38"},
             max: metric==="ratio" ? 1 : undefined}
        }
      }
    });

    const totalDenom = totalThink + totalOut;
    const ratio = totalDenom ? (totalThink/totalDenom*100).toFixed(1) : "0.0";
    summary.innerHTML =
      `<span>Thinking: <b>${fmtTok(totalThink)}</b> tok · <b>$${totalThinkCost.toFixed(2)}</b></span>` +
      `<span>Output: <b>${fmtTok(totalOut)}</b> tok · <b>$${totalOutCost.toFixed(2)}</b></span>` +
      `<span>Share: <b>${ratio}%</b> thinking</span>`;
  }

  function fmtTok(n){ if(n>=1e9)return(n/1e9).toFixed(2)+"B"; if(n>=1e6)return(n/1e6).toFixed(2)+"M"; if(n>=1e3)return(n/1e3).toFixed(1)+"k"; return String(n||0); }
  function fmtTokAxis(n){ if(n>=1e6)return(n/1e6).toFixed(1)+"M"; if(n>=1e3)return(n/1e3).toFixed(0)+"k"; return String(n); }

  NS.extThinking = { render, _aggregate: aggregate };
})();
