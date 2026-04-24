/*
 * compare-period.js — Helpers for compare-period overlays (prev / YoY / custom).
 * Public API: window.ClaudeMeter.comparePeriod
 *   offsetFor(mode, range) -> { start, end } shifted range for compare
 *   seriesShifted(events, range, mode, bucket, metric) -> aggregated array aligned to primary labels
 */
(function () {
  window.ClaudeMeter = window.ClaudeMeter || {};

  function offsetFor(mode, range) {
    if (!range || !range.start || !range.end) return null;
    var s = +range.start, e = +range.end;
    var span = e - s;
    if (mode === 'prev') return { start: new Date(s - span), end: new Date(e - span) };
    if (mode === 'yoy') {
      var ss = new Date(range.start); ss.setFullYear(ss.getFullYear() - 1);
      var ee = new Date(range.end); ee.setFullYear(ee.getFullYear() - 1);
      return { start: ss, end: ee };
    }
    return null;
  }

  function seriesShifted(events, range, mode, bucket, metric) {
    var off = offsetFor(mode, range);
    if (!off) return [];
    var s = +off.start, e = +off.end;
    var filtered = events.filter(function (ev) { var t = +ev.ts; return t >= s && t <= e; });
    // Use same bucket aggregation as primary
    var agg = window.CM && window.CM.metrics ? window.CM.metrics.aggregate(filtered, bucket) : simpleAgg(filtered, bucket);
    return agg.map(function (d) { return extractMetric(d, metric); });
  }

  function simpleAgg(events, bucket) {
    var map = new Map();
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      var d = new Date(e.ts);
      if (bucket === 'day') d.setHours(0,0,0,0);
      else if (bucket === 'week') { var day = d.getDay(); d.setHours(0,0,0,0); d.setDate(d.getDate() - day); }
      else if (bucket === 'month') d = new Date(d.getFullYear(), d.getMonth(), 1);
      else if (bucket === 'hour') d.setMinutes(0,0,0);
      var k = d.getTime();
      if (!map.has(k)) map.set(k, { ts: k, cost: 0, msgs: 0, inTok: 0, outTok: 0, crTok: 0, cwTok: 0 });
      var a = map.get(k);
      a.cost += e.cost; a.msgs++;
      a.inTok += e.inTok; a.outTok += e.outTok; a.crTok += e.crTok; a.cwTok += e.cwTok;
    }
    return Array.from(map.values()).sort(function (a, b) { return a.ts - b.ts; });
  }

  function extractMetric(d, metric) {
    if (metric === 'tokens') return d.inTok + d.outTok + d.crTok + d.cwTok;
    if (metric === 'messages') return d.msgs;
    return d.cost;
  }

  window.ClaudeMeter.comparePeriod = {
    offsetFor: offsetFor,
    seriesShifted: seriesShifted,
    extractMetric: extractMetric,
  };
})();
