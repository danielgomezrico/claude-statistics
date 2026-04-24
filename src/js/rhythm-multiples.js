/* Rhythm small-multiples: hour-of-day + day-of-week in one card.
 * Shared metric toggle (cost | msgs | tokens). Click-to-filter per bar.
 * TODO(stream-2): window.ClaudeMeter.filters.setHour(h), .setDow(d)
 */
(function(){
  const DOW_LABELS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const METRICS = [
    { key:"cost",   label:"Cost",   color:"#d97757", fmt:v=>"$"+(v||0).toFixed(2) },
    { key:"msgs",   label:"Msgs",   color:"#6ea8ff", fmt:v=>String(v|0) },
    { key:"tokens", label:"Tokens", color:"#22c55e", fmt:v=>fmtTok(v) },
  ];
  function fmtTok(n){
    if (n>=1e9) return (n/1e9).toFixed(2)+"B";
    if (n>=1e6) return (n/1e6).toFixed(2)+"M";
    if (n>=1e3) return (n/1e3).toFixed(1)+"k";
    return String(n|0);
  }
  function pickVal(e, metric){
    if (metric==="cost") return e.cost || 0;
    if (metric==="msgs") return 1;
    if (metric==="tokens") return (e.inTok||0)+(e.outTok||0)+(e.crTok||0)+(e.cwTok||0);
    return 0;
  }
  function setHourFilter(h){
    try {
      if (window.ClaudeMeter && window.ClaudeMeter.filters && typeof window.ClaudeMeter.filters.setHour === "function"){
        window.ClaudeMeter.filters.setHour(h); return;
      }
    } catch(_){}
    // TODO(stream-2): integrate with window.ClaudeMeter.filters.setHour
    console.log("[rhythm] filter hour (stub):", h);
  }
  function setDowFilter(d){
    try {
      if (window.ClaudeMeter && window.ClaudeMeter.filters && typeof window.ClaudeMeter.filters.setDow === "function"){
        window.ClaudeMeter.filters.setDow(d); return;
      }
    } catch(_){}
    // TODO(stream-2): integrate with window.ClaudeMeter.filters.setDow
    console.log("[rhythm] filter dow (stub):", d);
  }

  function mount(container){
    container.innerHTML = "";

    const toolbar = document.createElement("div");
    toolbar.className = "heatmap-toolbar";
    const h2 = document.createElement("h2"); h2.textContent = "Rhythm — hour of day × day of week";
    toolbar.appendChild(h2);
    const chips = document.createElement("div");
    chips.className = "metric-chips";
    chips.setAttribute("role","radiogroup");
    chips.setAttribute("aria-label","Rhythm metric");
    let current = "cost";
    METRICS.forEach(m=>{
      const b = document.createElement("button");
      b.type="button"; b.className = "metric-chip"+(m.key===current?" active":"");
      b.textContent = m.label; b.dataset.metric=m.key;
      b.setAttribute("role","radio");
      b.setAttribute("aria-checked", m.key===current?"true":"false");
      b.addEventListener("click",()=>{
        current = m.key;
        chips.querySelectorAll(".metric-chip").forEach(x=>{
          x.classList.toggle("active", x.dataset.metric===current);
          x.setAttribute("aria-checked", x.dataset.metric===current?"true":"false");
        });
        renderBoth();
      });
      chips.appendChild(b);
    });
    toolbar.appendChild(chips);

    const row = document.createElement("div");
    row.style.display = "grid";
    row.style.gridTemplateColumns = "1fr 1fr";
    row.style.gap = "16px";
    row.style.marginTop = "8px";

    const leftWrap = document.createElement("div");
    const leftLbl = document.createElement("div");
    leftLbl.className = "muted"; leftLbl.style.fontSize = "11px"; leftLbl.style.marginBottom="4px";
    leftLbl.textContent = "Hour of day (local)";
    const leftCanvas = document.createElement("canvas");
    leftCanvas.id = "chartHourOfDay";
    leftWrap.appendChild(leftLbl); leftWrap.appendChild(leftCanvas);

    const rightWrap = document.createElement("div");
    const rightLbl = document.createElement("div");
    rightLbl.className = "muted"; rightLbl.style.fontSize = "11px"; rightLbl.style.marginBottom="4px";
    rightLbl.textContent = "Day of week";
    const rightCanvas = document.createElement("canvas");
    rightCanvas.id = "chartDayOfWeek";
    rightWrap.appendChild(rightLbl); rightWrap.appendChild(rightCanvas);

    row.appendChild(leftWrap); row.appendChild(rightWrap);

    // Mobile: stack
    const mq = window.matchMedia("(max-width: 820px)");
    const applyMq = ()=>{ row.style.gridTemplateColumns = mq.matches ? "1fr" : "1fr 1fr"; };
    mq.addEventListener ? mq.addEventListener("change", applyMq) : mq.addListener(applyMq);
    applyMq();

    container.appendChild(toolbar);
    container.appendChild(row);

    const charts = { hod:null, dow:null };

    function renderBoth(){
      const events = (window.STATE && window.STATE.events) || [];
      const M = METRICS.find(m=>m.key===current) || METRICS[0];
      const hodArr = new Array(24).fill(0);
      const dowArr = new Array(7).fill(0);
      for (const e of events){
        const v = pickVal(e, current);
        hodArr[e.ts.getHours()] += v;
        dowArr[e.ts.getDay()] += v;
      }
      const axesFor = (yFmt)=>({
        x:{ticks:{color:"#8a93a6",maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{color:"#262b38"}},
        y:{ticks:{color:"#8a93a6",callback:yFmt},grid:{color:"#262b38"}}
      });
      const yFmt = (current==="cost") ? (v=>"$"+v) : (v=>v>=1000?(v/1000).toFixed(1)+"k":v);
      const tip = {
        callbacks:{ label: (ctx)=> `${M.label}: ${M.fmt(ctx.parsed.y)}` }
      };

      if (charts.hod) charts.hod.destroy();
      charts.hod = new Chart(leftCanvas, {
        type:"bar",
        data:{ labels:[...Array(24).keys()].map(h=>h+":00"),
          datasets:[{ label:M.label, data:hodArr, backgroundColor:M.color }]},
        options:{ animation:false, onClick:(_,els)=>{ if(els[0]) setHourFilter(els[0].index); },
          plugins:{ legend:{display:false}, tooltip:tip }, scales: axesFor(yFmt) }
      });

      if (charts.dow) charts.dow.destroy();
      charts.dow = new Chart(rightCanvas, {
        type:"bar",
        data:{ labels: DOW_LABELS,
          datasets:[{ label:M.label, data:dowArr, backgroundColor:M.color }]},
        options:{ animation:false, onClick:(_,els)=>{ if(els[0]) setDowFilter(els[0].index); },
          plugins:{ legend:{display:false}, tooltip:tip }, scales: axesFor(yFmt) }
      });
    }

    container.__rhythmRender = renderBoth;
    renderBoth();
  }

  window.RhythmMultiples = { mount };
})();
