/*!
 * version-timeline.js — A19 Claude Code version timeline
 *
 * Stacked daily bars by `event.version` (fallback "unknown"), with vertical
 * pin-annotations on bundled changelog release dates. Click a pin → ask
 * comparePeriod.setRange(before, after) (guarded — falls back to console hint).
 *
 * Personas: Sofia (cost spikes after a release), Jake (regression hunt),
 * Marcus (release impact on team).
 *
 * Public API: window.ClaudeMeter.versionTimeline = { mount, render, setChangelog }
 */
(function () {
  "use strict";

  var LS_KEY_CHANGELOG = "cm.version.changelog";
  var BUNDLED_URL = "src/data/claude-code-changelog.json";

  var state = {
    mount: null,
    chart: null,
    bundled: null,    // raw json
    overrides: null,  // user-pasted JSON (replaces bundled when present)
    pasteOpen: false,
  };

  var palette = ["#d97757","#6ea8ff","#22c55e","#eab308","#a855f7","#06b6d4","#ef4444","#f97316","#84cc16","#ec4899","#14b8a6","#f59e0b"];

  function escapeHtml(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); }
  function fmt$(n){ return "$"+(n||0).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2}); }

  function loadOverrides(){
    try {
      var raw = localStorage.getItem(LS_KEY_CHANGELOG);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.entries)) return null;
      return parsed;
    } catch(e){ return null; }
  }
  function saveOverrides(obj){
    try { localStorage.setItem(LS_KEY_CHANGELOG, JSON.stringify(obj)); } catch(e){}
  }
  function clearOverrides(){
    try { localStorage.removeItem(LS_KEY_CHANGELOG); } catch(e){}
  }

  function fetchBundled(){
    return fetch(BUNDLED_URL, { cache:"no-cache" })
      .then(function(r){ if (!r.ok) throw new Error("HTTP "+r.status); return r.json(); })
      .catch(function(){ return { entries: [] }; });
  }

  function getChangelog(){
    var c = state.overrides || state.bundled;
    if (!c || !Array.isArray(c.entries)) return [];
    return c.entries.slice().filter(function(e){
      return e && e.date && e.version;
    }).sort(function(a,b){ return new Date(a.date) - new Date(b.date); });
  }

  function dayKey(ts){
    var d = new Date(ts);
    d.setHours(0,0,0,0);
    return d.getTime();
  }
  function fmtDay(k){
    return new Date(k).toLocaleDateString(undefined,{month:"short",day:"numeric"});
  }

  function aggregate(events){
    // Bucket by day, group by version
    var byDay = new Map();
    var versions = new Set();
    for (var i=0;i<events.length;i++){
      var e = events[i];
      var v = e.version || "unknown";
      versions.add(v);
      var k = dayKey(e.ts);
      var row = byDay.get(k);
      if (!row){ row = { ts:k }; byDay.set(k, row); }
      row[v] = (row[v]||0) + (e.cost||0);
    }
    var rows = Array.from(byDay.values()).sort(function(a,b){ return a.ts - b.ts; });
    // Order versions by total cost desc (so dominant version stacks at base)
    var totals = {};
    versions.forEach(function(v){ totals[v] = 0; });
    rows.forEach(function(r){ Object.keys(r).forEach(function(k){ if (k!=="ts") totals[k] = (totals[k]||0) + (r[k]||0); }); });
    var versionList = Array.from(versions).sort(function(a,b){ return (totals[b]||0) - (totals[a]||0); });
    return { rows: rows, versions: versionList };
  }

  function renderEmpty(reason){
    if (!state.mount) return;
    state.mount.innerHTML = '<div class="vt-empty">'+escapeHtml(reason || "No events yet — drop a JSONL folder or load the demo.")+'</div>';
  }

  function setRangeAround(releaseDate){
    // Symmetric 7-day window before / after the release.
    var t = +new Date(releaseDate);
    if (!isFinite(t)) return;
    var before = { start: new Date(t - 7*86400000), end: new Date(t - 1) };
    var after  = { start: new Date(t),               end: new Date(t + 7*86400000) };
    var cp = window.ClaudeMeter && window.ClaudeMeter.comparePeriod;
    if (cp && typeof cp.setRange === "function"){
      try { cp.setRange(before, after); return; } catch(e){ console.warn("[version-timeline] comparePeriod.setRange threw", e); }
    }
    // Soft fallback: log + status hint.
    console.info("[version-timeline] comparePeriod.setRange not available — would compare", before, "vs", after);
    var statusEl = document.getElementById("status");
    if (statusEl) statusEl.textContent = "Compare windows: "+before.start.toLocaleDateString()+"→"+before.end.toLocaleDateString()+" vs "+after.start.toLocaleDateString()+"→"+after.end.toLocaleDateString();
  }

  function buildChart(canvas, agg){
    if (!window.Chart){ return null; }
    var labels = agg.rows.map(function(r){ return fmtDay(r.ts); });
    var datasets = agg.versions.map(function(v, i){
      return {
        label: v,
        data: agg.rows.map(function(r){ return r[v]||0; }),
        backgroundColor: palette[i % palette.length],
        stack: "v"
      };
    });
    return new Chart(canvas, {
      type:"bar",
      data:{ labels: labels, datasets: datasets },
      options:{
        animation:false,
        plugins:{
          legend:{ labels:{ color:"#e6e8ee", boxWidth:10, font:{size:10} } },
          tooltip:{
            callbacks:{
              label: function(ctx){ return ctx.dataset.label+": "+fmt$(ctx.parsed.y); }
            }
          }
        },
        scales:{
          x:{ stacked:true, ticks:{ color:"#8a93a6", maxRotation:0, autoSkip:true, maxTicksLimit:14 }, grid:{ color:"#262b38" } },
          y:{ stacked:true, ticks:{ color:"#8a93a6", callback: function(v){ return "$"+v; } }, grid:{ color:"#262b38" } }
        }
      }
    });
  }

  function placePins(wrap, canvas, agg, releases){
    var layer = wrap.querySelector(".vt-pin-layer");
    if (!layer) return;
    layer.innerHTML = "";
    if (!agg.rows.length) return;
    var firstTs = agg.rows[0].ts;
    var lastTs  = agg.rows[agg.rows.length-1].ts + 86400000; // include last bar
    var span = lastTs - firstTs;
    if (span <= 0) return;
    var rect = canvas.getBoundingClientRect();
    var canvasWidth = canvas.clientWidth || rect.width || wrap.clientWidth;
    // Chart.js leaves padding ~ 30px left, 10px right typically. Use scales if available.
    var ch = state.chart;
    var leftPx = 30, rightPx = 10;
    if (ch && ch.scales && ch.scales.x){
      leftPx = ch.scales.x.left;
      rightPx = canvasWidth - ch.scales.x.right;
    }
    var usable = Math.max(1, canvasWidth - leftPx - rightPx);

    releases.forEach(function(rel){
      var t = +new Date(rel.date);
      if (!isFinite(t)) return;
      if (t < firstTs - 86400000 || t > lastTs + 86400000) return;
      var pct = (t - firstTs) / span;
      var x = leftPx + pct * usable;
      var pin = document.createElement("div");
      pin.className = "vt-pin";
      pin.style.left = x.toFixed(1)+"px";
      pin.title = rel.version + " — " + (rel.title||"") + " ("+new Date(rel.date).toLocaleDateString()+")";
      pin.addEventListener("click", function(){ setRangeAround(rel.date); });
      var lbl = document.createElement("a");
      lbl.className = "vt-pin-label";
      lbl.textContent = (rel.version||"").replace(/^claude-code-/, "v");
      lbl.href = rel.changelog_url || "#";
      lbl.target = "_blank";
      lbl.rel = "noopener noreferrer";
      lbl.title = pin.title;
      lbl.addEventListener("click", function(ev){
        // Shift-click opens link, plain click sets compare range.
        if (!ev.shiftKey){ ev.preventDefault(); setRangeAround(rel.date); }
      });
      pin.appendChild(lbl);
      layer.appendChild(pin);
    });
  }

  function render(){
    if (!state.mount) return;
    var STATE = window.STATE || (window.ClaudeMeter && window.ClaudeMeter.state) || { events: [] };
    var events = STATE.events || [];
    if (window.ClaudeMeter && window.ClaudeMeter.filterBar){
      try { events = window.ClaudeMeter.filterBar.applyFilters(events); } catch(e){}
    }
    if (!events.length){ renderEmpty(); return; }

    state.mount.innerHTML = "";
    state.mount.classList.add("vt-wrap");

    var toolbar = document.createElement("div");
    toolbar.className = "vt-toolbar";
    var releases = getChangelog();
    var stats = document.createElement("span");
    stats.className = "vt-stats";
    var versionsSeen = new Set();
    for (var i=0;i<events.length;i++){ versionsSeen.add(events[i].version || "unknown"); }
    stats.textContent = versionsSeen.size + " version"+(versionsSeen.size===1?"":"s")+" · "+releases.length+" release pin"+(releases.length===1?"":"s");
    toolbar.appendChild(stats);

    var actions = document.createElement("div");
    actions.className = "vt-actions";
    var pasteBtn = document.createElement("button"); pasteBtn.type="button"; pasteBtn.textContent = "Paste changelog";
    var resetBtn = document.createElement("button"); resetBtn.type="button"; resetBtn.textContent = "Reset to bundled";
    pasteBtn.addEventListener("click", function(){ state.pasteOpen = !state.pasteOpen; render(); });
    resetBtn.addEventListener("click", function(){ clearOverrides(); state.overrides = null; render(); });
    actions.appendChild(pasteBtn);
    if (state.overrides) actions.appendChild(resetBtn);
    toolbar.appendChild(actions);
    state.mount.appendChild(toolbar);

    var canvasWrap = document.createElement("div");
    canvasWrap.className = "vt-canvas-wrap";
    var canvas = document.createElement("canvas");
    canvasWrap.appendChild(canvas);
    var pinLayer = document.createElement("div");
    pinLayer.className = "vt-pin-layer";
    canvasWrap.appendChild(pinLayer);
    state.mount.appendChild(canvasWrap);

    var help = document.createElement("div");
    help.className = "vt-help";
    help.innerHTML = 'Click a pin to set compare-period (±7d around release). Shift-click opens release notes.';
    state.mount.appendChild(help);

    if (state.pasteOpen){
      var pw = document.createElement("div");
      pw.className = "vt-paste show";
      pw.innerHTML =
        '<div class="vt-help" style="margin-top:0">Paste a JSON object: <code>{"entries":[{"date":"2025-10-12","version":"claude-code-1.0.82","title":"Opus 4.7 GA","changelog_url":"https://..."}]}</code></div>'+
        '<textarea spellcheck="false" placeholder=\'{"entries":[...]}\'></textarea>'+
        '<div class="vt-paste-actions">'+
          '<button type="button" class="vt-paste-save">Save</button>'+
          '<button type="button" class="vt-paste-cancel">Cancel</button>'+
        '</div>';
      var ta = pw.querySelector("textarea");
      if (state.overrides) ta.value = JSON.stringify(state.overrides, null, 2);
      pw.querySelector(".vt-paste-save").addEventListener("click", function(){
        try {
          var parsed = JSON.parse(ta.value);
          if (!parsed || !Array.isArray(parsed.entries)) throw new Error("entries[] required");
          state.overrides = parsed;
          saveOverrides(parsed);
          state.pasteOpen = false;
          render();
        } catch(err){ alert("Invalid JSON: "+err.message); }
      });
      pw.querySelector(".vt-paste-cancel").addEventListener("click", function(){ state.pasteOpen = false; render(); });
      state.mount.appendChild(pw);
    }

    var agg = aggregate(events);
    if (state.chart){ try { state.chart.destroy(); } catch(e){} state.chart = null; }
    state.chart = buildChart(canvas, agg);

    // Place pins after layout settles.
    requestAnimationFrame(function(){ placePins(canvasWrap, canvas, agg, releases); });

    // Re-place on resize.
    if (state._resizeBound) return;
    state._resizeBound = true;
    window.addEventListener("resize", function(){
      if (!state.mount || !state.mount.isConnected) return;
      var c = state.mount.querySelector(".vt-canvas-wrap canvas");
      if (c) placePins(state.mount.querySelector(".vt-canvas-wrap"), c, aggregate((window.STATE||{events:[]}).events||[]), getChangelog());
    });
  }

  function mount(el){
    state.mount = el;
    state.overrides = loadOverrides();
    if (!state.bundled){
      fetchBundled().then(function(j){ state.bundled = j; render(); });
    }
    render();
  }

  function setChangelog(obj){
    if (!obj || !Array.isArray(obj.entries)) throw new Error("entries[] required");
    state.overrides = obj; saveOverrides(obj); render();
  }

  window.ClaudeMeter = window.ClaudeMeter || {};
  window.ClaudeMeter.versionTimeline = { mount: mount, render: render, setChangelog: setChangelog };
})();
