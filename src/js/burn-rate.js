/*
 * burn-rate.js — Semi-circular burn-rate gauge with p10-p90 projection cone.
 * Sofia constraint S9: never a point prediction; always render p10-p90 translucent cone.
 * Inputs derived from trailing-7d cost + day-of-month + plan cap.
 * Public API: window.ClaudeMeter.burnRate.render()
 */
(function () {
  window.ClaudeMeter = window.ClaudeMeter || {};

  function compute() {
    var events = (window.STATE && window.STATE.events) || [];
    var filtered = window.ClaudeMeter && window.ClaudeMeter.filterBar ? window.ClaudeMeter.filterBar.applyFilters(events) : events;
    var now = new Date();
    var cutoff = new Date(now.getTime() - 7 * 86400000);
    var days = [];
    // daily costs for last 7 days
    var daily = new Map();
    for (var i = 0; i < filtered.length; i++) {
      var e = filtered[i];
      if (e.ts < cutoff) continue;
      var d = new Date(e.ts); d.setHours(0,0,0,0);
      var k = d.getTime();
      daily.set(k, (daily.get(k) || 0) + e.cost);
    }
    for (var d = 0; d < 7; d++) {
      var dt = new Date(now.getTime() - d * 86400000);
      dt.setHours(0,0,0,0);
      days.push(daily.get(dt.getTime()) || 0);
    }
    var mean = days.reduce(function (s, x) { return s + x; }, 0) / 7;
    var variance = days.reduce(function (s, x) { return s + (x - mean) * (x - mean); }, 0) / 7;
    var sd = Math.sqrt(variance);
    var p10 = Math.max(0, mean - 1.28 * sd);
    var p90 = mean + 1.28 * sd;
    var planSel = document.getElementById('plan');
    var plan = planSel ? parseFloat(planSel.value) || 0 : 0;
    // Daily cap = plan / 30.4375
    var cap = plan ? plan / 30.4375 : 0;
    return { p10: p10, p50: mean, p90: p90, cap: cap, days: days };
  }

  function render() {
    var svg = document.getElementById('heroGauge');
    if (!svg) return;
    var d = compute();
    var cap = d.cap || Math.max(d.p90, 1);
    var max = Math.max(cap * 1.5, d.p90);
    svg.innerHTML = '';
    var W = 200, H = 120, cx = 100, cy = 110, R = 80;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    // Background arc
    svg.appendChild(arc(cx, cy, R, Math.PI, 0, '#262b38', 14, null));
    // Cone p10-p90 (translucent)
    var a10 = Math.PI - (d.p10 / max) * Math.PI;
    var a90 = Math.PI - (d.p90 / max) * Math.PI;
    svg.appendChild(arc(cx, cy, R, Math.PI, a90, '#6ea8ff55', 14, null));
    svg.appendChild(arc(cx, cy, R, a90, a10, '#6ea8ff88', 14, null));
    // Median marker
    var a50 = Math.PI - (d.p50 / max) * Math.PI;
    var mx = cx + R * Math.cos(a50), my = cy - R * Math.sin(a50);
    var marker = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    marker.setAttribute('cx', mx); marker.setAttribute('cy', my);
    marker.setAttribute('r', 5); marker.setAttribute('fill', '#d97757');
    svg.appendChild(marker);
    // Cap tick
    if (cap) {
      var ac = Math.PI - Math.min(1, cap / max) * Math.PI;
      var tx1 = cx + (R - 8) * Math.cos(ac), ty1 = cy - (R - 8) * Math.sin(ac);
      var tx2 = cx + (R + 8) * Math.cos(ac), ty2 = cy - (R + 8) * Math.sin(ac);
      var tick = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      tick.setAttribute('x1', tx1); tick.setAttribute('y1', ty1);
      tick.setAttribute('x2', tx2); tick.setAttribute('y2', ty2);
      tick.setAttribute('stroke', '#e6e8ee'); tick.setAttribute('stroke-width', 2);
      svg.appendChild(tick);
    }
    // Label
    var txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.setAttribute('x', cx); txt.setAttribute('y', cy - 20);
    txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('fill', '#e6e8ee');
    txt.setAttribute('font-size', '20');
    txt.setAttribute('font-weight', '700');
    txt.textContent = '$' + d.p50.toFixed(2) + '/d';
    svg.appendChild(txt);

    svg.setAttribute('title', 'p10 $' + d.p10.toFixed(2) + ' · p50 $' + d.p50.toFixed(2) + ' · p90 $' + d.p90.toFixed(2) + (cap ? ' · cap $' + cap.toFixed(2) : ''));

    var cap2 = document.getElementById('heroGaugeCaption');
    if (cap2) cap2.textContent = 'p10 $' + d.p10.toFixed(2) + '  p50 $' + d.p50.toFixed(2) + '  p90 $' + d.p90.toFixed(2);
  }

  function arc(cx, cy, r, a1, a2, color, width, cls) {
    var ns = 'http://www.w3.org/2000/svg';
    var p = document.createElementNS(ns, 'path');
    var x1 = cx + r * Math.cos(a1), y1 = cy - r * Math.sin(a1);
    var x2 = cx + r * Math.cos(a2), y2 = cy - r * Math.sin(a2);
    var large = Math.abs(a1 - a2) > Math.PI ? 1 : 0;
    var sweep = a2 < a1 ? 1 : 0;
    var dattr = 'M ' + x1 + ' ' + y1 + ' A ' + r + ' ' + r + ' 0 ' + large + ' ' + sweep + ' ' + x2 + ' ' + y2;
    p.setAttribute('d', dattr);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', color);
    p.setAttribute('stroke-width', width);
    p.setAttribute('stroke-linecap', 'round');
    if (cls) p.setAttribute('class', cls);
    return p;
  }

  window.ClaudeMeter.burnRate = { render: render, compute: compute };
})();
