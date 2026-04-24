/*!
 * A16 — Monthly anomaly feed with rule engine
 * Rules:
 *   - cost-3sigma:    session cost > 3σ above trailing-30d mean of session cost
 *   - error-stop:     stopReason === "error" (or truncated) in any event of the session
 *   - subagent-depth: distinct subagents per session > N (default reuses runaway config)
 *   - elapsed-p99:    session elapsed > p99
 *   - cache-waste:    session's cache-write waste $ > threshold (default $1)
 *
 * Per-session ignores persisted in localStorage: cm.anomaly.ignored = { "<sessionId>": ["rule1","rule2"] }
 */
(function(){
  "use strict";

  var LS_KEY = "cm.anomaly.ignored";
  var config = {
    sigmaThreshold: 3,
    subagentDepthN: null, // if null, reuse runawayAlerts.config.subagentDepthM (or 5)
    elapsedPercentile: 0.99,
    cacheWasteUsd: 1,
    trailingDays: 30
  };

  function fmt$(n){ return "$"+(n||0).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2}); }
  function fmtDur(ms){ if(!ms||ms<0) return "—"; var s = ms/1000; if (s<60) return s.toFixed(0)+"s"; var m = s/60; if (m<60) return m.toFixed(0)+"m"; var h = m/60; return h.toFixed(1)+"h"; }
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); }

  function loadIgnored(){
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}") || {}; } catch(e){ return {}; }
  }
  function saveIgnored(obj){
    try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch(e){}
  }
  function isIgnored(ignored, sessionId, rule){
    return !!(ignored[sessionId] && ignored[sessionId].indexOf(rule) >= 0);
  }
  function toggleIgnore(sessionId, rule){
    var ig = loadIgnored();
    if (!ig[sessionId]) ig[sessionId] = [];
    var idx = ig[sessionId].indexOf(rule);
    if (idx >= 0) ig[sessionId].splice(idx,1);
    else ig[sessionId].push(rule);
    if (!ig[sessionId].length) delete ig[sessionId];
    saveIgnored(ig);
  }
  function clearAllIgnored(){ try { localStorage.removeItem(LS_KEY); } catch(e){} }

  function percentile(sorted, p){
    if (!sorted.length) return 0;
    var idx = Math.min(sorted.length-1, Math.floor(sorted.length * p));
    return sorted[idx];
  }

  function aggregateSessions(events){
    // Reuse runawayAlerts.aggregateSessions when available for consistency
    var ra = window.ClaudeMeter && window.ClaudeMeter.runawayAlerts;
    if (ra && ra.aggregateSessions){
      var base = ra.aggregateSessions(events);
      // enrich: stopReason flags, cache-write cost proxy
      var enrich = {};
      for (var i=0;i<events.length;i++){
        var e = events[i];
        if (!enrich[e.session]) enrich[e.session] = { hasError:false, truncated:false, cacheWriteCost:0 };
        var x = enrich[e.session];
        if (e.stopReason === "error" || e.stopReason === "tool_use_error") x.hasError = true;
        if (e.stopReason === "max_tokens" || e.stopReason === "truncated") x.truncated = true;
        // Approximate cache-write cost: reuse Stream 1 cacheWaste if available
        var cm = window.ClaudeMeter;
        if (cm && cm.cacheWaste && typeof cm.cacheWaste.wastePerEvent === "function"){
          try { x.cacheWriteCost += cm.cacheWaste.wastePerEvent(e) || 0; } catch(err){}
        } else {
          // naive: cache-write tokens * (approx price / 1e6). We don't know pricing here, but we can reconstruct via e.cwTok share of e.cost.
          // Fallback: treat any single-use cache_creation token as "waste" proxy — half of cache-write portion.
          // This is a rough heuristic; if Stream 1 ships cacheWaste, use that.
          var cwShare = (e.cwTok || 0);
          if (cwShare > 0 && e.cost > 0){
            // approx cost fraction: cwTok * pricePerTok. We don't have price here, so rely on totals:
            // allocate proportional cost from cache-write-only heuristic.
            // We use cwTok * 3.75e-6 as a conservative Sonnet-equivalent upper bound.
            x.cacheWriteCost += cwShare * 3.75e-6;
          }
        }
      }
      for (var j=0;j<base.length;j++){
        var s = base[j]; var x2 = enrich[s.id] || {};
        s.hasError = !!x2.hasError; s.truncated = !!x2.truncated; s.cacheWriteCost = x2.cacheWriteCost || 0;
      }
      return base;
    }
    // Fallback: minimal aggregate
    var map = new Map();
    for (var k=0;k<events.length;k++){
      var ev = events[k];
      var s2 = map.get(ev.session);
      if (!s2){ s2 = { id:ev.session, project:ev.project, cost:0, msgs:0, subagentAgents:new Set(), firstTs:+ev.ts, lastTs:+ev.ts, hasError:false, truncated:false, cacheWriteCost:0 }; map.set(ev.session, s2); }
      s2.cost += ev.cost||0; s2.msgs++;
      if (+ev.ts < s2.firstTs) s2.firstTs = +ev.ts;
      if (+ev.ts > s2.lastTs) s2.lastTs = +ev.ts;
      if (ev.isSidechain && (ev.agentName||ev.agentId)) s2.subagentAgents.add(ev.agentName||ev.agentId);
      if (ev.stopReason === "error") s2.hasError = true;
      if (ev.stopReason === "max_tokens" || ev.stopReason === "truncated") s2.truncated = true;
      s2.cacheWriteCost += (ev.cwTok||0) * 3.75e-6;
    }
    var out = [];
    map.forEach(function(v){ v.subagentDepth = v.subagentAgents.size; v.elapsed = v.lastTs - v.firstTs; out.push(v); });
    return out;
  }

  // Rule engine: runs rules against a session list and returns flagged {session, triggers[]}
  function evaluate(sessions){
    if (!sessions.length) return [];

    // Compute trailing-30d mean + std of session cost (simple over-all fallback if not enough recent)
    var now = Date.now();
    var cutoff = now - config.trailingDays * 86400000;
    var recent = sessions.filter(function(s){ return s.lastTs >= cutoff; });
    var sample = recent.length >= 5 ? recent : sessions;
    var costs = sample.map(function(s){ return s.cost; });
    var mean = costs.reduce(function(a,b){return a+b;}, 0) / Math.max(1,costs.length);
    var variance = costs.reduce(function(a,b){ return a + (b-mean)*(b-mean); }, 0) / Math.max(1,costs.length);
    var sd = Math.sqrt(variance);

    var elapsedArr = sessions.map(function(s){ return s.elapsed||0; }).sort(function(a,b){return a-b;});
    var pElapsed = percentile(elapsedArr, config.elapsedPercentile);

    var depthN = config.subagentDepthN;
    if (depthN == null){
      var ra = window.ClaudeMeter && window.ClaudeMeter.runawayAlerts;
      depthN = (ra && ra.config && ra.config.subagentDepthM) || 5;
    }

    var flagged = [];
    for (var i=0;i<sessions.length;i++){
      var s = sessions[i];
      var triggers = [];
      if (sd > 0 && s.cost > mean + config.sigmaThreshold * sd){
        triggers.push({ rule:"cost-3sigma", label:">"+config.sigmaThreshold+"σ ("+fmt$(s.cost)+")" });
      }
      if (s.hasError || s.truncated){
        triggers.push({ rule:"error-stop", label: s.truncated ? "truncated" : "error" });
      }
      if ((s.subagentDepth||0) > depthN){
        triggers.push({ rule:"subagent-depth", label:"depth "+s.subagentDepth });
      }
      if (pElapsed > 0 && s.elapsed > pElapsed){
        triggers.push({ rule:"elapsed-p99", label:fmtDur(s.elapsed) });
      }
      if ((s.cacheWriteCost||0) > config.cacheWasteUsd){
        triggers.push({ rule:"cache-waste", label:fmt$(s.cacheWriteCost)+" cache-write" });
      }
      if (triggers.length){ flagged.push({ session: s, triggers: triggers }); }
    }
    // Most recent first (within month)
    flagged.sort(function(a,b){ return b.session.lastTs - a.session.lastTs; });
    return flagged;
  }

  function openSession(id, session){
    var cm = window.ClaudeMeter;
    if (cm && cm.sessionExplorer && typeof cm.sessionExplorer.openSession === "function"){
      try { cm.sessionExplorer.openSession(id); return; } catch(e){ console.warn("[anomaly] openSession failed", e); }
    }
    console.log("[anomaly TODO] sessionExplorer.openSession not available; id =", id);
    alert("Session "+id+"\nProject: "+(session.project||"—")+"\nCost: "+fmt$(session.cost)+"\nMessages: "+session.msgs);
  }

  var RULE_CLASS = {
    "cost-3sigma":    "af-badge-sigma",
    "error-stop":     "af-badge-error",
    "subagent-depth": "af-badge-depth",
    "elapsed-p99":    "af-badge-elapsed",
    "cache-waste":    "af-badge-waste"
  };
  var RULE_LABEL = {
    "cost-3sigma":    ">3σ",
    "error-stop":     "error",
    "subagent-depth": "sub-depth",
    "elapsed-p99":    "slow",
    "cache-waste":    "cache-waste"
  };

  function render(mount, events){
    if (!mount) return;
    mount.innerHTML = "";
    mount.classList.add("af-wrap");
    if (!events || !events.length){
      mount.innerHTML = '<div class="af-empty">No events to analyze yet.</div>';
      return;
    }
    // Restrict to current month (David's "this month" framing). Fall back to all if empty.
    var now = new Date();
    var monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    var monthEvents = events.filter(function(e){ return +e.ts >= monthStart; });
    if (!monthEvents.length) monthEvents = events;

    var sessions = aggregateSessions(monthEvents);
    var flagged = evaluate(sessions);
    var ignored = loadIgnored();
    // Filter out triggers that have been ignored
    flagged = flagged.map(function(f){
      f.triggers = f.triggers.filter(function(t){ return !isIgnored(ignored, f.session.id, t.rule); });
      return f;
    }).filter(function(f){ return f.triggers.length > 0; });

    var toolbar = document.createElement("div");
    toolbar.className = "af-toolbar";
    var stats = document.createElement("span");
    stats.textContent = flagged.length ? (flagged.length+" anomalies this month") : "No anomalies this month";
    toolbar.appendChild(stats);
    if (Object.keys(ignored).length){
      var clr = document.createElement("button");
      clr.className = "af-clear"; clr.type = "button";
      clr.textContent = "Clear ignored ("+Object.keys(ignored).length+")";
      clr.addEventListener("click", function(){ clearAllIgnored(); render(mount, events); });
      toolbar.appendChild(clr);
    }
    mount.appendChild(toolbar);

    if (!flagged.length){
      var empty = document.createElement("div");
      empty.className = "af-empty";
      empty.textContent = "No weird sessions flagged this month.";
      mount.appendChild(empty);
      return;
    }
    var list = document.createElement("ul");
    list.className = "af-list";
    flagged.slice(0, 50).forEach(function(f){
      var s = f.session;
      var li = document.createElement("li");
      li.className = "af-row";

      var main = document.createElement("div");
      main.className = "af-main";
      main.setAttribute("role","button");
      main.setAttribute("tabindex","0");
      main.innerHTML =
        '<div class="af-title">'+escapeHtml((s.project||"—").slice(0,32))+' <span class="muted" style="font-size:11px">· '+escapeHtml(String(s.id).slice(0,8))+'</span></div>'+
        '<div class="af-sub">'+
          f.triggers.map(function(t){
            return '<span class="af-badge '+(RULE_CLASS[t.rule]||"")+'" title="'+escapeHtml(t.rule)+'">'+escapeHtml(RULE_LABEL[t.rule]||t.rule)+': '+escapeHtml(t.label)+'</span>';
          }).join("")+
        '</div>';
      main.addEventListener("click", function(){ openSession(s.id, s); });
      main.addEventListener("keydown", function(ev){ if (ev.key === "Enter" || ev.key === " "){ ev.preventDefault(); openSession(s.id, s); } });
      li.appendChild(main);

      var cost = document.createElement("div");
      cost.className = "af-cost";
      cost.textContent = fmt$(s.cost);
      li.appendChild(cost);

      var ign = document.createElement("button");
      ign.className = "af-ignore";
      ign.type = "button";
      ign.textContent = "Ignore";
      ign.title = "Ignore all triggered rules for this session";
      ign.addEventListener("click", function(ev){
        ev.stopPropagation();
        // Ignore every currently triggered rule for this session
        for (var k=0;k<f.triggers.length;k++){ toggleIgnore(s.id, f.triggers[k].rule); }
        render(mount, events);
      });
      li.appendChild(ign);

      list.appendChild(li);
    });
    mount.appendChild(list);
  }

  window.ClaudeMeter = window.ClaudeMeter || {};
  window.ClaudeMeter.anomalyFeed = {
    config: config,
    render: render,
    evaluate: evaluate,
    aggregateSessions: aggregateSessions,
    loadIgnored: loadIgnored,
    clearAllIgnored: clearAllIgnored,
    toggleIgnore: toggleIgnore
  };

})();
