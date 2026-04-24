/* Reconciliation panel — A14.
 * 3-column numeric table: This tool · ccusage · Anthropic console.
 * Rows: total cost, total tokens, cache-read, cache-create, per-model (collapsible).
 * Δ% color-coded (±1% green, ±5% yellow, else red).
 * Inputs: paste-in ccusage JSON, optional paste-in Anthropic console CSV.
 * Persistence: localStorage cm.reconcile.ccusage / cm.reconcile.console.
 * Filter-exempt — always whole-dataset (redesign §6.2).
 */
(function(){
  var LS_CCUSAGE = "cm.reconcile.ccusage";
  var LS_CONSOLE = "cm.reconcile.console";

  function fmt$(n){ return "$"+(n||0).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2}); }
  function fmtInt(n){ return (n||0).toLocaleString(); }
  function escapeHtml(s){
    return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c];
    });
  }

  function deltaClass(delta){
    var a = Math.abs(delta);
    if (!isFinite(delta)) return "muted";
    if (a <= 1) return "good";
    if (a <= 5) return "warn";
    return "bad";
  }
  function deltaText(tool, other){
    if (other == null || !isFinite(other) || other === 0) return "—";
    var d = (tool - other) / other * 100;
    var sign = d > 0 ? "+" : "";
    return sign + d.toFixed(2) + "%";
  }
  function deltaVal(tool, other){
    if (other == null || !isFinite(other) || other === 0) return null;
    return (tool - other) / other * 100;
  }

  /* --- parsers --- */
  function parseCcusage(text){
    if (!text || !text.trim()) return null;
    var j;
    try { j = JSON.parse(text); } catch(_) { return { error: "Invalid JSON" }; }
    // ccusage schemas vary; extract what we can.
    var totals = j.totals || j.total || j.summary || {};
    var out = {
      totalCost: Number(totals.totalCost || totals.total_cost || totals.cost || j.totalCost || j.total_cost || 0),
      totalTokens: Number(totals.totalTokens || totals.total_tokens || 0),
      cacheReadTokens: Number(totals.cacheReadTokens || totals.cache_read_tokens || totals.cacheReadInputTokens || 0),
      cacheCreateTokens: Number(totals.cacheCreationTokens || totals.cache_creation_tokens || totals.cacheCreateTokens || 0),
      perModel: {},
      raw: j,
    };
    // Try to pick up arrays of daily/model records
    var arr = Array.isArray(j) ? j : (j.daily || j.entries || j.records || []);
    if (Array.isArray(arr) && arr.length){
      var sumCost = 0, sumTok = 0, sumCR = 0, sumCW = 0;
      for (var i=0;i<arr.length;i++){
        var r = arr[i];
        sumCost += Number(r.totalCost || r.cost || 0);
        sumTok += Number(r.totalTokens || r.tokens || 0);
        sumCR += Number(r.cacheReadTokens || r.cache_read_tokens || 0);
        sumCW += Number(r.cacheCreationTokens || r.cache_creation_tokens || 0);
        var m = r.model || (r.modelBreakdowns && r.modelBreakdowns[0] && r.modelBreakdowns[0].model);
        if (m){
          if (!out.perModel[m]) out.perModel[m] = { cost:0, tokens:0 };
          out.perModel[m].cost += Number(r.totalCost || r.cost || 0);
          out.perModel[m].tokens += Number(r.totalTokens || r.tokens || 0);
        }
        if (Array.isArray(r.modelBreakdowns)){
          for (var k=0;k<r.modelBreakdowns.length;k++){
            var mb = r.modelBreakdowns[k];
            var mn = mb.model || mb.modelName || "unknown";
            if (!out.perModel[mn]) out.perModel[mn] = { cost:0, tokens:0 };
            out.perModel[mn].cost += Number(mb.cost || 0);
            out.perModel[mn].tokens += Number(mb.tokens || mb.totalTokens || 0);
          }
        }
      }
      if (!out.totalCost) out.totalCost = sumCost;
      if (!out.totalTokens) out.totalTokens = sumTok;
      if (!out.cacheReadTokens) out.cacheReadTokens = sumCR;
      if (!out.cacheCreateTokens) out.cacheCreateTokens = sumCW;
    }
    return out;
  }

  function parseConsoleCsv(text){
    if (!text || !text.trim()) return null;
    var lines = text.split(/\r?\n/).filter(function(l){ return l.trim(); });
    if (lines.length < 2) return { error: "Not enough rows" };
    var header = lines[0].split(",").map(function(s){ return s.trim().toLowerCase(); });
    function idx(names){
      for (var i=0;i<names.length;i++){
        var j = header.indexOf(names[i]); if (j>=0) return j;
      }
      return -1;
    }
    var iCost = idx(["cost","total_cost","amount","amount_usd","usd"]);
    var iTok = idx(["tokens","total_tokens"]);
    var iCR = idx(["cache_read_tokens","cache_read","cache_read_input_tokens"]);
    var iCW = idx(["cache_creation_tokens","cache_write","cache_creation_input_tokens"]);
    var iModel = idx(["model","model_name"]);
    var sumCost = 0, sumTok = 0, sumCR = 0, sumCW = 0;
    var perModel = {};
    for (var r=1; r<lines.length; r++){
      var cells = lines[r].split(",");
      if (iCost >= 0) sumCost += Number(cells[iCost]) || 0;
      if (iTok  >= 0) sumTok  += Number(cells[iTok])  || 0;
      if (iCR   >= 0) sumCR   += Number(cells[iCR])   || 0;
      if (iCW   >= 0) sumCW   += Number(cells[iCW])   || 0;
      if (iModel>= 0){
        var m = (cells[iModel]||"").trim();
        if (m){
          if (!perModel[m]) perModel[m] = { cost:0, tokens:0 };
          if (iCost>=0) perModel[m].cost += Number(cells[iCost]) || 0;
          if (iTok >=0) perModel[m].tokens += Number(cells[iTok]) || 0;
        }
      }
    }
    return {
      totalCost: sumCost,
      totalTokens: sumTok,
      cacheReadTokens: sumCR,
      cacheCreateTokens: sumCW,
      perModel: perModel,
    };
  }

  function toolTotals(){
    // Always whole-dataset (exempt from filter-bar per §6.2)
    var events = (window.STATE && window.STATE.events) || [];
    var totalCost = 0, totalTokens = 0, cr = 0, cw = 0, inTok = 0, outTok = 0;
    var perModel = {};
    for (var i=0;i<events.length;i++){
      var e = events[i];
      totalCost += e.cost || 0;
      inTok += e.inTok||0; outTok += e.outTok||0;
      cr += e.crTok||0; cw += e.cwTok||0;
      totalTokens += (e.inTok||0) + (e.outTok||0) + (e.crTok||0) + (e.cwTok||0);
      var m = e.model || "unknown";
      if (!perModel[m]) perModel[m] = { cost:0, tokens:0 };
      perModel[m].cost += e.cost || 0;
      perModel[m].tokens += (e.inTok||0) + (e.outTok||0) + (e.crTok||0) + (e.cwTok||0);
    }
    return {
      totalCost: totalCost,
      totalTokens: totalTokens,
      cacheReadTokens: cr,
      cacheCreateTokens: cw,
      perModel: perModel,
    };
  }

  /* --- tiny trailing-30d variance sparkline per row --- */
  function sparkline(values, canvas){
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0,0,w,h);
    if (!values || !values.length) return;
    var min = Infinity, max = -Infinity;
    for (var i=0;i<values.length;i++){
      var v = values[i]; if (!isFinite(v)) continue;
      if (v<min) min = v; if (v>max) max = v;
    }
    if (!isFinite(min) || !isFinite(max)) return;
    if (max === min) { max = min + 1; }
    ctx.strokeStyle = "#6ea8ff"; ctx.lineWidth = 1;
    ctx.beginPath();
    for (var j=0;j<values.length;j++){
      var vv = values[j];
      var x = (j/(values.length-1))*(w-2) + 1;
      var y = h - ((vv - min)/(max - min))*(h-2) - 1;
      if (j===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.stroke();
    // baseline 0
    var zy = h - ((0 - min)/(max - min))*(h-2) - 1;
    if (isFinite(zy) && zy >= 0 && zy <= h){
      ctx.strokeStyle = "#26313844"; ctx.beginPath();
      ctx.moveTo(0, zy); ctx.lineTo(w, zy); ctx.stroke();
    }
  }

  /**
   * For each row compute a trailing-30d variance series.
   * Without a multi-day ccusage/console series we proxy by binning tool
   * events into 30 daily buckets and comparing daily-average to the pasted
   * whole-period mean (if available). This gives *some* visual shape.
   */
  function buildVarianceSeries(tool, other, field){
    var events = (window.STATE && window.STATE.events) || [];
    var now = new Date(); now.setHours(0,0,0,0);
    var start = new Date(now); start.setDate(start.getDate() - 29);
    var bins = new Array(30).fill(0);
    for (var i=0;i<events.length;i++){
      var e = events[i]; var t = +e.ts; if (t < +start) continue;
      var dayIdx = Math.floor((t - +start) / 86400000);
      if (dayIdx < 0 || dayIdx >= 30) continue;
      if (field === "totalCost") bins[dayIdx] += e.cost||0;
      else if (field === "totalTokens") bins[dayIdx] += (e.inTok||0)+(e.outTok||0)+(e.crTok||0)+(e.cwTok||0);
      else if (field === "cacheReadTokens") bins[dayIdx] += e.crTok||0;
      else if (field === "cacheCreateTokens") bins[dayIdx] += e.cwTok||0;
    }
    if (!other || !isFinite(other[field]) || other[field] === 0){
      return bins; // raw tool-side series; no Δ reference
    }
    var otherDaily = other[field] / 30;
    return bins.map(function(v){ return (v - otherDaily); });
  }

  function driftExplanation(row, delta){
    var a = Math.abs(delta || 0);
    if (a <= 1) return "Δ within ±1% — match.";
    var hint = "";
    if (row === "totalCost") hint = "Likely cause: service-tier mismatch (batch vs standard), stale pricing, or interrupted streams charged differently.";
    else if (row === "totalTokens") hint = "Likely cause: compaction / summarization messages counted differently, or sidechain filtering.";
    else if (row === "cacheReadTokens") hint = "Likely cause: ephemeral_1h reads expiring mid-window; tool counts every read, ccusage collapses by session.";
    else if (row === "cacheCreateTokens") hint = "Likely cause: 5m vs 1h TTL breakdown, compaction writes omitted by ccusage.";
    else hint = "Likely cause: per-model aggregation boundary drift.";
    return hint;
  }

  function mount(container){
    if (!container) return;
    container.innerHTML = "";
    container.className = "card big reconcile-card";

    var title = document.createElement("h2");
    title.textContent = "Reconciliation — tool vs ccusage vs console";
    container.appendChild(title);

    var sub = document.createElement("div");
    sub.className = "reconcile-sub muted";
    sub.style.fontSize = "12px";
    sub.style.marginBottom = "12px";
    sub.textContent = "Filter-exempt: always whole-dataset. Paste ccusage JSON (from `npx ccusage --json`) and/or Anthropic console CSV to cross-check.";
    container.appendChild(sub);

    var inputs = document.createElement("div");
    inputs.className = "reconcile-inputs";
    inputs.innerHTML =
      '<div class="reconcile-input-col">' +
        '<label for="reconcileCcusage">ccusage JSON</label>' +
        '<textarea id="reconcileCcusage" rows="4" placeholder="Paste output of: npx ccusage --json"></textarea>' +
        '<div class="reconcile-parse-status" data-src="ccusage"></div>' +
      '</div>' +
      '<div class="reconcile-input-col">' +
        '<label for="reconcileConsole">Anthropic console CSV (optional)</label>' +
        '<textarea id="reconcileConsole" rows="4" placeholder="Paste CSV export from console.anthropic.com"></textarea>' +
        '<div class="reconcile-parse-status" data-src="console"></div>' +
      '</div>';
    container.appendChild(inputs);

    var tableWrap = document.createElement("div");
    tableWrap.className = "reconcile-table-wrap";
    container.appendChild(tableWrap);

    // wire persistence & reparse
    var ccEl = inputs.querySelector("#reconcileCcusage");
    var coEl = inputs.querySelector("#reconcileConsole");
    var statusCc = inputs.querySelector('.reconcile-parse-status[data-src="ccusage"]');
    var statusCo = inputs.querySelector('.reconcile-parse-status[data-src="console"]');

    try { ccEl.value = localStorage.getItem(LS_CCUSAGE) || ""; } catch(_) {}
    try { coEl.value = localStorage.getItem(LS_CONSOLE) || ""; } catch(_) {}

    function onInput(){
      try { localStorage.setItem(LS_CCUSAGE, ccEl.value || ""); } catch(_){}
      try { localStorage.setItem(LS_CONSOLE, coEl.value || ""); } catch(_){}
      renderTable();
    }
    ccEl.addEventListener("input", debounce(onInput, 250));
    coEl.addEventListener("input", debounce(onInput, 250));

    function renderTable(){
      var tool = toolTotals();
      var cc = null, co = null;
      if (ccEl.value.trim()){
        cc = parseCcusage(ccEl.value);
        if (cc && cc.error) { statusCc.textContent = "Parse error: " + cc.error; statusCc.className = "reconcile-parse-status bad"; cc = null; }
        else if (cc) { statusCc.textContent = "Parsed ccusage: " + fmt$(cc.totalCost) + " across " + fmtInt(cc.totalTokens) + " tokens."; statusCc.className = "reconcile-parse-status good"; }
      } else { statusCc.textContent = ""; }
      if (coEl.value.trim()){
        co = parseConsoleCsv(coEl.value);
        if (co && co.error) { statusCo.textContent = "Parse error: " + co.error; statusCo.className = "reconcile-parse-status bad"; co = null; }
        else if (co) { statusCo.textContent = "Parsed console CSV: " + fmt$(co.totalCost) + "."; statusCo.className = "reconcile-parse-status good"; }
      } else { statusCo.textContent = ""; }

      var rows = [
        { key:"totalCost",        label:"Total cost",         fmt: fmt$ },
        { key:"totalTokens",      label:"Total tokens",       fmt: fmtInt },
        { key:"cacheReadTokens",  label:"Cache-read tokens",  fmt: fmtInt },
        { key:"cacheCreateTokens",label:"Cache-create tokens",fmt: fmtInt },
      ];

      var html = '<table class="reconcile-table"><thead><tr>' +
        '<th>Metric</th>' +
        '<th class="num">This tool</th>' +
        '<th class="num">ccusage</th>' +
        '<th class="num">Δ%</th>' +
        '<th class="num">Console</th>' +
        '<th class="num">Δ%</th>' +
        '<th>Trend (30d)</th>' +
      '</tr></thead><tbody>';
      rows.forEach(function(r){
        var tv = tool[r.key];
        var cv = cc ? cc[r.key] : null;
        var ov = co ? co[r.key] : null;
        var dcc = deltaVal(tv, cv);
        var dco = deltaVal(tv, ov);
        html += '<tr data-key="' + r.key + '">' +
          '<td>' + escapeHtml(r.label) + '</td>' +
          '<td class="num">' + escapeHtml(r.fmt(tv)) + '</td>' +
          '<td class="num">' + (cv==null ? '<span class="muted">—</span>' : escapeHtml(r.fmt(cv))) + '</td>' +
          '<td class="num delta ' + deltaClass(dcc) + '" data-delta-src="ccusage">' + deltaText(tv, cv) + '</td>' +
          '<td class="num">' + (ov==null ? '<span class="muted">—</span>' : escapeHtml(r.fmt(ov))) + '</td>' +
          '<td class="num delta ' + deltaClass(dco) + '" data-delta-src="console">' + deltaText(tv, ov) + '</td>' +
          '<td><canvas class="reconcile-spark" width="120" height="24"></canvas></td>' +
        '</tr>';
      });
      html += '</tbody></table>';

      // Per-model collapsible
      var allModels = {};
      Object.keys(tool.perModel||{}).forEach(function(m){ allModels[m] = true; });
      if (cc) Object.keys(cc.perModel||{}).forEach(function(m){ allModels[m] = true; });
      if (co) Object.keys(co.perModel||{}).forEach(function(m){ allModels[m] = true; });
      var models = Object.keys(allModels).sort();
      if (models.length){
        html += '<details class="reconcile-bymodel"><summary>By model (' + models.length + ')</summary>' +
          '<table class="reconcile-table reconcile-bymodel-table"><thead><tr>' +
            '<th>Model</th>' +
            '<th class="num">Tool cost</th>' +
            '<th class="num">ccusage</th>' +
            '<th class="num">Δ%</th>' +
            '<th class="num">Console</th>' +
            '<th class="num">Δ%</th>' +
          '</tr></thead><tbody>';
        models.forEach(function(m){
          var tc = (tool.perModel[m]||{}).cost || 0;
          var cct = cc ? ((cc.perModel[m]||{}).cost || 0) : null;
          var cot = co ? ((co.perModel[m]||{}).cost || 0) : null;
          var dcc = deltaVal(tc, cct);
          var dco = deltaVal(tc, cot);
          html += '<tr>' +
            '<td><code>' + escapeHtml(m) + '</code></td>' +
            '<td class="num">' + fmt$(tc) + '</td>' +
            '<td class="num">' + (cct==null?'—':fmt$(cct)) + '</td>' +
            '<td class="num delta ' + deltaClass(dcc) + '">' + deltaText(tc, cct) + '</td>' +
            '<td class="num">' + (cot==null?'—':fmt$(cot)) + '</td>' +
            '<td class="num delta ' + deltaClass(dco) + '">' + deltaText(tc, cot) + '</td>' +
          '</tr>';
        });
        html += '</tbody></table></details>';
      }

      tableWrap.innerHTML = html;

      // Draw sparks
      var sparkCanvases = tableWrap.querySelectorAll(".reconcile-spark");
      rows.forEach(function(r, idx){
        var cnv = sparkCanvases[idx]; if (!cnv) return;
        var other = cc || co;
        var series = buildVarianceSeries(tool, other, r.key);
        sparkline(series, cnv);
      });

      // Wire delta click → explanation
      tableWrap.querySelectorAll(".delta").forEach(function(el){
        el.style.cursor = "pointer";
        el.addEventListener("click", function(){
          var tr = el.closest("tr");
          var key = tr && tr.dataset.key;
          var src = el.dataset.deltaSrc;
          var tv = tool[key];
          var other = src === "ccusage" ? cc : co;
          if (!other || !isFinite(other[key])){ alert("No " + src + " value to compare for " + key + "."); return; }
          var d = deltaVal(tv, other[key]);
          var msg = "Metric: " + key + "\n" +
            "Tool: " + tv + "\n" +
            src + ": " + other[key] + "\n" +
            "Δ: " + (d==null?"—":d.toFixed(2)+"%") + "\n\n" +
            driftExplanation(key, d) + "\n\n" +
            "(Session-level drill arrives in Wave 3 — for now this alert explains likely causes: interrupted stream, compaction accounting, or service-tier mismatch.)";
          alert(msg);
        });
      });
    }

    function debounce(fn, ms){
      var t; return function(){ var args = arguments, ctx = this; clearTimeout(t); t = setTimeout(function(){ fn.apply(ctx, args); }, ms); };
    }

    container.__reconcileRender = renderTable;
    renderTable();
  }

  window.ClaudeMeter = window.ClaudeMeter || {};
  window.ClaudeMeter.reconciliation = {
    mount: mount,
    parseCcusage: parseCcusage,
    parseConsoleCsv: parseConsoleCsv,
    toolTotals: toolTotals,
  };
})();
