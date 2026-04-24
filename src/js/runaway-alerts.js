/*!
 * Zone C · A6 — Top loops / runaway agents alert card
 * Rules (configurable via window.ClaudeMeter.runawayAlerts.config):
 *   - same-tool-loop:   same tool name called > N times in a session (default N=40)
 *   - subagent-depth:   max subagent depth in a session > M (default M=5)
 *   - cost-2x-median:   session cost > 2 * median session cost
 *   - elapsed-p99:      session elapsed duration > p99
 */
(function(){
  "use strict";

  var config = {
    toolLoopN: 40,
    subagentDepthM: 5,
    costMultiple: 2,
    elapsedPercentile: 0.99
  };

  function fmt$(n){ return "$"+(n||0).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2}); }
  function fmtDur(ms){ if(!ms||ms<0) return "—"; var s = ms/1000; if (s<60) return s.toFixed(0)+"s"; var m = s/60; if (m<60) return m.toFixed(0)+"m"; var h = m/60; return h.toFixed(1)+"h"; }

  function percentile(sorted, p){
    if (!sorted.length) return 0;
    var idx = Math.min(sorted.length-1, Math.floor(sorted.length * p));
    return sorted[idx];
  }
  function median(sorted){ return percentile(sorted, 0.5); }

  function aggregateSessions(events){
    var map = new Map();
    for (var i=0;i<events.length;i++){
      var e = events[i];
      var s = map.get(e.session);
      if (!s){
        s = {
          id: e.session,
          project: e.project,
          cost: 0,
          msgs: 0,
          toolCounts: {},   // tool name -> count
          subagentAgents: new Set(),
          subagentSet: false,
          sidechainMsgs: 0,
          firstTs: +e.ts,
          lastTs: +e.ts,
          costSeries: []    // for sparkline (chronological per-event cost)
        };
        map.set(e.session, s);
      }
      s.cost += e.cost||0;
      s.msgs++;
      if (+e.ts < s.firstTs) s.firstTs = +e.ts;
      if (+e.ts > s.lastTs)  s.lastTs = +e.ts;
      if (e.toolCalls){
        for (var k in e.toolCalls){ s.toolCounts[k] = (s.toolCounts[k]||0) + e.toolCalls[k]; }
      }
      if (e.isSidechain){
        s.sidechainMsgs++;
        if (e.agentName || e.agentId) s.subagentAgents.add(e.agentName || e.agentId);
      }
      s.costSeries.push({ ts:+e.ts, cost:e.cost||0 });
    }
    var out = [];
    map.forEach(function(v){
      v.costSeries.sort(function(a,b){return a.ts-b.ts;});
      v.elapsed = v.lastTs - v.firstTs;
      // max count for any single tool
      v.maxToolCount = 0; v.hotTool = null;
      for (var k in v.toolCounts){ if (v.toolCounts[k] > v.maxToolCount){ v.maxToolCount = v.toolCounts[k]; v.hotTool = k; } }
      v.subagentDepth = v.subagentAgents.size; // proxy: distinct subagents involved
      out.push(v);
    });
    return out;
  }

  function flagSessions(sessions){
    if (!sessions.length) return [];
    var costs = sessions.map(function(s){ return s.cost; }).sort(function(a,b){return a-b;});
    var elapsedArr = sessions.map(function(s){ return s.elapsed||0; }).sort(function(a,b){return a-b;});
    var costMed = median(costs);
    var pElapsed = percentile(elapsedArr, config.elapsedPercentile);
    var flagged = [];
    for (var i=0;i<sessions.length;i++){
      var s = sessions[i];
      var triggers = [];
      if (s.maxToolCount > config.toolLoopN) triggers.push({ rule:"tool-loop", label:s.hotTool+" ×"+s.maxToolCount });
      if (s.subagentDepth > config.subagentDepthM) triggers.push({ rule:"subagent-depth", label:"depth "+s.subagentDepth });
      if (costMed > 0 && s.cost > config.costMultiple * costMed) triggers.push({ rule:"cost-2x", label:(s.cost/costMed).toFixed(1)+"× median" });
      if (pElapsed > 0 && s.elapsed > pElapsed) triggers.push({ rule:"elapsed-p99", label:fmtDur(s.elapsed) });
      if (triggers.length){
        s.triggers = triggers;
        flagged.push(s);
      }
    }
    flagged.sort(function(a,b){ return b.cost - a.cost; });
    return flagged.slice(0, 10);
  }

  function sparkSvg(session){
    // Downsample to ~20 points
    var pts = session.costSeries;
    if (pts.length === 0) return "";
    var N = 20;
    var bucket = Math.max(1, Math.ceil(pts.length / N));
    var buckets = [];
    for (var i=0;i<pts.length;i+=bucket){
      var sum = 0;
      for (var j=i; j<Math.min(pts.length, i+bucket); j++) sum += pts[j].cost;
      buckets.push(sum);
    }
    var max = Math.max.apply(null, buckets) || 1;
    var W = 80, H = 22;
    var step = W / Math.max(1, buckets.length-1);
    var d = "";
    for (var k=0;k<buckets.length;k++){
      var x = k * step;
      var y = H - (buckets[k]/max) * (H-2) - 1;
      d += (k===0?"M":"L") + x.toFixed(1) + " " + y.toFixed(1);
    }
    return '<svg class="ra-spark" viewBox="0 0 '+W+' '+H+'" width="'+W+'" height="'+H+'" aria-hidden="true">'+
           '<path d="'+d+'" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
  }

  var RULE_CLASS = {
    "tool-loop":      "ra-pill-loop",
    "subagent-depth": "ra-pill-depth",
    "cost-2x":        "ra-pill-cost",
    "elapsed-p99":    "ra-pill-elapsed"
  };

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); }

  function openSession(id, session){
    var cm = window.ClaudeMeter;
    if (cm && cm.sessionExplorer && typeof cm.sessionExplorer.openSession === "function"){
      try { cm.sessionExplorer.openSession(id); return; } catch(e){ console.warn("[runaway] openSession failed", e); }
    }
    console.log("[runaway TODO] sessionExplorer.openSession not available; id =", id);
    alert("Session "+id+"\nProject: "+session.project+"\nCost: "+fmt$(session.cost)+"\nMessages: "+session.msgs+"\nTriggers: "+session.triggers.map(function(t){return t.rule;}).join(", "));
  }

  function render(mount, events){
    if (!mount) return;
    mount.innerHTML = "";
    mount.classList.add("ra-wrap");
    if (!events || !events.length){
      mount.innerHTML = '<div class="ra-empty">No sessions to analyze yet.</div>';
      return;
    }
    var sessions = aggregateSessions(events);
    var flagged = flagSessions(sessions);
    if (!flagged.length){
      mount.innerHTML = '<div class="ra-empty">No runaway patterns detected. (thresholds: tool-loop>'+config.toolLoopN+', subagent-depth>'+config.subagentDepthM+', cost>'+config.costMultiple+'× median, elapsed>p'+(config.elapsedPercentile*100)+')</div>';
      return;
    }
    var list = document.createElement("ol");
    list.className = "ra-list";
    flagged.forEach(function(s){
      var li = document.createElement("li");
      li.className = "ra-row";
      li.setAttribute("role","button");
      li.setAttribute("tabindex","0");
      var spark = sparkSvg(s);
      var pillsHtml = s.triggers.map(function(t){
        return '<span class="ra-pill '+(RULE_CLASS[t.rule]||"")+'" title="'+escapeHtml(t.rule)+'">'+escapeHtml(t.label)+'</span>';
      }).join(" ");
      li.innerHTML =
        '<div class="ra-left">'+
          '<div class="ra-title">'+escapeHtml((s.project||"—").slice(0,28))+' <span class="ra-id muted">· '+escapeHtml(String(s.id).slice(0,8))+'</span></div>'+
          '<div class="ra-pills">'+pillsHtml+'</div>'+
        '</div>'+
        '<div class="ra-mid">'+spark+'</div>'+
        '<div class="ra-right">'+fmt$(s.cost)+'</div>';
      li.addEventListener("click", function(){ openSession(s.id, s); });
      li.addEventListener("keydown", function(ev){ if (ev.key === "Enter" || ev.key === " "){ ev.preventDefault(); openSession(s.id, s); } });
      list.appendChild(li);
    });
    mount.appendChild(list);
  }

  window.ClaudeMeter = window.ClaudeMeter || {};
  window.ClaudeMeter.runawayAlerts = {
    config: config,
    render: render,
    // exposed so anomaly feed & future features can reuse
    aggregateSessions: aggregateSessions,
    flagSessions: flagSessions
  };

})();
