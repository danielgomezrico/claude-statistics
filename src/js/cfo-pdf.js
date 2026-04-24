/* cfo-pdf.js — Wave 3 D4 / F19
 * Renders a CFO-grade serif monthly summary inside a hidden iframe and triggers print.
 * No external deps. Uses surveillance.anonymize() for the engineer roster.
 *
 * Public API: window.ClaudeMeter.cfoPdf = {
 *   exportPdf({ events, month, projectName, companyName }),
 *   installButton(container)
 * }
 */
(function(){
  window.ClaudeMeter = window.ClaudeMeter || {};

  var KEY = "cm.cfo.org";

  function fmt$(n){ return "$" + (n||0).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2}); }
  function pct(n){ return (n*100).toFixed(1) + "%"; }
  function escapeHtml(s){
    return String(s||"").replace(/[&<>"']/g, function(c){
      return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c];
    });
  }
  function monthBounds(d){
    var y = d.getFullYear(), m = d.getMonth();
    return { start: new Date(y, m, 1), end: new Date(y, m+1, 0, 23,59,59) };
  }
  function monthLabel(d){
    return d.toLocaleString(undefined, { month: "long", year: "numeric" });
  }

  // Stable, dependency-free 32-bit FNV-1a hash for "signed hash" on the report.
  function fnv1a(str){
    var h = 0x811c9dc5;
    for (var i=0;i<str.length;i++){
      h ^= str.charCodeAt(i);
      h = (h + ((h<<1) + (h<<4) + (h<<7) + (h<<8) + (h<<24))) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
  }

  function aggregate(events, month){
    var b = monthBounds(month);
    var inMonth = events.filter(function(e){ return e.ts >= b.start && e.ts <= b.end; });
    var totals = { cost:0, msgs: inMonth.length, inTok:0, outTok:0, crTok:0, cwTok:0 };
    var byProject = new Map();
    var byEngineer = new Map();
    for (var i=0;i<inMonth.length;i++){
      var e = inMonth[i];
      totals.cost += e.cost||0;
      totals.inTok += e.inTok||0; totals.outTok += e.outTok||0;
      totals.crTok += e.crTok||0; totals.cwTok += e.cwTok||0;
      var pk = e.project || "(unknown)";
      if (!byProject.has(pk)) byProject.set(pk, { project: pk, cost:0, msgs:0, sessions: new Set() });
      var pa = byProject.get(pk);
      pa.cost += e.cost||0; pa.msgs++; pa.sessions.add(e.session);
      var who = e.agentName || e.teamName || null;
      if (who) {
        if (!byEngineer.has(who)) byEngineer.set(who, 0);
        byEngineer.set(who, byEngineer.get(who) + (e.cost||0));
      }
    }
    var projects = [...byProject.values()].sort(function(a,b){ return b.cost - a.cost; });
    projects.forEach(function(p){ p.sessionCount = p.sessions.size; delete p.sessions; });
    var engineers = [...byEngineer.entries()].sort(function(a,b){ return b[1]-a[1]; });
    return { range: b, totals: totals, projects: projects, engineers: engineers, msgCount: inMonth.length };
  }

  function buildReportHtml(data){
    var totals = data.totals;
    var totTok = totals.inTok + totals.outTok + totals.crTok + totals.cwTok;
    var cacheRatio = totTok > 0 ? (totals.crTok / totTok) : 0;
    var cacheSavings = totals.crTok * (3 - 0.3) / 1e6; // sonnet-default approx

    var anonymize = (window.ClaudeMeter && window.ClaudeMeter.surveillance && window.ClaudeMeter.surveillance.anonymize) ||
                    function(n){ return n; };
    var roster = data.engineers.slice(0, 12).map(function(e){
      return escapeHtml(anonymize(e[0])) + " (" + fmt$(e[1]) + ")";
    }).join(" · ");
    if (!roster) roster = "(no agent attribution captured this month)";

    var month = monthLabel(data.range.start);
    var generated = new Date().toLocaleString();
    var orgName = escapeHtml(data.companyName || data.projectName || "Claude Code Project");
    var url = (typeof location !== "undefined" ? location.href : "");
    var hashSrc = month + "|" + totals.cost.toFixed(4) + "|" + data.projects.length + "|" + url;
    var sig = fnv1a(hashSrc);

    var monthlyRows =
      "<tr><td>API-equivalent cost</td><td class=num>" + fmt$(totals.cost) + "</td></tr>" +
      "<tr><td>Messages</td><td class=num>" + (totals.msgs).toLocaleString() + "</td></tr>" +
      "<tr><td>Input tokens</td><td class=num>" + (totals.inTok).toLocaleString() + "</td></tr>" +
      "<tr><td>Output tokens</td><td class=num>" + (totals.outTok).toLocaleString() + "</td></tr>" +
      "<tr><td>Cache reads</td><td class=num>" + (totals.crTok).toLocaleString() + "</td></tr>" +
      "<tr><td>Cache writes</td><td class=num>" + (totals.cwTok).toLocaleString() + "</td></tr>";

    var projectRows = data.projects.slice(0, 20).map(function(p){
      return "<tr><td>" + escapeHtml(p.project) + "</td>" +
             "<td class=num>" + p.sessionCount + "</td>" +
             "<td class=num>" + (p.msgs).toLocaleString() + "</td>" +
             "<td class=num>" + fmt$(p.cost) + "</td></tr>";
    }).join("");
    if (!projectRows) projectRows = "<tr><td colspan=4 style='text-align:center;color:#888'>No activity in selected month.</td></tr>";

    var summary = "During " + month + ", " + orgName + " incurred " + fmt$(totals.cost) +
                  " of API-equivalent Claude Code usage across " + data.projects.length +
                  " project" + (data.projects.length===1?"":"s") + " and " +
                  totals.msgs.toLocaleString() + " messages. Cache reads accounted for " +
                  pct(cacheRatio) + " of token volume, equivalent to approximately " +
                  fmt$(cacheSavings) + " in avoided list-price input cost.";

    return '<!doctype html>' +
'<html><head><meta charset="utf-8" />' +
'<title>CFO report — ' + escapeHtml(month) + '</title>' +
'<style>' +
'  body{margin:0;background:#fff;}' +
'  .cfo-report{font-family:"Iowan Old Style","Palatino","Times New Roman",Times,serif;color:#111;background:#fff;padding:0.75in 0.85in;font-size:11pt;line-height:1.5;}' +
'  .cfo-report h1{font-size:22pt;margin:0 0 6pt;font-weight:700;}' +
'  .cfo-report h2{font-size:14pt;margin:18pt 0 6pt;border-bottom:1px solid #999;padding-bottom:3pt;}' +
'  .cfo-report .meta{color:#555;font-size:10pt;margin-bottom:18pt;}' +
'  .cfo-report .summary{font-style:italic;margin:0 0 12pt;}' +
'  .cfo-report table{width:100%;border-collapse:collapse;font-size:10.5pt;margin:8pt 0;}' +
'  .cfo-report th,.cfo-report td{border-bottom:1px solid #ccc;padding:5pt 8pt;text-align:left;}' +
'  .cfo-report th{background:#f4f1ea;font-weight:700;font-size:9.5pt;text-transform:uppercase;letter-spacing:.4pt;}' +
'  .cfo-report td.num,.cfo-report th.num{text-align:right;font-variant-numeric:tabular-nums;}' +
'  .cfo-report .cache-line{margin:10pt 0;font-size:11pt;}' +
'  .cfo-report .signature{margin-top:36pt;display:flex;justify-content:space-between;gap:24pt;align-items:flex-end;}' +
'  .cfo-report .signature .sig-block{flex:1;border-top:1px solid #333;padding-top:4pt;font-size:10pt;}' +
'  .cfo-report .footer{margin-top:24pt;padding-top:8pt;border-top:1px solid #999;font-size:9pt;color:#444;}' +
'  .cfo-report .roster{color:#444;font-size:9pt;}' +
'  .cfo-report .hash{font-family:"Courier New",monospace;font-size:8.5pt;color:#555;word-break:break-all;}' +
'  @page{size:Letter;margin:0.5in;}' +
'  @media print{.cfo-report{padding:0;}}' +
'</style></head>' +
'<body><div class="cfo-report">' +
  '<h1>' + orgName + '</h1>' +
  '<div class="meta">Monthly Claude Code expenditure report &middot; ' + escapeHtml(month) + ' &middot; generated ' + escapeHtml(generated) + '</div>' +
  '<h2>Executive summary</h2>' +
  '<p class="summary">' + escapeHtml(summary) + '</p>' +
  '<h2>Monthly cost</h2>' +
  '<table><tbody>' + monthlyRows + '</tbody></table>' +
  '<h2>Per-project breakdown</h2>' +
  '<table><thead><tr><th>Project</th><th class=num>Sessions</th><th class=num>Messages</th><th class=num>API eq. cost</th></tr></thead>' +
  '<tbody>' + projectRows + '</tbody></table>' +
  '<div class="cache-line"><strong>Cache efficiency.</strong> ' +
    'Cache reads were ' + pct(cacheRatio) + ' of total token volume; estimated avoided cost &approx; ' + fmt$(cacheSavings) + '.</div>' +
  '<h2>Sign-off</h2>' +
  '<div class="signature">' +
    '<div class="sig-block">CFO signature &mdash; date</div>' +
    '<div class="sig-block">Engineering lead signature &mdash; date</div>' +
  '</div>' +
  '<div class="footer">' +
    '<div class="roster"><strong>Engineer roster (anonymized).</strong> ' + roster + '</div>' +
    '<div style="margin-top:6pt"><strong>Source.</strong> Generated locally by Claude Meter &middot; ' +
      '<a href="https://github.com/danielgomezrico/claude-statistics" style="color:#444">github.com/danielgomezrico/claude-statistics</a>' +
    '</div>' +
    '<div class="hash" style="margin-top:6pt">Document signature: cm-fnv1a-' + sig + '</div>' +
  '</div>' +
'</div>' +
'<script>window.addEventListener("load",function(){setTimeout(function(){try{window.focus();window.print();}catch(e){}},120);});<\/script>' +
'</body></html>';
  }

  function getEvents(){
    var ev = (window.STATE && window.STATE.events) || [];
    if (window.ClaudeMeter && window.ClaudeMeter.filterBar) {
      try { ev = window.ClaudeMeter.filterBar.applyFilters(ev); } catch(e){}
    }
    return ev;
  }

  function exportPdf(opts){
    opts = opts || {};
    var events = opts.events || getEvents();
    var month = opts.month || new Date();
    if (typeof month === "string") month = new Date(month);

    var data = aggregate(events, month);
    data.companyName = opts.companyName;
    data.projectName = opts.projectName;
    if (!data.companyName && !data.projectName) {
      try {
        var raw = localStorage.getItem(KEY);
        if (raw) { var o = JSON.parse(raw); data.companyName = o.companyName; data.projectName = o.projectName; }
      } catch(e){}
    }

    var html = buildReportHtml(data);
    var iframe = document.getElementById("cmCfoIframe");
    if (!iframe) {
      iframe = document.createElement("iframe");
      iframe.id = "cmCfoIframe";
      document.body.appendChild(iframe);
    }
    var doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open(); doc.write(html); doc.close();
  }

  function buildMonthOptions(events){
    var set = new Set();
    for (var i=0;i<events.length;i++){
      var d = new Date(events[i].ts);
      set.add(new Date(d.getFullYear(), d.getMonth(), 1).getTime());
    }
    var arr = [...set].sort(function(a,b){ return b-a; });
    if (!arr.length) {
      var n = new Date(); arr = [new Date(n.getFullYear(), n.getMonth(), 1).getTime()];
    }
    return arr.map(function(t){ return new Date(t); });
  }

  function installButton(container){
    if (!container) {
      // Fallback: append into the Pricing details block.
      var details = document.querySelector("details.card");
      if (details) container = details;
    }
    if (!container) return;
    if (container.querySelector(".cm-cfo-trigger")) return;

    var row = document.createElement("div");
    row.className = "cm-cfo-trigger";

    var monthSel = document.createElement("select");
    monthSel.id = "cmCfoMonth";
    monthSel.style.cssText = "background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:12px";

    var orgInput = document.createElement("input");
    orgInput.type = "text"; orgInput.placeholder = "Company / project name";
    try { var raw = localStorage.getItem(KEY); if (raw) { var o = JSON.parse(raw); orgInput.value = o.companyName || o.projectName || ""; } } catch(e){}
    orgInput.addEventListener("change", function(){
      try { localStorage.setItem(KEY, JSON.stringify({ companyName: orgInput.value })); } catch(e){}
    });

    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "btn";
    btn.textContent = "Export → CFO PDF";
    btn.addEventListener("click", function(){
      var ev = getEvents();
      var months = buildMonthOptions(ev);
      var picked = months[parseInt(monthSel.value, 10)] || months[0];
      exportPdf({ events: ev, month: picked, companyName: orgInput.value });
    });

    var refresh = function(){
      var ev = getEvents();
      var months = buildMonthOptions(ev);
      monthSel.innerHTML = "";
      months.forEach(function(d, i){
        var o = document.createElement("option"); o.value = i;
        o.textContent = d.toLocaleString(undefined, { month: "long", year: "numeric" });
        monthSel.appendChild(o);
      });
    };
    refresh();
    if (window.ClaudeMeter && window.ClaudeMeter.filterBar) {
      try { window.ClaudeMeter.filterBar.onChange(refresh); } catch(e){}
    }

    var lblM = document.createElement("label"); lblM.textContent = "Month:";
    var lblO = document.createElement("label"); lblO.textContent = "Company:";
    row.appendChild(lblM); row.appendChild(monthSel);
    row.appendChild(lblO); row.appendChild(orgInput);
    row.appendChild(btn);
    container.appendChild(row);
  }

  window.ClaudeMeter.cfoPdf = {
    exportPdf: exportPdf,
    installButton: installButton,
    _aggregate: aggregate,
    _buildReportHtml: buildReportHtml,
  };
})();
