/* ROI Cards — D2 / A17
 * Per-project ROI mini-cards grid.  Persona: David D2/D5, Mia M5.
 *
 * Public API: window.ClaudeMeter.roiCards
 *   mount(containerEl)
 *   render(events)
 *   setView("cards"|"table")
 */
(function(){
  "use strict";
  window.ClaudeMeter = window.ClaudeMeter || {};

  const VIEW_KEY = "cm.roiCards.view";
  const DAY_MS = 86400000;

  let viewMode = "cards";
  let lastEvents = [];
  let containerEl = null;
  let sparkCharts = [];

  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "cards" || v === "table") viewMode = v;
  } catch(e){}

  function fmt$(n){ return "$"+(n||0).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2}); }
  function fmtInt(n){ return (n||0).toLocaleString(); }
  function fmtTok(n){ if(n>=1e9)return(n/1e9).toFixed(2)+"B"; if(n>=1e6)return(n/1e6).toFixed(2)+"M"; if(n>=1e3)return(n/1e3).toFixed(1)+"k"; return String(n); }

  function projectOf(e){
    return (e && (e.attribution || e.project)) || "unknown";
  }

  function aggregate(events){
    const byProj = new Map();
    let now = 0;
    for (const e of events) if (e.ts && e.ts.getTime && e.ts.getTime() > now) now = e.ts.getTime();
    if (!now) now = Date.now();
    const threshold14 = now - 14*DAY_MS;
    const thresholdSpark = now - 30*DAY_MS;

    for (const e of events){
      const k = projectOf(e);
      if (!byProj.has(k)) byProj.set(k, {
        name: k, cost: 0, msgs: 0, sessions: new Set(),
        inTok: 0, crTok: 0, cwTok: 0, outTok: 0,
        lastTs: 0, sparkDaily: new Map()
      });
      const p = byProj.get(k);
      p.cost += e.cost || 0;
      p.msgs += 1;
      p.sessions.add(e.session);
      p.inTok += e.inTok||0; p.outTok += e.outTok||0;
      p.crTok += e.crTok||0; p.cwTok += e.cwTok||0;
      const t = e.ts && e.ts.getTime ? e.ts.getTime() : 0;
      if (t > p.lastTs) p.lastTs = t;
      if (t >= thresholdSpark){
        const d = new Date(t); d.setHours(0,0,0,0);
        const bk = d.getTime();
        p.sparkDaily.set(bk, (p.sparkDaily.get(bk)||0) + (e.cost||0));
      }
    }

    const out = [];
    for (const p of byProj.values()){
      const fresh = p.inTok + p.cwTok;
      const cached = p.crTok;
      const cachePct = (fresh + cached) ? (cached / (fresh + cached)) * 100 : 0;
      const abandoned = (p.cost > 5) && (p.lastTs < threshold14);
      // Build 30-day sparkline array
      const spark = [];
      for (let t = thresholdSpark; t <= now; t += DAY_MS){
        const d = new Date(t); d.setHours(0,0,0,0);
        spark.push(p.sparkDaily.get(d.getTime()) || 0);
      }
      out.push({
        name: p.name,
        cost: p.cost,
        sessions: p.sessions.size,
        msgs: p.msgs,
        tokens: p.inTok + p.outTok + p.crTok + p.cwTok,
        cachePct,
        abandoned,
        lastTs: p.lastTs,
        spark
      });
    }
    out.sort((a,b)=>b.cost - a.cost);
    return out;
  }

  function destroySparks(){
    for (const c of sparkCharts) { try{ c.destroy(); }catch(e){} }
    sparkCharts = [];
  }

  function narrowToProject(name){
    const f = window.ClaudeMeter && window.ClaudeMeter.filterBar;
    if (f && typeof f.setProject === "function"){ try { f.setProject(name); return; } catch(e){ console.warn("[roiCards] filterBar.setProject failed:", e); } }
    const uh = window.ClaudeMeter && window.ClaudeMeter.urlHash;
    if (uh && typeof uh.set === "function"){ try { uh.set({ proj:[name] }); return; } catch(e){ console.warn("[roiCards] urlHash.set failed:", e); } }
    console.info("[roiCards] TODO: no filterBar/urlHash; click ignored for", name);
  }

  function mkViewSwitch(){
    const wrap = document.createElement("div");
    wrap.className = "cm-roi-switch";
    const cards = document.createElement("button");
    cards.type="button"; cards.className="btn" + (viewMode==="cards"?" active":"");
    cards.textContent = "cards"; cards.setAttribute("aria-label","cards view");
    cards.onclick = ()=>setView("cards");
    const table = document.createElement("button");
    table.type="button"; table.className="btn" + (viewMode==="table"?" active":"");
    table.textContent = "table"; table.setAttribute("aria-label","table view");
    table.onclick = ()=>setView("table");
    wrap.appendChild(cards); wrap.appendChild(table);
    return wrap;
  }

  function renderSparkline(canvas, spark){
    if (!window.Chart) return null;
    const trend = spark.slice();
    const max = Math.max(...trend, 0.001);
    const ctx = canvas.getContext("2d");
    const chart = new Chart(ctx, {
      type: "line",
      data: { labels: trend.map((_,i)=>i), datasets: [{
        data: trend, borderColor: "#d97757", backgroundColor: "#d9775733",
        fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.2
      }]},
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { display: false },
          y: { display: false, suggestedMin: 0, suggestedMax: max }
        },
        elements: { point: { radius: 0 } }
      }
    });
    return chart;
  }

  function applyRedact(name){
    const r = window.ClaudeMeter && window.ClaudeMeter.redact;
    if (r && typeof r.apply === "function"){
      try { return r.apply(name); } catch(e){}
    }
    return name;
  }
  function applyAnon(name){
    const s = window.ClaudeMeter && window.ClaudeMeter.surveillance;
    if (s && typeof s.anonymize === "function"){
      try { return s.anonymize(name); } catch(e){}
    }
    return name;
  }

  function displayName(raw){
    return applyRedact(applyAnon(raw));
  }

  function renderCardsView(rows){
    const grid = document.createElement("div");
    grid.className = "cm-roi-grid";
    rows.forEach(r => {
      const card = document.createElement("div");
      card.className = "cm-roi-card" + (r.abandoned ? " abandoned" : "");
      card.tabIndex = 0;
      card.setAttribute("role","button");
      card.addEventListener("click", ()=>narrowToProject(r.name));
      card.addEventListener("keydown", (ev)=>{ if (ev.key==="Enter"||ev.key===" "){ ev.preventDefault(); narrowToProject(r.name); }});

      const head = document.createElement("div");
      head.className = "cm-roi-head";
      const nm = document.createElement("div");
      nm.className = "cm-roi-name";
      nm.textContent = displayName(r.name);
      nm.title = displayName(r.name);
      head.appendChild(nm);
      if (r.abandoned){
        const flag = document.createElement("span");
        flag.className = "pill bad cm-roi-abandoned";
        flag.textContent = "abandoned";
        flag.title = "No sessions in last 14 days · historic > $5";
        head.appendChild(flag);
      }
      card.appendChild(head);

      const kpis = document.createElement("div");
      kpis.className = "cm-roi-kpis";
      kpis.innerHTML =
        `<div><div class="cm-roi-k">Cost</div><div class="cm-roi-v">${fmt$(r.cost)}</div></div>`+
        `<div><div class="cm-roi-k">Sessions</div><div class="cm-roi-v">${fmtInt(r.sessions)}</div></div>`+
        `<div><div class="cm-roi-k">Cache</div><div class="cm-roi-v">${r.cachePct.toFixed(0)}%</div></div>`;
      card.appendChild(kpis);

      const sparkWrap = document.createElement("div");
      sparkWrap.className = "cm-roi-spark";
      const canvas = document.createElement("canvas");
      sparkWrap.appendChild(canvas);
      card.appendChild(sparkWrap);

      const foot = document.createElement("div");
      foot.className = "cm-roi-foot";
      foot.textContent = "30-day trend";
      card.appendChild(foot);

      grid.appendChild(card);
      // Defer sparkline creation so canvas has layout.
      requestAnimationFrame(()=>{
        const c = renderSparkline(canvas, r.spark);
        if (c) sparkCharts.push(c);
      });
    });
    return grid;
  }

  function renderTableView(rows){
    const wrap = document.createElement("div");
    wrap.className = "cm-roi-table";
    const table = document.createElement("table");
    table.innerHTML =
      `<thead><tr>
        <th>Project</th>
        <th class="num">Sessions</th>
        <th class="num">Messages</th>
        <th class="num">Tokens</th>
        <th class="num">Cache %</th>
        <th class="num">Cost</th>
      </tr></thead>`;
    const tbody = document.createElement("tbody");
    rows.forEach(r=>{
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td>${escapeHtml(displayName(r.name))}${r.abandoned?' <span class="pill bad">abandoned</span>':''}</td>`+
        `<td class="num">${fmtInt(r.sessions)}</td>`+
        `<td class="num">${fmtInt(r.msgs)}</td>`+
        `<td class="num">${fmtTok(r.tokens)}</td>`+
        `<td class="num">${r.cachePct.toFixed(0)}%</td>`+
        `<td class="num">${fmt$(r.cost)}</td>`;
      tr.style.cursor = "pointer";
      tr.addEventListener("click", ()=>narrowToProject(r.name));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function mount(el){ containerEl = el; }

  function setView(v){
    if (v !== "cards" && v !== "table") return;
    viewMode = v;
    try { localStorage.setItem(VIEW_KEY, v); } catch(e){}
    render(lastEvents);
  }

  function render(events){
    if (!containerEl) return;
    lastEvents = events || [];
    destroySparks();
    containerEl.innerHTML = "";

    const head = document.createElement("div");
    head.className = "cm-roi-header";
    const title = document.createElement("h2");
    title.textContent = "Per-project ROI";
    title.style.margin = "0";
    head.appendChild(title);
    head.appendChild(mkViewSwitch());
    containerEl.appendChild(head);

    if (!lastEvents.length){
      const empty = document.createElement("div");
      empty.className = "muted";
      empty.style.fontSize = "12px";
      empty.textContent = "Load data to see per-project ROI.";
      containerEl.appendChild(empty);
      return;
    }

    // Make sure attribution is set
    const attr = window.ClaudeMeter && window.ClaudeMeter.attribution;
    if (attr && typeof attr.applyAll === "function"){
      try { attr.applyAll(lastEvents); } catch(e){ console.warn("[roiCards] attribution.applyAll failed:", e); }
    }

    const rows = aggregate(lastEvents);
    const body = viewMode === "cards" ? renderCardsView(rows) : renderTableView(rows);
    containerEl.appendChild(body);

    // Attribution settings
    const attrMount = document.createElement("div");
    attrMount.className = "cm-roi-attr";
    containerEl.appendChild(attrMount);
    if (attr && typeof attr.renderSettings === "function"){
      try { attr.renderSettings(attrMount); } catch(e){ console.warn("[roiCards] attribution.renderSettings failed:", e); }
    }
  }

  window.ClaudeMeter.roiCards = { mount, render, setView, getView: ()=>viewMode };
})();
