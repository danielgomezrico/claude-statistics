/* parser-core.js — shared JSONL parser + aggregator.
 *
 * Works in both browser (IIFE attaches to window.ClaudeMeterParser) and Node
 * (module.exports) without external dependencies.
 *
 * Kept intentionally pure: no DOM, no Chart.js. Feed it lines or objects and
 * it returns normalized events / aggregates.
 */
(function(root, factory){
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof root !== "undefined") {
    root.ClaudeMeter = root.ClaudeMeter || {};
    root.ClaudeMeter.parserCore = api;
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this), function(){
  var DEFAULT_PRICING = [
    { match:"opus",   in: 5.00, out:25.00, cacheRead:0.50, cacheWrite: 6.25 },
    { match:"sonnet", in: 3.00, out:15.00, cacheRead:0.30, cacheWrite: 3.75 },
    { match:"fable",  in: 3.00, out:15.00, cacheRead:0.30, cacheWrite: 3.75 },
    { match:"haiku",  in: 1.00, out: 5.00, cacheRead:0.10, cacheWrite: 1.25 },
    { match:"",       in: 3.00, out:15.00, cacheRead:0.30, cacheWrite: 3.75 },
  ];

  function priceFor(pricing, model){
    var m = (model||"").toLowerCase();
    for (var i=0;i<pricing.length;i++){
      var p = pricing[i];
      if (p.match && m.indexOf(p.match) >= 0) return p;
    }
    return pricing[pricing.length-1];
  }

  /**
   * Extract a normalized event from one parsed JSONL object. Returns null if
   * it's not a usage-bearing record.
   */
  function extractEvent(obj, projectName, pricing){
    pricing = pricing || DEFAULT_PRICING;
    var msg = obj.message || obj;
    var usage = msg && msg.usage;
    if (!usage) return null;
    var ts = obj.timestamp || msg.timestamp || obj.createdAt;
    if (!ts) return null;
    var model = msg.model || obj.model || "unknown";
    var inTok = usage.input_tokens || 0;
    var outTok = usage.output_tokens || 0;
    var crTok = usage.cache_read_input_tokens || 0;
    var cwTok = usage.cache_creation_input_tokens || 0;
    var thinkTok = usage.thinking_tokens || usage.thinking_input_tokens || 0;
    var serviceTier = usage.service_tier || msg.service_tier || obj.service_tier || "unknown";
    var region = obj.inference_geo || msg.inference_geo || usage.inference_geo || (obj.metadata && obj.metadata.inference_geo) || null;
    if (!(inTok || outTok || crTok || cwTok)) return null;
    var p = priceFor(pricing, model);
    var cost = (inTok*p.in + outTok*p.out + crTok*p.cacheRead + cwTok*p.cacheWrite) / 1e6;
    var toolCalls = null;
    var content = msg && msg.content;
    if (Array.isArray(content)){
      toolCalls = {};
      for (var i=0;i<content.length;i++){
        var c = content[i];
        if (c && c.type === "tool_use" && c.name){
          toolCalls[c.name] = (toolCalls[c.name] || 0) + 1;
        }
      }
    }
    var stopReason = msg && (msg.stop_reason || msg.stopReason);
    return {
      ts: new Date(ts).toISOString(),
      tsMs: +new Date(ts),
      model: model,
      inTok: inTok,
      outTok: outTok,
      crTok: crTok,
      cwTok: cwTok,
      cost: cost,
      session: obj.sessionId || obj.session_id || "—",
      project: projectName || "unknown",
      cwd: obj.cwd || msg.cwd || "",
      gitBranch: obj.gitBranch || msg.gitBranch || "",
      version: obj.version || msg.version || obj.claudeCodeVersion || obj.cliVersion || null,
      requestId: obj.requestId || msg.requestId || obj.request_id || msg.request_id || null,
      uuid: obj.uuid || null,
      parentUuid: obj.parentUuid || obj.logicalParentUuid || null,
      isSidechain: !!obj.isSidechain,
      teamName: obj.teamName || null,
      agentName: obj.agentName || null,
      agentId: obj.agentId || null,
      stopReason: stopReason || null,
      toolCalls: toolCalls,
      thinkTok: thinkTok,
      serviceTier: serviceTier,
      region: region,
    };
  }

  function parseJsonlText(text, projectName, pricing){
    var events = [];
    var lines = text.split("\n");
    for (var i=0;i<lines.length;i++){
      var line = lines[i]; if (!line || !line.trim()) continue;
      var obj;
      try { obj = JSON.parse(line); } catch(_) { continue; }
      var ev = extractEvent(obj, projectName, pricing);
      if (ev) events.push(ev);
    }
    return events;
  }

  /**
   * Build aggregates matching what the browser "Export all" button produces.
   *   - totals (cost, tokens, messages, sessions)
   *   - byModel
   *   - byProject
   *   - byDay
   *   - sessions (per-session summary)
   */
  function aggregate(events){
    var totals = { cost:0, inTok:0, outTok:0, crTok:0, cwTok:0, messages:0, sessions:0 };
    var byModel = new Map();
    var byProject = new Map();
    var byDay = new Map();
    var bySession = new Map();
    for (var i=0;i<events.length;i++){
      var e = events[i];
      totals.cost += e.cost;
      totals.inTok += e.inTok; totals.outTok += e.outTok;
      totals.crTok += e.crTok; totals.cwTok += e.cwTok;
      totals.messages++;

      if (!byModel.has(e.model)) byModel.set(e.model, { model:e.model, cost:0, tokens:0, messages:0 });
      var rm = byModel.get(e.model);
      rm.cost += e.cost;
      rm.tokens += (e.inTok+e.outTok+e.crTok+e.cwTok);
      rm.messages++;

      if (!byProject.has(e.project)) byProject.set(e.project, { project:e.project, cost:0, tokens:0, messages:0, sessions:new Set() });
      var rp = byProject.get(e.project);
      rp.cost += e.cost;
      rp.tokens += (e.inTok+e.outTok+e.crTok+e.cwTok);
      rp.messages++;
      rp.sessions.add(e.session);

      var dayKey = (e.ts || "").slice(0,10);
      if (!byDay.has(dayKey)) byDay.set(dayKey, { day:dayKey, cost:0, tokens:0, messages:0 });
      var rd = byDay.get(dayKey);
      rd.cost += e.cost;
      rd.tokens += (e.inTok+e.outTok+e.crTok+e.cwTok);
      rd.messages++;

      if (!bySession.has(e.session)) bySession.set(e.session, {
        session:e.session, project:e.project, model:e.model,
        firstTs:e.ts, lastTs:e.ts,
        cost:0, inTok:0, outTok:0, crTok:0, cwTok:0, messages:0,
      });
      var rs = bySession.get(e.session);
      rs.cost += e.cost;
      rs.inTok += e.inTok; rs.outTok += e.outTok;
      rs.crTok += e.crTok; rs.cwTok += e.cwTok;
      rs.messages++;
      if (e.ts < rs.firstTs) rs.firstTs = e.ts;
      if (e.ts > rs.lastTs)  rs.lastTs  = e.ts;
    }
    totals.sessions = bySession.size;

    function mapVals(m){ var arr = []; m.forEach(function(v){ arr.push(v); }); return arr; }
    var projArr = mapVals(byProject).map(function(p){
      return { project:p.project, cost:p.cost, tokens:p.tokens, messages:p.messages, sessions:p.sessions.size };
    });

    return {
      totals: totals,
      byModel: mapVals(byModel),
      byProject: projArr,
      byDay: mapVals(byDay).sort(function(a,b){ return a.day < b.day ? -1 : a.day > b.day ? 1 : 0; }),
      sessions: mapVals(bySession),
    };
  }

  return {
    DEFAULT_PRICING: DEFAULT_PRICING,
    priceFor: priceFor,
    extractEvent: extractEvent,
    parseJsonlText: parseJsonlText,
    aggregate: aggregate,
  };
});
