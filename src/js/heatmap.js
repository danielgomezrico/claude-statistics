/* Heatmap: 24 cols (hours) × N rows (weeks).
 * Reads STATE.events; metric: cost|msgs|tokens|cache%.
 * Click-to-filter narrows global range (delegated to Stream 2 filters API).
 * TODO(stream-2): window.ClaudeMeter.filters.setRange(start, end)
 */
(function(){
  const BIN_CLASSES = ["hm-bin-0","hm-bin-1","hm-bin-2","hm-bin-3","hm-bin-4","hm-bin-5","hm-bin-6"];
  const DAY_MS = 86400000;
  const HOUR_MS = 3600000;
  const WEEK_MS = 7 * DAY_MS;

  const METRICS = [
    { key:"cost",   label:"Cost",    fmt:v=>"$"+(v||0).toFixed(2) },
    { key:"msgs",   label:"Msgs",    fmt:v=>String(v|0) },
    { key:"tokens", label:"Tokens",  fmt:v=>fmtTok(v) },
    { key:"cache",  label:"Cache %", fmt:v=>(v*100).toFixed(0)+"%" },
  ];

  function fmtTok(n){
    if (n>=1e9) return (n/1e9).toFixed(2)+"B";
    if (n>=1e6) return (n/1e6).toFixed(2)+"M";
    if (n>=1e3) return (n/1e3).toFixed(1)+"k";
    return String(n|0);
  }

  function weekStart(d){
    const x = new Date(d);
    x.setHours(0,0,0,0);
    x.setDate(x.getDate() - x.getDay()); // Sunday anchor
    return x.getTime();
  }

  // Aggregate events into { [weekStart]: { [hour]: {cost, msgs, tokens, fresh, cached} } }
  function aggregate(events){
    const weeks = new Map();
    for (const e of events){
      const wk = weekStart(e.ts);
      let hmap = weeks.get(wk);
      if (!hmap){ hmap = new Map(); weeks.set(wk, hmap); }
      const h = e.ts.getHours();
      let cell = hmap.get(h);
      if (!cell){ cell = { cost:0, msgs:0, tokens:0, fresh:0, cached:0 }; hmap.set(h, cell); }
      cell.cost += e.cost;
      cell.msgs += 1;
      cell.tokens += (e.inTok||0) + (e.outTok||0) + (e.crTok||0) + (e.cwTok||0);
      cell.fresh += (e.inTok||0) + (e.cwTok||0);
      cell.cached += (e.crTok||0);
    }
    return weeks;
  }

  function pickMetric(cell, metric){
    if (!cell) return 0;
    if (metric === "cost") return cell.cost;
    if (metric === "msgs") return cell.msgs;
    if (metric === "tokens") return cell.tokens;
    if (metric === "cache"){
      const t = cell.fresh + cell.cached;
      return t ? cell.cached / t : 0;
    }
    return 0;
  }

  function computeBins(max, metric){
    // 7 bins (including 0). Thresholds are equally spaced for cache% (0..1),
    // and quantile-ish (power curve) for cost/msgs/tokens.
    if (metric === "cache"){
      return [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9];
    }
    if (max <= 0) return [0,0,0,0,0,0,0];
    // Power curve for nicer distribution
    return [0, 0.05, 0.12, 0.25, 0.45, 0.7, 0.9].map(p => max * p);
  }

  function binFor(value, thresholds){
    let idx = 0;
    for (let i=0; i<thresholds.length; i++){
      if (value >= thresholds[i]) idx = i;
    }
    if (value <= 0) return 0;
    return idx;
  }

  function setFilterRange(start, end){
    try {
      if (window.ClaudeMeter && window.ClaudeMeter.filters && typeof window.ClaudeMeter.filters.setRange === "function"){
        window.ClaudeMeter.filters.setRange(start, end);
        return;
      }
    } catch(_) {}
    // TODO(stream-2): integrate with window.ClaudeMeter.filters.setRange
    console.log("[heatmap] filter range (stub):", new Date(start).toISOString(), "→", new Date(end).toISOString());
  }

  function fmtWeekLabel(wkTs){
    const d = new Date(wkTs);
    return "Wk " + d.toLocaleDateString(undefined, { month:"short", day:"numeric" });
  }

  function fmtFullDate(wkTs){
    return new Date(wkTs).toLocaleDateString(undefined, { month:"short", day:"numeric", year:"numeric" });
  }

  function render(container, events, metric){
    container.innerHTML = "";
    container.className = "heatmap-card";

    const weeks = aggregate(events);
    const weekKeys = [...weeks.keys()].sort((a,b)=>a-b);

    // Compute max for chosen metric across all cells
    let max = 0;
    for (const [, hmap] of weeks){
      for (let h=0; h<24; h++){
        const v = pickMetric(hmap.get(h), metric);
        if (v > max) max = v;
      }
    }
    const thresholds = computeBins(max, metric);
    const M = METRICS.find(m=>m.key===metric) || METRICS[0];

    // Build grid
    const grid = document.createElement("div");
    grid.className = "heatmap-grid";
    grid.setAttribute("role","grid");
    grid.setAttribute("aria-label","Activity heatmap by week and hour");

    // Corner
    const corner = document.createElement("div"); corner.className = "hm-corner";
    grid.appendChild(corner);
    // Column headers (hours)
    for (let h=0; h<24; h++){
      const col = document.createElement("div"); col.className = "hm-colhdr";
      col.textContent = h % 3 === 0 ? String(h) : "";
      grid.appendChild(col);
    }

    const cells = [];
    for (let r=0; r<weekKeys.length; r++){
      const wk = weekKeys[r];
      const rowLbl = document.createElement("div");
      rowLbl.className = "hm-rowhdr";
      rowLbl.textContent = fmtWeekLabel(wk);
      grid.appendChild(rowLbl);

      for (let h=0; h<24; h++){
        const hmap = weeks.get(wk);
        const cellData = hmap ? hmap.get(h) : null;
        const v = pickMetric(cellData, metric);
        const bin = binFor(v, thresholds);
        const cell = document.createElement("div");
        cell.className = "hm-cell " + BIN_CLASSES[bin];
        cell.setAttribute("role","gridcell");
        cell.tabIndex = (r===0 && h===0) ? 0 : -1;
        cell.dataset.row = r;
        cell.dataset.col = h;
        cell.dataset.wkTs = wk;
        cell.dataset.hour = h;
        const label = `Week of ${fmtFullDate(wk)}, hour ${h}: ${M.fmt(v)}`;
        cell.setAttribute("aria-label", label);
        cell.title = label;
        cell.addEventListener("click", ()=>{
          const start = wk + h*HOUR_MS;
          const end = start + HOUR_MS;
          setFilterRange(start, end);
        });
        cells.push(cell);
        grid.appendChild(cell);
      }
    }

    // Keyboard navigation
    grid.addEventListener("keydown", (ev)=>{
      const t = ev.target;
      if (!t || !t.classList || !t.classList.contains("hm-cell")) return;
      const rows = weekKeys.length;
      let r = +t.dataset.row, h = +t.dataset.col;
      let nr = r, nh = h;
      if (ev.key === "ArrowRight") nh = Math.min(23, h+1);
      else if (ev.key === "ArrowLeft") nh = Math.max(0, h-1);
      else if (ev.key === "ArrowDown") nr = Math.min(rows-1, r+1);
      else if (ev.key === "ArrowUp") nr = Math.max(0, r-1);
      else if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); t.click(); return; }
      else return;
      ev.preventDefault();
      const next = cells[nr*24 + nh];
      if (next){ t.tabIndex = -1; next.tabIndex = 0; next.focus(); }
    });

    const gridWrap = document.createElement("div");
    gridWrap.className = "heatmap-grid-wrap";
    gridWrap.appendChild(grid);

    // Legend
    const legend = document.createElement("div");
    legend.className = "heatmap-legend";
    legend.setAttribute("aria-label", "Heatmap legend");
    const title = document.createElement("div");
    title.className = "lg-title"; title.textContent = "Legend (" + M.label + ")";
    legend.appendChild(title);
    for (let b=0; b<7; b++){
      const row = document.createElement("div"); row.className = "lg-row";
      const sw = document.createElement("span"); sw.className = "lg-sw " + BIN_CLASSES[b];
      const txt = document.createElement("span");
      const lo = thresholds[b];
      const hi = b < 6 ? thresholds[b+1] : null;
      txt.textContent = hi != null ? `${M.fmt(lo)} – ${M.fmt(hi)}` : `≥ ${M.fmt(lo)}`;
      row.appendChild(sw); row.appendChild(txt);
      legend.appendChild(row);
    }

    const body = document.createElement("div");
    body.className = "heatmap-body";
    body.appendChild(gridWrap);
    body.appendChild(legend);

    container.appendChild(body);
  }

  function mount(container){
    // Build toolbar + body shell once
    container.innerHTML = "";
    container.className = "heatmap-card";

    const toolbar = document.createElement("div");
    toolbar.className = "heatmap-toolbar";
    const h2 = document.createElement("h2");
    h2.textContent = "Activity heatmap (weeks × hours)";
    toolbar.appendChild(h2);

    const chips = document.createElement("div");
    chips.className = "metric-chips";
    chips.setAttribute("role","radiogroup");
    chips.setAttribute("aria-label","Heatmap metric");
    let current = "cost";
    METRICS.forEach((m, i)=>{
      const b = document.createElement("button");
      b.type = "button";
      b.className = "metric-chip" + (m.key===current ? " active" : "");
      b.textContent = m.label;
      b.setAttribute("role","radio");
      b.setAttribute("aria-checked", m.key===current ? "true" : "false");
      b.dataset.metric = m.key;
      b.addEventListener("click", ()=>{
        current = m.key;
        chips.querySelectorAll(".metric-chip").forEach(x=>{
          x.classList.toggle("active", x.dataset.metric===current);
          x.setAttribute("aria-checked", x.dataset.metric===current ? "true" : "false");
        });
        renderInto();
      });
      chips.appendChild(b);
    });
    toolbar.appendChild(chips);

    const bodyHost = document.createElement("div");

    container.appendChild(toolbar);
    container.appendChild(bodyHost);

    function renderInto(){
      const events = (window.STATE && window.STATE.events) || [];
      render(bodyHost, events, current);
    }

    // Public API on the container
    container.__heatmapRender = renderInto;
    renderInto();
  }

  window.Heatmap = { mount, render };
})();
