/* Cache Cluster — 5 panes. Wave 1: split (F10), gauge (F11), pill (F12).
 * Wave 2 placeholders: WASTE (F13), write-amortization (F14).
 * Metrics per 02-metrics-catalog.md.
 */
(function(){
  const CACHE_WRITE_PREMIUM = 1.25;

  function fmt$(n){ return "$"+(n||0).toLocaleString(undefined,{maximumFractionDigits:2, minimumFractionDigits:2}); }
  function fmtTok(n){
    if (n>=1e9) return (n/1e9).toFixed(2)+"B";
    if (n>=1e6) return (n/1e6).toFixed(2)+"M";
    if (n>=1e3) return (n/1e3).toFixed(1)+"k";
    return String(n|0);
  }

  function bucketKey(d, bucket){
    const x = new Date(d);
    if (bucket==="hour") { x.setMinutes(0,0,0); return x.getTime(); }
    if (bucket==="day")  { x.setHours(0,0,0,0); return x.getTime(); }
    if (bucket==="week") { x.setHours(0,0,0,0); x.setDate(x.getDate()-x.getDay()); return x.getTime(); }
    if (bucket==="month"){ return new Date(x.getFullYear(), x.getMonth(), 1).getTime(); }
    x.setHours(0,0,0,0); return x.getTime();
  }
  function fmtBucketLabel(ts, bucket){
    const d = new Date(ts);
    if (bucket==="hour")  return d.toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric"});
    if (bucket==="day")   return d.toLocaleDateString(undefined,{month:"short",day:"numeric"});
    if (bucket==="week")  return "Wk "+d.toLocaleDateString(undefined,{month:"short",day:"numeric"});
    if (bucket==="month") return d.toLocaleDateString(undefined,{year:"numeric",month:"short"});
    return d.toISOString();
  }

  function mount(container){
    container.innerHTML = "";
    container.className = "card big cache-cluster";

    const title = document.createElement("h2");
    title.className = "cluster-title";
    title.textContent = "Cache Cluster — how your tokens cache";
    container.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "cluster-grid";
    container.appendChild(grid);

    // 1. Split
    const splitPane = document.createElement("div");
    splitPane.className = "cluster-pane pane-split";
    splitPane.innerHTML = `
      <h3>Cache split over time</h3>
      <div class="pane-sub">Fresh input vs cache-read vs cache-write (cache-write carries a 1.25× premium).</div>
      <div class="split-chart-wrap"><canvas id="cacheSplitChart"></canvas></div>
    `;
    grid.appendChild(splitPane);

    // 2. Gauge
    const gaugePane = document.createElement("div");
    gaugePane.className = "cluster-pane pane-gauge";
    gaugePane.innerHTML = `
      <h3>Cache-read share</h3>
      <div class="marcus-gauge" id="cacheGauge"></div>
      <div class="pane-sub" style="text-align:center">cache-read / total input tokens</div>
    `;
    grid.appendChild(gaugePane);

    // 3. Pill (Priya)
    const pillPane = document.createElement("div");
    pillPane.className = "cluster-pane pane-pill priya-pill";
    pillPane.innerHTML = `
      <h3>This month's cache savings</h3>
      <div class="hero" id="priyaHero">$0.00</div>
      <div class="msg" id="priyaMsg">Your cache saved you <strong>$0.00</strong> this month.</div>
      <div class="sub-line" id="priyaSub">vs paying fresh-input rates for every cached token.</div>
    `;
    grid.appendChild(pillPane);

    // 4. WASTE (placeholder)
    const wastePane = document.createElement("div");
    wastePane.className = "cluster-pane pane-waste disabled";
    wastePane.innerHTML = `
      <h3>Cache WASTE</h3>
      <span class="coming-badge">Coming in Wave 2</span>
      <div class="pane-sub">Sessions where cache creation never paid off — writes without enough reads to amortize.</div>
    `;
    grid.appendChild(wastePane);

    // 5. Amortization (placeholder)
    const amortPane = document.createElement("div");
    amortPane.className = "cluster-pane pane-amort disabled";
    amortPane.innerHTML = `
      <h3>Write amortization break-even</h3>
      <span class="coming-badge">Coming in Wave 2</span>
      <div class="pane-sub">When do cache writes break even? Sessions plotted against the 5-read threshold.</div>
    `;
    grid.appendChild(amortPane);

    const charts = { split:null };

    function renderSplit(events, bucket){
      const map = new Map();
      for (const e of events){
        const k = bucketKey(e.ts, bucket);
        let a = map.get(k);
        if (!a){ a = {ts:k, fresh:0, cread:0, cwrite:0}; map.set(k,a); }
        a.fresh += e.inTok || 0;
        a.cread += e.crTok || 0;
        a.cwrite += e.cwTok || 0;
      }
      const arr = [...map.values()].sort((a,b)=>a.ts-b.ts);
      const canvas = container.querySelector("#cacheSplitChart");
      if (charts.split) charts.split.destroy();
      charts.split = new Chart(canvas, {
        type:"bar",
        data:{
          labels: arr.map(a=>fmtBucketLabel(a.ts, bucket)),
          datasets:[
            { label:"Fresh input",  data: arr.map(a=>a.fresh),  backgroundColor:"#6ea8ff", stack:"s" },
            { label:"Cache read",   data: arr.map(a=>a.cread),  backgroundColor:"#22c55e", stack:"s" },
            { label:"Cache write",  data: arr.map(a=>a.cwrite), backgroundColor:"#eab308", stack:"s" },
          ]
        },
        options:{
          animation:false, maintainAspectRatio:false,
          plugins:{
            legend:{ labels:{ color:"#e6e8ee", boxWidth:12, font:{size:11} } },
            tooltip:{
              callbacks:{
                label:(ctx)=>{
                  const v = ctx.parsed.y;
                  const base = `${ctx.dataset.label}: ${fmtTok(v)} tokens`;
                  if (ctx.dataset.label === "Cache write"){
                    return `${base} (1.25× write premium applies)`;
                  }
                  return base;
                }
              }
            }
          },
          scales:{
            x:{stacked:true, ticks:{color:"#8a93a6",maxRotation:0,autoSkip:true,maxTicksLimit:12}, grid:{color:"#262b38"}},
            y:{stacked:true, ticks:{color:"#8a93a6", callback:v=>fmtTok(v)}, grid:{color:"#262b38"}}
          }
        }
      });
    }

    function renderGauge(events){
      let cread = 0, fresh = 0, cwrite = 0;
      for (const e of events){ cread += e.crTok||0; fresh += e.inTok||0; cwrite += e.cwTok||0; }
      const totalInput = cread + fresh + cwrite;
      const ratio = totalInput ? cread / totalInput : 0;
      const host = container.querySelector("#cacheGauge");
      host.innerHTML = "";
      const pct = (ratio*100).toFixed(0);
      // Colorblind-safe viridis steps for ratio bands
      const color = ratio < 0.2 ? "#3b2f6b"
                  : ratio < 0.4 ? "#3b5488"
                  : ratio < 0.6 ? "#2a7b8b"
                  : ratio < 0.8 ? "#3ba07a"
                  : "#a5c858";
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("viewBox","0 0 100 60");
      svg.setAttribute("aria-label", `Cache-read share: ${pct} percent`);
      // Background arc
      const bg = document.createElementNS(NS,"path");
      bg.setAttribute("d","M 10 55 A 40 40 0 0 1 90 55");
      bg.setAttribute("stroke","#262b38"); bg.setAttribute("stroke-width","10");
      bg.setAttribute("fill","none"); bg.setAttribute("stroke-linecap","round");
      svg.appendChild(bg);
      // Foreground arc
      const fg = document.createElementNS(NS,"path");
      fg.setAttribute("d","M 10 55 A 40 40 0 0 1 90 55");
      fg.setAttribute("stroke", color); fg.setAttribute("stroke-width","10");
      fg.setAttribute("fill","none"); fg.setAttribute("stroke-linecap","round");
      const arcLen = Math.PI * 40; // half circle
      fg.setAttribute("stroke-dasharray", `${arcLen}`);
      fg.setAttribute("stroke-dashoffset", `${arcLen * (1 - ratio)}`);
      svg.appendChild(fg);
      host.appendChild(svg);
      const hero = document.createElement("div");
      hero.className = "hero"; hero.textContent = pct + "%";
      const heroSub = document.createElement("div");
      heroSub.className = "hero-sub"; heroSub.textContent = "cache-read";
      host.appendChild(hero); host.appendChild(heroSub);
    }

    function renderPill(events){
      const now = new Date();
      const mStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      let savings = 0;
      let cachedTok = 0;
      let PRICING = null;
      try { PRICING = window.PRICING; } catch(_){}
      const priceFor = (model)=>{
        if (!PRICING) return { in:3, cacheRead:0.3 };
        const m = (model||"").toLowerCase();
        return PRICING.find(p=>p.match && m.includes(p.match)) || PRICING[PRICING.length-1];
      };
      for (const e of events){
        if (e.ts.getTime() < mStart) continue;
        const p = priceFor(e.model);
        const cr = e.crTok || 0;
        if (cr > 0){
          // savings = cr * (fresh-input-rate − cache-read-rate) / 1e6
          savings += cr * (p.in - p.cacheRead) / 1e6;
          cachedTok += cr;
        }
      }
      const heroEl = container.querySelector("#priyaHero");
      const msgEl = container.querySelector("#priyaMsg");
      const subEl = container.querySelector("#priyaSub");
      heroEl.textContent = fmt$(savings);
      msgEl.innerHTML = savings > 0
        ? `Your cache saved you <strong>${fmt$(savings)}</strong> this month.`
        : `No cache reads this month yet — savings will appear here.`;
      subEl.textContent = cachedTok > 0
        ? `${fmtTok(cachedTok)} cache-read tokens vs fresh-input rates.`
        : "vs paying fresh-input rates for every cached token.";
    }

    function renderAll(){
      const events = (window.STATE && window.STATE.events) || [];
      const bucket = (window.STATE && window.STATE.bucket) || "day";
      renderSplit(events, bucket);
      renderGauge(events);
      renderPill(events);
    }

    container.__cacheClusterRender = renderAll;
    renderAll();
  }

  window.CacheCluster = { mount };
})();
