/* Cache-write amortization break-even — F14 / K04 (Jake moat).
 *
 * Per-project (primary grouping key; no cache-prefix hash in source data yet):
 *   writes      = Σ cache_creation_input_tokens
 *   reads       = Σ cache_read_input_tokens
 *   break_even_N = ceil(cache_write_price / (fresh_input_price - cache_read_price))
 *                 using the default (sonnet-ish) model price, per catalog K04.
 *   reads_per_write = reads / writes   (tokens)
 *   status:
 *     - reads_per_write >= break_even_N   → "PAID OFF"
 *     - 0 < reads_per_write < break_even_N → "BREAKING EVEN"
 *     - reads_per_write == 0              → "WASTED"
 *
 * Sort: WASTED first, then lowest reads_per_write (most-wasted first).
 */
(function(){
  var MIN_SESSIONS_FOR_SHOW = 1; // still render, but empty-state kicks in below 10

  function ceil(x){ return Math.ceil(x); }

  function breakEvenReadsForPrice(p){
    // Formula per 02-metrics-catalog K04:
    //   break_even_reads = ceil(cache_write_price / (fresh_input_price - cache_read_price))
    // Expressed per-token: per cached token, how many reads (per that token) are
    // needed to recoup the 1.25× write premium vs paying fresh-input each time.
    // For sonnet defaults (3.75, 3.00, 0.30) → ceil(3.75/2.70) = 2.
    var denom = (p.in||0) - (p.cacheRead||0);
    if (denom <= 0) return Infinity;
    var n = (p.cacheWrite||0) / denom;
    return Math.max(1, ceil(n));
  }

  function defaultPrice(){
    var PRICING = window.PRICING || [];
    // last entry is the default bucket
    return PRICING[PRICING.length-1] || { in:3, out:15, cacheRead:0.3, cacheWrite:3.75 };
  }

  function aggregate(events){
    var m = new Map();
    for (var i=0;i<events.length;i++){
      var e = events[i];
      var key = e.project || "—";
      if (!m.has(key)) m.set(key, {
        project:key, writes:0, reads:0, sessions:new Set(), events:0, modelMix:new Map(),
      });
      var r = m.get(key);
      r.writes += e.cwTok || 0;
      r.reads  += e.crTok || 0;
      if (e.session) r.sessions.add(e.session);
      r.events++;
      if (e.model){
        r.modelMix.set(e.model, (r.modelMix.get(e.model)||0) + (e.cwTok||0));
      }
    }
    var out = [];
    m.forEach(function(r){
      if (r.writes <= 0) return; // no writes → nothing to amortize
      // pick dominant model for price
      var dom = null, domV = -1;
      r.modelMix.forEach(function(v, k){ if (v > domV){ domV = v; dom = k; } });
      var p = priceFor(dom);
      var breakEvenN = breakEvenReadsForPrice(p);
      var readsPerWrite = r.writes ? (r.reads / r.writes) : 0;
      var status;
      if (readsPerWrite <= 0)            status = "WASTED";
      else if (readsPerWrite < breakEvenN) status = "BREAKING EVEN";
      else                                 status = "PAID OFF";
      out.push({
        project: r.project,
        sessions: r.sessions.size,
        writes: r.writes,
        reads: r.reads,
        readsPerWrite: readsPerWrite,
        breakEvenN: breakEvenN,
        status: status,
        model: dom,
      });
    });
    // Sort: WASTED first, then BREAKING EVEN, then PAID OFF; within each, lowest R/W first.
    var order = { "WASTED":0, "BREAKING EVEN":1, "PAID OFF":2 };
    out.sort(function(a,b){
      var oa = order[a.status] - order[b.status];
      if (oa !== 0) return oa;
      return a.readsPerWrite - b.readsPerWrite;
    });
    return out;
  }

  function priceFor(model){
    var PRICING = window.PRICING || [];
    if (!PRICING.length) return { in:3, out:15, cacheRead:0.3, cacheWrite:3.75 };
    var m = (model||"").toLowerCase();
    for (var i=0;i<PRICING.length;i++){
      var p = PRICING[i];
      if (p.match && m.indexOf(p.match) >= 0) return p;
    }
    return PRICING[PRICING.length-1];
  }

  function fmt$(n){ return "$"+(n||0).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2}); }
  function fmtTok(n){
    if (!n || !isFinite(n)) return "0";
    if (n>=1e9) return (n/1e9).toFixed(2)+"B";
    if (n>=1e6) return (n/1e6).toFixed(2)+"M";
    if (n>=1e3) return (n/1e3).toFixed(1)+"k";
    return String(n|0);
  }
  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c];
    });
  }

  function render(pane){
    if (!pane) return;
    var events = (window.STATE && window.STATE.events) || [];
    try {
      if (window.ClaudeMeter && window.ClaudeMeter.filterBar) {
        events = window.ClaudeMeter.filterBar.applyFilters(events);
      }
    } catch(_){}

    // Count distinct sessions across filtered view — for "come back after 10+" hint.
    var sessSet = new Set();
    for (var i=0;i<events.length;i++) if (events[i].session) sessSet.add(events[i].session);
    var sessionCount = sessSet.size;

    pane.innerHTML = "";
    pane.classList.remove("disabled");

    var h = document.createElement("h3");
    h.textContent = "Write amortization break-even";
    pane.appendChild(h);

    var p = defaultPrice();
    var N = breakEvenReadsForPrice(p);
    var sub = document.createElement("div");
    sub.className = "pane-sub";
    sub.textContent = "Break-even at ~" + N + " reads per written token (sonnet defaults). " +
      "Sort: most-wasted projects first.";
    pane.appendChild(sub);

    var rows = aggregate(events);
    if (!rows.length || sessionCount < 10){
      var empty = document.createElement("div");
      empty.className = "amort-empty";
      empty.textContent = "Not enough cache-write history yet — come back after 10+ sessions.";
      pane.appendChild(empty);
      return;
    }

    var tbl = document.createElement("table");
    tbl.className = "amort-table";
    tbl.innerHTML = '<thead><tr>' +
      '<th>Project</th>' +
      '<th class="num">Sessions</th>' +
      '<th class="num">Writes</th>' +
      '<th class="num">Reads</th>' +
      '<th class="num">Reads / write</th>' +
      '<th class="num">Break-even N</th>' +
      '<th>Status</th>' +
    '</tr></thead>';
    var tb = document.createElement("tbody");
    for (var r=0; r<rows.length; r++){
      var row = rows[r];
      var cls = row.status === "WASTED" ? "bad"
              : row.status === "BREAKING EVEN" ? "warn" : "good";
      var tr = document.createElement("tr");
      tr.innerHTML = '<td>' + escapeHtml(row.project) + '</td>' +
        '<td class="num">' + row.sessions + '</td>' +
        '<td class="num">' + fmtTok(row.writes) + '</td>' +
        '<td class="num">' + fmtTok(row.reads) + '</td>' +
        '<td class="num">' + row.readsPerWrite.toFixed(2) + '</td>' +
        '<td class="num">' + row.breakEvenN + '</td>' +
        '<td><span class="pill ' + cls + '">' + row.status + '</span></td>';
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
    pane.appendChild(tbl);
  }

  window.ClaudeMeter = window.ClaudeMeter || {};
  window.ClaudeMeter.amortization = {
    render: render,
    aggregate: aggregate,
    breakEvenReadsForPrice: breakEvenReadsForPrice,
  };
})();
