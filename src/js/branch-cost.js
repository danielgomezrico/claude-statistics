/*!
 * branch-cost.js — A20 git branch cost chart
 *
 * Horizontal ranked rows (branch · cost · sparkline · Δ% vs project mean).
 * Rename rules: regex → label, with a default set that groups ephemeral
 * branches like `claude/*`, `dependabot/*`, `feat/*`, `fix/*`. Edit/persist
 * via localStorage `cm.branch.rename-rules`.
 *
 * Click a row → window.ClaudeMeter.filterBar.setBranch(name) when present;
 * otherwise log + hint via the status element.
 *
 * Personas: David (cost-by-branch attribution).
 *
 * Public API: window.ClaudeMeter.branchCost = { mount, render, getRules, setRules, applyRules }
 */
(function () {
  "use strict";

  var LS_KEY = "cm.branch.rename-rules";

  // Default rules: regex string → group label. Order matters (first wins).
  var DEFAULT_RULES = [
    { pattern: "^claude/.*",       label: "claude/* (sub-agent worktrees)" },
    { pattern: "^dependabot/.*",   label: "dependabot/*" },
    { pattern: "^renovate/.*",     label: "renovate/*" },
    { pattern: "^revert-.*",       label: "revert/*" },
    { pattern: "^release/.*",      label: "release/*" },
    { pattern: "^hotfix/.*",       label: "hotfix/*" },
    { pattern: "^chore/.*",        label: "chore/*" },
    { pattern: "^docs/.*",         label: "docs/*" }
    // feat/* and fix/* intentionally NOT collapsed — those are usually meaningful per-feature.
  ];

  var state = {
    mount: null,
    rules: null,
    rulesOpen: false,
  };

  function escapeHtml(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); }
  function fmt$(n){ return "$"+(n||0).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2}); }

  function loadRules(){
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return DEFAULT_RULES.slice();
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return DEFAULT_RULES.slice();
      return parsed.filter(function(r){ return r && typeof r.pattern === "string"; });
    } catch(e){ return DEFAULT_RULES.slice(); }
  }
  function saveRules(rs){ try { localStorage.setItem(LS_KEY, JSON.stringify(rs)); } catch(e){} }
  function clearRules(){ try { localStorage.removeItem(LS_KEY); } catch(e){} }

  function compileRule(r){
    try { return new RegExp(r.pattern); } catch(e){ return null; }
  }

  function applyRules(branch, rules){
    if (!branch) return "(no branch)";
    rules = rules || state.rules || loadRules();
    for (var i=0;i<rules.length;i++){
      var rx = compileRule(rules[i]);
      if (rx && rx.test(branch)) return rules[i].label || branch;
    }
    return branch;
  }

  function getRules(){ return (state.rules || loadRules()).slice(); }
  function setRules(rs){
    if (!Array.isArray(rs)) throw new Error("rules must be an array");
    state.rules = rs.slice(); saveRules(state.rules); render();
  }

  function dayKey(ts){ var d=new Date(ts); d.setHours(0,0,0,0); return d.getTime(); }

  function aggregate(events, rules){
    var map = new Map(); // label → { cost, msgs, raw:Set, byDay:Map }
    for (var i=0;i<events.length;i++){
      var e = events[i];
      var raw = e.gitBranch || "(no branch)";
      var label = applyRules(raw, rules);
      var row = map.get(label);
      if (!row){ row = { label: label, cost:0, msgs:0, raw:new Set(), byDay:new Map() }; map.set(label, row); }
      row.cost += e.cost || 0;
      row.msgs += 1;
      row.raw.add(raw);
      var k = dayKey(e.ts);
      row.byDay.set(k, (row.byDay.get(k)||0) + (e.cost||0));
    }
    var arr = Array.from(map.values()).map(function(r){
      return {
        label: r.label,
        cost: r.cost,
        msgs: r.msgs,
        raw: Array.from(r.raw),
        spark: Array.from(r.byDay.entries()).sort(function(a,b){return a[0]-b[0];}).map(function(p){ return p[1]; })
      };
    });
    arr.sort(function(a,b){ return b.cost - a.cost; });
    return arr;
  }

  function sparklineSvg(values, w, h){
    w = w||100; h = h||18;
    if (!values || !values.length) return '<svg class="bc-spark" width="'+w+'" height="'+h+'"></svg>';
    var max = Math.max.apply(null, values), min = Math.min.apply(null, values);
    var range = (max - min) || 1;
    var stepX = values.length > 1 ? w / (values.length - 1) : 0;
    var pts = values.map(function(v, i){
      var x = (i*stepX).toFixed(1);
      var y = (h - ((v - min) / range) * (h-2) - 1).toFixed(1);
      return x+","+y;
    }).join(" ");
    return '<svg class="bc-spark" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'"><polyline fill="none" stroke="#6ea8ff" stroke-width="1.4" points="'+pts+'" /></svg>';
  }

  function setBranchFilter(rawNames){
    var fb = window.ClaudeMeter && window.ClaudeMeter.filterBar;
    var first = rawNames[0];
    if (fb && typeof fb.setBranch === "function"){
      try { fb.setBranch(first); return; } catch(e){ console.warn("[branch-cost] filterBar.setBranch threw", e); }
    }
    console.info("[branch-cost] filterBar.setBranch not available — would filter to branch:", first, "(group of "+rawNames.length+")");
    var statusEl = document.getElementById("status");
    if (statusEl) statusEl.textContent = "Branch filter not wired yet — would narrow to: "+first+(rawNames.length>1?(" (+"+(rawNames.length-1)+" more)"):"");
  }

  function renderEmpty(reason){
    if (!state.mount) return;
    state.mount.innerHTML = '<div class="bc-empty">'+escapeHtml(reason || "No events with gitBranch yet.")+'</div>';
  }

  function buildRulesPanel(){
    var pw = document.createElement("div");
    pw.className = "bc-rules show";
    pw.innerHTML = '<h4>Rename rules <span class="muted" style="text-transform:none">(regex → label · first match wins)</span></h4>';
    var rules = state.rules || loadRules();
    rules.forEach(function(r, idx){
      var row = document.createElement("div");
      row.className = "bc-rule-row";
      row.innerHTML =
        '<input type="text" class="bc-pattern" value="'+escapeHtml(r.pattern)+'" placeholder="^claude/.*" />'+
        '<input type="text" class="bc-label" value="'+escapeHtml(r.label||"")+'" placeholder="claude/*" />'+
        '<button type="button" class="bc-del" title="Remove">×</button>';
      row.querySelector(".bc-del").addEventListener("click", function(){
        rules.splice(idx, 1); state.rules = rules; saveRules(rules); render();
      });
      row.querySelector(".bc-pattern").addEventListener("change", function(ev){ rules[idx].pattern = ev.target.value; state.rules = rules; saveRules(rules); render(); });
      row.querySelector(".bc-label").addEventListener("change", function(ev){ rules[idx].label = ev.target.value; state.rules = rules; saveRules(rules); render(); });
      pw.appendChild(row);
    });
    var actions = document.createElement("div");
    actions.className = "bc-rules-actions";
    var addBtn = document.createElement("button"); addBtn.type="button"; addBtn.textContent = "+ Add rule";
    var resetBtn = document.createElement("button"); resetBtn.type="button"; resetBtn.textContent = "Reset to defaults";
    addBtn.addEventListener("click", function(){
      rules.push({ pattern:"^new/.*", label:"new/*" }); state.rules = rules; saveRules(rules); render();
    });
    resetBtn.addEventListener("click", function(){ clearRules(); state.rules = null; render(); });
    actions.appendChild(addBtn); actions.appendChild(resetBtn);
    pw.appendChild(actions);
    return pw;
  }

  function render(){
    if (!state.mount) return;
    if (!state.rules) state.rules = loadRules();
    var STATE = window.STATE || (window.ClaudeMeter && window.ClaudeMeter.state) || { events: [] };
    var events = STATE.events || [];
    if (window.ClaudeMeter && window.ClaudeMeter.filterBar){
      try { events = window.ClaudeMeter.filterBar.applyFilters(events); } catch(e){}
    }
    if (!events.length){ renderEmpty(); return; }

    state.mount.innerHTML = "";
    state.mount.classList.add("bc-wrap");

    var toolbar = document.createElement("div");
    toolbar.className = "bc-toolbar";
    var rows = aggregate(events, state.rules);
    var totalCost = rows.reduce(function(s,r){ return s + r.cost; }, 0);
    var meanCost = rows.length ? totalCost / rows.length : 0;

    var stats = document.createElement("span");
    stats.textContent = rows.length + " branch group"+(rows.length===1?"":"s")+" · "+fmt$(totalCost)+" total · mean "+fmt$(meanCost);
    toolbar.appendChild(stats);

    var rulesBtn = document.createElement("button"); rulesBtn.type = "button";
    rulesBtn.textContent = state.rulesOpen ? "Hide rename rules" : "Edit rename rules";
    rulesBtn.addEventListener("click", function(){ state.rulesOpen = !state.rulesOpen; render(); });
    toolbar.appendChild(rulesBtn);
    state.mount.appendChild(toolbar);

    if (state.rulesOpen) state.mount.appendChild(buildRulesPanel());

    if (!rows.length){
      var em = document.createElement("div");
      em.className = "bc-empty"; em.textContent = "No branches matched.";
      state.mount.appendChild(em);
      return;
    }

    var maxCost = rows[0].cost || 1;
    var ul = document.createElement("ul");
    ul.className = "bc-list";
    rows.slice(0, 50).forEach(function(r){
      var li = document.createElement("li");
      li.className = "bc-row";
      li.setAttribute("role","button");
      li.setAttribute("tabindex","0");

      var delta = meanCost > 0 ? ((r.cost - meanCost) / meanCost) * 100 : 0;
      var deltaCls = Math.abs(delta) < 5 ? "flat" : (delta > 0 ? "up" : "down");
      var deltaTxt = (delta>=0?"+":"") + delta.toFixed(0) + "%";
      var pct = (r.cost / maxCost) * 100;

      var meta = r.raw.length > 1 ? (r.raw.length+" raw branches") : escapeHtml(r.raw[0]||"");
      li.innerHTML =
        '<div class="bc-name"><code>'+escapeHtml(r.label)+'</code><span class="bc-meta">'+escapeHtml(r.msgs.toLocaleString())+' msgs · '+meta+'</span><div class="bc-bar-wrap"><div class="bc-bar" style="width:'+pct.toFixed(1)+'%"></div></div></div>'+
        '<div class="bc-spark-cell">'+sparklineSvg(r.spark, 90, 22)+'</div>'+
        '<div class="bc-cost">'+fmt$(r.cost)+'</div>'+
        '<div class="bc-delta '+deltaCls+'" title="vs project mean '+fmt$(meanCost)+'">'+escapeHtml(deltaTxt)+' Δ</div>';

      var rawNames = r.raw;
      li.addEventListener("click", function(){ setBranchFilter(rawNames); });
      li.addEventListener("keydown", function(ev){ if (ev.key === "Enter" || ev.key === " "){ ev.preventDefault(); setBranchFilter(rawNames); } });
      ul.appendChild(li);
    });
    state.mount.appendChild(ul);

    if (rows.length > 50){
      var more = document.createElement("div");
      more.className = "bc-help";
      more.textContent = "Showing top 50 of "+rows.length+" branch groups.";
      state.mount.appendChild(more);
    }

    var help = document.createElement("div");
    help.className = "bc-help";
    help.textContent = "Click a row to narrow the global filter to that branch (when a branch filter is wired into the filter bar).";
    state.mount.appendChild(help);
  }

  function mount(el){
    state.mount = el;
    state.rules = loadRules();
    render();
  }

  window.ClaudeMeter = window.ClaudeMeter || {};
  window.ClaudeMeter.branchCost = {
    mount: mount,
    render: render,
    getRules: getRules,
    setRules: setRules,
    applyRules: applyRules
  };
})();
