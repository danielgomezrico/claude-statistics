/*
 * csv-export.js — CSV export for current filtered event view.
 * Public API: window.ClaudeMeter.csvExport.download()
 * Columns: timestamp_iso, session, project, model, in_tokens, out_tokens,
 *          cache_read_tokens, cache_write_tokens, cost_usd
 */
(function () {
  window.ClaudeMeter = window.ClaudeMeter || {};

  function csvEscape(s) {
    if (s == null) return '';
    s = String(s);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function build(events) {
    var rows = [['timestamp_iso', 'session', 'project', 'model', 'in_tokens', 'out_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd'].join(',')];
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      rows.push([
        csvEscape(new Date(e.ts).toISOString()),
        csvEscape(e.session),
        csvEscape(e.project),
        csvEscape(e.model),
        e.inTok, e.outTok, e.crTok, e.cwTok,
        (e.cost || 0).toFixed(6),
      ].join(','));
    }
    return rows.join('\n');
  }

  function download() {
    var events = (window.STATE && window.STATE.events) || [];
    if (window.ClaudeMeter.filterBar) events = window.ClaudeMeter.filterBar.applyFilters(events);
    if (!events.length) { alert('No events to export.'); return; }
    var csv = build(events);
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = 'claude-usage-' + stamp + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  window.ClaudeMeter.csvExport = { download: download, build: build };
})();
