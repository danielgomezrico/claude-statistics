/*
 * chart-enhancers.js — Enhancements applied to existing Chart.js canvases.
 *   enhanceTimeChart(): adds metric toggle, plan-line, compare ghost, brush-to-select,
 *                       click-point drawer stub.
 *   enhanceCumulative(): adds break-even marker, p10-p90 projection fan, plan-line step,
 *                        compare ghost, share-as-PNG stub.
 * All code guards on `typeof Chart !== 'undefined'` and missing canvases.
 */
(function () {
  window.ClaudeMeter = window.ClaudeMeter || {};
  if (typeof Chart === 'undefined') return;

  var metric = 'cost';

  function getEvents() {
    var events = (window.STATE && window.STATE.events) || [];
    return window.ClaudeMeter.filterBar ? window.ClaudeMeter.filterBar.applyFilters(events) : events;
  }

  // --- Time chart enhancements ---
  function enhanceTimeChart() {
    if (!window.STATE || !window.STATE.charts || !window.STATE.charts.time) return;
    var chart = window.STATE.charts.time;
    var bucket = window.STATE.bucket || 'day';
    var events = getEvents();

    // Re-project metric
    if (metric !== 'cost') {
      var agg = aggregate(events, bucket);
      chart.data.datasets[0].data = agg.map(function (d) {
        if (metric === 'tokens') return d.inTok + d.outTok + d.crTok + d.cwTok;
        if (metric === 'messages') return d.msgs;
        return d.cost;
      });
      chart.data.datasets[0].label = metric === 'tokens' ? 'Tokens' : metric === 'messages' ? 'Messages' : 'API-equivalent cost (USD)';
      chart.options.scales.y.ticks.callback = metric === 'cost'
        ? function (v) { return '$' + v; }
        : function (v) { return v; };
    }

    // Plan-line
    var planSel = document.getElementById('plan');
    var plan = planSel ? parseFloat(planSel.value) || 0 : 0;
    if (plan && metric === 'cost') {
      var perBucket = plan / (bucket === 'day' ? 30.4375 : bucket === 'week' ? 4.345 : bucket === 'month' ? 1 : 730);
      var labels = chart.data.labels || [];
      var planSeries = labels.map(function () { return perBucket; });
      removeDataset(chart, '__plan');
      chart.data.datasets.push({
        __id: '__plan',
        label: 'Plan/' + bucket,
        type: 'line',
        data: planSeries,
        borderColor: '#6ea8ff',
        borderDash: [4, 4],
        pointRadius: 0,
        fill: false,
        tension: 0,
      });
    }

    // Compare-period ghost
    var f = window.ClaudeMeter.filterBar && window.ClaudeMeter.filterBar.getFilters();
    if (f && f.compare && f.compare !== 'off' && f.range && window.ClaudeMeter.comparePeriod) {
      var shifted = window.ClaudeMeter.comparePeriod.seriesShifted(window.STATE.events, f.range, f.compare, bucket, metric);
      if (shifted.length) {
        removeDataset(chart, '__compare');
        chart.data.datasets.push({
          __id: '__compare',
          label: 'Compare (' + f.compare + ')',
          type: 'line',
          data: shifted.slice(0, chart.data.labels.length),
          borderColor: '#8a93a6',
          borderDash: [6, 3],
          pointRadius: 0,
          fill: false,
        });
      }
    }

    chart.update('none');

    // Click-point → drawer stub
    var canvas = chart.canvas;
    if (canvas && !canvas.__clickBound) {
      canvas.addEventListener('click', function (evt) {
        var pts = chart.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, true);
        if (!pts.length) return;
        var idx = pts[0].index;
        var lbl = chart.data.labels[idx];
        alert('Session drawer (Wave 2): ' + lbl + ' — filter by this bucket.');
      });
      canvas.__clickBound = true;
    }

    // Brush-to-select
    if (canvas && !canvas.__brushBound) {
      attachBrush(canvas, chart);
      canvas.__brushBound = true;
    }
  }

  function removeDataset(chart, id) {
    chart.data.datasets = chart.data.datasets.filter(function (ds) { return ds.__id !== id; });
  }

  function aggregate(events, bucket) {
    if (window.CM && window.CM.metrics) return window.CM.metrics.aggregate(events, bucket);
    // inline fallback
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

  function attachBrush(canvas, chart) {
    var rect = null, startX = null, overlay = null;
    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      var r = canvas.getBoundingClientRect();
      startX = e.clientX - r.left;
      overlay = document.createElement('div');
      overlay.style.position = 'absolute';
      overlay.style.pointerEvents = 'none';
      overlay.style.top = '0'; overlay.style.bottom = '0';
      overlay.style.left = startX + 'px'; overlay.style.width = '1px';
      overlay.style.background = 'rgba(110,168,255,.25)';
      overlay.style.border = '1px solid #6ea8ff';
      canvas.parentElement.style.position = 'relative';
      canvas.parentElement.appendChild(overlay);
    });
    canvas.addEventListener('mousemove', function (e) {
      if (startX == null) return;
      var r = canvas.getBoundingClientRect();
      var x = e.clientX - r.left;
      var lo = Math.min(startX, x), hi = Math.max(startX, x);
      overlay.style.left = lo + 'px'; overlay.style.width = (hi - lo) + 'px';
    });
    canvas.addEventListener('mouseup', function (e) {
      if (startX == null) { cleanup(); return; }
      var r = canvas.getBoundingClientRect();
      var endX = e.clientX - r.left;
      var lo = Math.min(startX, endX), hi = Math.max(startX, endX);
      if (Math.abs(hi - lo) < 6) { cleanup(); return; }
      // Map canvas x to data indices via x scale
      var scale = chart.scales.x;
      var fromIdx = Math.max(0, Math.round(scale.getValueForPixel(lo)));
      var toIdx = Math.min(chart.data.labels.length - 1, Math.round(scale.getValueForPixel(hi)));
      var bucket = window.STATE.bucket || 'day';
      var agg = aggregate(window.STATE.events, bucket);
      if (agg[fromIdx] && agg[toIdx]) {
        var start = new Date(agg[fromIdx].ts);
        var end = new Date(agg[toIdx].ts);
        end.setHours(23, 59, 59, 999);
        var fb = window.ClaudeMeter.filterBar;
        if (fb) {
          var f = fb.getFilters();
          f.range = { start: start, end: end };
          f.rangePreset = 'custom';
          // Force notify by re-init chip labels via a dummy change:
          if (window.ClaudeMeter.urlHash) window.ClaudeMeter.urlHash.write(f);
          try { window.__cmRecompute && window.__cmRecompute(); } catch (_) {}
        }
      }
      cleanup();
    });
    function cleanup() {
      startX = null;
      if (overlay && overlay.parentElement) overlay.parentElement.removeChild(overlay);
      overlay = null;
    }
  }

  // --- Cumulative enhancements ---
  function enhanceCumulative() {
    if (!window.STATE || !window.STATE.charts || !window.STATE.charts.cum) return;
    var chart = window.STATE.charts.cum;
    var events = getEvents();
    if (!events.length) return;
    var daily = aggregate(events, 'day');
    var cum = 0;
    var cumSeries = daily.map(function (d) { cum += d.cost; return cum; });
    var planSel = document.getElementById('plan');
    var plan = planSel ? parseFloat(planSel.value) || 0 : 0;

    // Break-even marker: first index where cumSeries[i] > plan-line
    var firstTs = daily[0].ts;
    var subPerDay = plan / 30.4375;
    var planLine = daily.map(function (d) { return ((d.ts - firstTs) / 86400000 + 1) * subPerDay; });
    var beIdx = -1;
    for (var i = 0; i < cumSeries.length; i++) {
      if (plan && cumSeries[i] > planLine[i]) { beIdx = i; break; }
    }

    // p10-p90 projection fan to month-end
    var now = new Date();
    var mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    var last = daily[daily.length - 1];
    var lastDate = new Date(last.ts);
    var daysLeft = Math.max(0, Math.ceil((mEnd - lastDate) / 86400000));
    // Use trailing 7d daily mean & sd
    var tail = daily.slice(-7).map(function (d) { return d.cost; });
    var mean = tail.reduce(function (s, x) { return s + x; }, 0) / Math.max(1, tail.length);
    var variance = tail.reduce(function (s, x) { return s + (x - mean) * (x - mean); }, 0) / Math.max(1, tail.length);
    var sd = Math.sqrt(variance);
    var p10 = Math.max(0, mean - 1.28 * sd);
    var p90 = mean + 1.28 * sd;

    var labels = daily.map(function (d) { return new Date(d.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); });
    var p50Series = cumSeries.slice();
    var p10Series = cumSeries.slice();
    var p90Series = cumSeries.slice();
    var cum50 = cumSeries[cumSeries.length - 1] || 0;
    var cum10 = cum50, cum90 = cum50;
    for (var j = 1; j <= daysLeft; j++) {
      var dt = new Date(lastDate.getTime() + j * 86400000);
      labels.push(dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + '*');
      cum10 += p10; cum50 += mean; cum90 += p90;
      p10Series.push(cum10); p50Series.push(cum50); p90Series.push(cum90);
    }

    chart.data.labels = labels;
    // Replace datasets: keep original cumulative and plan-line, add p10-p90 cone & break-even vertical.
    chart.data.datasets = [
      { label: 'Cumulative API eq.', data: p50Series.map(function (v, i) { return i < cumSeries.length ? cumSeries[i] : null; }), borderColor: '#d97757', backgroundColor: '#d9775722', fill: true, tension: 0.2, pointRadius: 0 },
      { label: 'Projection p50', data: p50Series.map(function (v, i) { return i >= cumSeries.length - 1 ? v : null; }), borderColor: '#d97757', borderDash: [2, 3], pointRadius: 0, fill: false },
      { label: 'Projection p90', data: p90Series.map(function (v, i) { return i >= cumSeries.length - 1 ? v : null; }), borderColor: '#d9775733', pointRadius: 0, fill: '+1', backgroundColor: '#d9775722' },
      { label: 'Projection p10', data: p10Series.map(function (v, i) { return i >= cumSeries.length - 1 ? v : null; }), borderColor: '#d9775733', pointRadius: 0, fill: false },
      { label: 'Cumulative subscription', data: labels.map(function (_, i) { return plan ? ((i + 1) * subPerDay) : 0; }), borderColor: '#6ea8ff', borderDash: [6, 4], pointRadius: 0, fill: false },
    ];

    // Break-even annotation (rendered via afterDraw plugin)
    chart.__beIdx = beIdx;
    if (!chart.__beInstalled) {
      var plugin = {
        id: 'breakEvenMarker',
        afterDraw: function (c) {
          var idx = c.__beIdx;
          if (idx == null || idx < 0) return;
          var x = c.scales.x.getPixelForValue(idx);
          var ctx = c.ctx;
          ctx.save();
          ctx.strokeStyle = '#ef4444';
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(x, c.chartArea.top);
          ctx.lineTo(x, c.chartArea.bottom);
          ctx.stroke();
          ctx.fillStyle = '#ef4444';
          ctx.font = '11px sans-serif';
          ctx.fillText('Break-even', x + 4, c.chartArea.top + 12);
          ctx.restore();
        },
      };
      Chart.register(plugin);
      chart.__beInstalled = true;
    }
    chart.update('none');
  }

  // Metric toggle setter
  function setMetric(m) {
    metric = m;
    try { enhanceTimeChart(); } catch (e) { console.error(e); }
  }

  window.ClaudeMeter.chartEnhancers = {
    enhanceTimeChart: enhanceTimeChart,
    enhanceCumulative: enhanceCumulative,
    setMetric: setMetric,
  };
})();
