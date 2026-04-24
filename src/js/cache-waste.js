/* Cache WASTE detector — F13 / K03 (Sofia moat).
 * Definition: a cache_creation_input_tokens block that was never subsequently
 * read within its TTL window (default 5 min).
 *   $ wasted = cache_creation_input_tokens * cacheWrite_price_per_1M / 1e6
 * A creation "pays off" if any later event on the same session has crTok > 0
 * within WASTE_TTL_MS of the creation timestamp.
 *
 * Renders top-N ranked list into a cluster-pane with group-by-project toggle.
 */
(function(){
  var WASTE_TTL_MS = 5 * 60 * 1000; // 5 min default TTL
  var TOP_N = 10;

  function fmt$(n){ return "$"+(n||0).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2}); }
  function fmtTok(n){
    if (n>=1e9) return (n/1e9).toFixed(2)+"B";
    if (n>=1e6) return (n/1e6).toFixed(2)+"M";
    if (n>=1e3) return (n/1e3).toFixed(1)+"k";
    return String(n|0);
  }
  function priceFor(model){
    var PRICING = window.PRICING || [{match:"",in:3,out:15,cacheRead:0.3,cacheWrite:3.75}];
    var m = (model||"").toLowerCase();
    for (var i=0;i<PRICING.length;i++){
      var p = PRICING[i];
      if (p.match && m.indexOf(p.match) >= 0) return p;
    }
    return PRICING[PRICING.length-1];
  }

  /**
   * Walk events ordered by session + ts. For each event with cwTok>0, mark as
   * WASTED unless a later event in same session has crTok>0 within WASTE_TTL_MS.
   * Returns array of waste records: {session, project, ts, cwTok, readsAfter, cost}.
   */
  function detectWaste(events){
    if (!events || !events.length) return [];
    // Group by session then sort by ts
    var bySess = new Map();
    for (var i=0;i<events.length;i++){
      var e = events[i];
      if (!bySess.has(e.session)) bySess.set(e.session, []);
      bySess.get(e.session).push(e);
    }
    var out = [];
    bySess.forEach(function(arr){
      arr.sort(function(a,b){ return a.ts - b.ts; });
      for (var j=0;j<arr.length;j++){
        var ev = arr[j];
        if (!ev.cwTok || ev.cwTok <= 0) continue;
        var tCreate = +ev.ts;
        var readsAfter = 0;
        for (var k=j+1;k<arr.length;k++){
          var later = arr[k];
          if ((+later.ts - tCreate) > WASTE_TTL_MS) break;
          if (later.crTok && later.crTok > 0) readsAfter += later.crTok;
        }
        if (readsAfter === 0){
          var p = priceFor(ev.model);
          var wasted = ev.cwTok * (p.cacheWrite||0) / 1e6;
          out.push({
            session: ev.session,
            project: ev.project || "—",
            ts: ev.ts,
            cwTok: ev.cwTok,
            readsAfter: 0,
            cost: wasted,
            model: ev.model,
          });
        }
      }
    });
    return out;
  }

  function aggregateByProject(records){
    var m = new Map();
    for (var i=0;i<records.length;i++){
      var r = records[i];
      var key = r.project;
      if (!m.has(key)) m.set(key, { project:key, sessions:new Set(), cwTok:0, cost:0, blocks:0 });
      var row = m.get(key);
      row.sessions.add(r.session);
      row.cwTok += r.cwTok;
      row.cost  += r.cost;
      row.blocks++;
    }
    var arr = [];
    m.forEach(function(row){
      arr.push({ project:row.project, sessions:row.sessions.size, cwTok:row.cwTok, cost:row.cost, blocks:row.blocks });
    });
    return arr.sort(function(a,b){ return b.cost - a.cost; });
  }

  function openSession(id){
    var cm = window.ClaudeMeter || {};
    if (cm.sessionExplorer && typeof cm.sessionExplorer.openSession === "function"){
      try { cm.sessionExplorer.openSession(id); return; } catch(_){}
    }
    alert("Session " + id + "\n\n(Session Explorer is shipping in Stream 5.)");
  }

  function render(pane){
    if (!pane) return;
    // filter-bar-aware events (same as rest of dashboard)
    var events = (window.STATE && window.STATE.events) || [];
    try {
      if (window.ClaudeMeter && window.ClaudeMeter.filterBar) {
        events = window.ClaudeMeter.filterBar.applyFilters(events);
      }
    } catch(_){}

    var records = detectWaste(events).sort(function(a,b){ return b.cost - a.cost; });
    var mode = pane.__wasteMode || "session"; // "session" | "project"

    pane.innerHTML = "";
    pane.classList.remove("disabled");

    var head = document.createElement("div");
    head.className = "waste-head";
    head.innerHTML = '<h3>Cache WASTE</h3>' +
      '<div class="waste-controls">' +
        '<button type="button" class="btn small waste-toggle" data-mode="session">By session</button>' +
        '<button type="button" class="btn small waste-toggle" data-mode="project">By project</button>' +
      '</div>';
    pane.appendChild(head);

    var sub = document.createElement("div");
    sub.className = "pane-sub";
    sub.textContent = "Cache-creation blocks with zero reads within " + (WASTE_TTL_MS/60000) + " min TTL. Top " + TOP_N + ".";
    pane.appendChild(sub);

    if (!records.length){
      var empty = document.createElement("div");
      empty.className = "waste-empty";
      empty.textContent = "No cache waste detected in current filter range — your prompts reuse well.";
      pane.appendChild(empty);
      return;
    }

    var total = 0; for (var i=0;i<records.length;i++) total += records[i].cost;
    var summary = document.createElement("div");
    summary.className = "waste-summary";
    summary.innerHTML = "<strong>" + fmt$(total) + "</strong> paid-and-wasted across <strong>" +
      records.length + "</strong> cache-write blocks (" + fmtTok(records.reduce(function(s,r){return s+r.cwTok;},0)) + " tokens).";
    pane.appendChild(summary);

    var table = document.createElement("table");
    table.className = "waste-table";
    if (mode === "project"){
      var proj = aggregateByProject(records).slice(0, TOP_N);
      table.innerHTML = '<thead><tr>' +
        '<th>Project</th>' +
        '<th class="num">Sessions</th>' +
        '<th class="num">Blocks</th>' +
        '<th class="num">Written@1.25×</th>' +
        '<th class="num">$ wasted</th>' +
      '</tr></thead>';
      var tb = document.createElement("tbody");
      for (var p=0; p<proj.length; p++){
        var r = proj[p];
        var tr = document.createElement("tr");
        tr.innerHTML = '<td>' + escapeHtml(r.project) + '</td>' +
          '<td class="num">' + r.sessions + '</td>' +
          '<td class="num">' + r.blocks + '</td>' +
          '<td class="num">' + fmtTok(r.cwTok) + '</td>' +
          '<td class="num"><strong>' + fmt$(r.cost) + '</strong></td>';
        tb.appendChild(tr);
      }
      table.appendChild(tb);
    } else {
      var top = records.slice(0, TOP_N);
      table.innerHTML = '<thead><tr>' +
        '<th>Session</th>' +
        '<th>Project</th>' +
        '<th class="num">Written@1.25×</th>' +
        '<th class="num">Reads before TTL</th>' +
        '<th class="num">$ wasted</th>' +
      '</tr></thead>';
      var tb2 = document.createElement("tbody");
      for (var t=0; t<top.length; t++){
        var rec = top[t];
        var tr2 = document.createElement("tr");
        tr2.className = "waste-row";
        tr2.dataset.session = rec.session;
        tr2.innerHTML = '<td><code>' + escapeHtml(String(rec.session).slice(0,12)) + '</code></td>' +
          '<td>' + escapeHtml(rec.project) + '</td>' +
          '<td class="num">' + fmtTok(rec.cwTok) + '</td>' +
          '<td class="num">0</td>' +
          '<td class="num"><strong>' + fmt$(rec.cost) + '</strong></td>';
        tr2.addEventListener("click", (function(id){ return function(){ openSession(id); }; })(rec.session));
        tb2.appendChild(tr2);
      }
      table.appendChild(tb2);
    }
    pane.appendChild(table);

    // Wire toggle buttons, mark active
    var btns = pane.querySelectorAll(".waste-toggle");
    btns.forEach(function(b){
      if (b.dataset.mode === mode) b.classList.add("active");
      b.addEventListener("click", function(){
        pane.__wasteMode = b.dataset.mode;
        render(pane);
      });
    });
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c];
    });
  }

  window.ClaudeMeter = window.ClaudeMeter || {};
  window.ClaudeMeter.cacheWaste = {
    render: render,
    detectWaste: detectWaste,
    WASTE_TTL_MS: WASTE_TTL_MS,
  };
})();
