/*
 * metrics.js — Event aggregation + formatters.
 * Public API (window.CM.metrics):
 *   bucketKey(date, bucket)            → numeric key for grouping
 *   fmtBucketLabel(ts, bucket)         → human label
 *   aggregate(events, bucket)          → [{ts,cost,msgs,inTok,outTok,crTok,cwTok}]
 *   totals(events)                     → { total, sessions, msgs, inTok, outTok, crTok, cwTok, min, max }
 *   fmt$, fmtInt, fmtTok               → string formatters
 *   recomputeCosts(events)             → recalculates event.cost from current pricing (in place)
 */
(function () {
  window.CM = window.CM || {};

  function bucketKey(d, bucket) {
    var x = new Date(d);
    if (bucket === 'hour')  { x.setMinutes(0, 0, 0); return x.getTime(); }
    if (bucket === 'day')   { x.setHours(0, 0, 0, 0); return x.getTime(); }
    if (bucket === 'week')  { var day = x.getDay(); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - day); return x.getTime(); }
    if (bucket === 'month') { return new Date(x.getFullYear(), x.getMonth(), 1).getTime(); }
    return +x;
  }

  function fmtBucketLabel(ts, bucket) {
    var d = new Date(ts);
    if (bucket === 'hour')  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
    if (bucket === 'day')   return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (bucket === 'week')  return 'Wk ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (bucket === 'month') return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
    return d.toISOString();
  }

  function aggregate(events, bucket) {
    var map = new Map();
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      var k = bucketKey(e.ts, bucket);
      if (!map.has(k)) map.set(k, { ts: k, cost: 0, msgs: 0, inTok: 0, outTok: 0, crTok: 0, cwTok: 0 });
      var a = map.get(k);
      a.cost += e.cost; a.msgs++;
      a.inTok += e.inTok; a.outTok += e.outTok; a.crTok += e.crTok; a.cwTok += e.cwTok;
    }
    return [].concat.apply([], [Array.from(map.values())]).sort(function (a, b) { return a.ts - b.ts; });
  }

  function totals(events) {
    if (!events.length) return { total: 0, sessions: 0, msgs: 0, inTok: 0, outTok: 0, crTok: 0, cwTok: 0, min: null, max: null };
    var total = 0, inTok = 0, outTok = 0, crTok = 0, cwTok = 0;
    var min = events[0].ts, max = events[0].ts;
    var sessSet = new Set();
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      total += e.cost; inTok += e.inTok; outTok += e.outTok; crTok += e.crTok; cwTok += e.cwTok;
      if (e.ts < min) min = e.ts;
      if (e.ts > max) max = e.ts;
      sessSet.add(e.session);
    }
    return { total: total, sessions: sessSet.size, msgs: events.length, inTok: inTok, outTok: outTok, crTok: crTok, cwTok: cwTok, min: min, max: max };
  }

  function fmt$(n) { return '$' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 }); }
  function fmtInt(n) { return (n || 0).toLocaleString(); }
  function fmtTok(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  function recomputeCosts(events) {
    var priceFor = window.CM.pricing.priceFor;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      var p = priceFor(e.model);
      e.cost = (e.inTok * p.in + e.outTok * p.out + e.crTok * p.cacheRead + e.cwTok * p.cacheWrite) / 1e6;
    }
  }

  window.CM.metrics = {
    bucketKey: bucketKey,
    fmtBucketLabel: fmtBucketLabel,
    aggregate: aggregate,
    totals: totals,
    fmt$: fmt$,
    fmtInt: fmtInt,
    fmtTok: fmtTok,
    recomputeCosts: recomputeCosts,
  };
})();
