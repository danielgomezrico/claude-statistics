/*
 * insight-cards.js — Deterministic rule-based insight carousel (no LLM).
 * Rules (Sofia S9: factual only, no predictions):
 *   biggest-day, cache-waste, expensive-hour, top-tool, compare-period, burn-reassurance
 * Empty card policy: skip cards with no data.
 * Pin support via localStorage: pinned card surfaces first.
 * Public API: window.ClaudeMeter.insights.render()
 */
(function () {
  window.ClaudeMeter = window.ClaudeMeter || {};

  var PIN_KEY = 'cm:pinnedInsight';

  function getEvents() {
    var events = (window.STATE && window.STATE.events) || [];
    return window.ClaudeMeter && window.ClaudeMeter.filterBar ? window.ClaudeMeter.filterBar.applyFilters(events) : events;
  }

  function fmt$(n) { return '$' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 }); }

  // --- Rules return null to skip or { id, title, body, confidence }
  function ruleBiggestDay(events) {
    if (!events.length) return null;
    var cutoff = new Date(Date.now() - 7 * 86400000);
    var map = new Map();
    for (var i = 0; i < events.length; i++) {
      var e = events[i]; if (e.ts < cutoff) continue;
      var d = new Date(e.ts); d.setHours(0,0,0,0);
      map.set(d.getTime(), (map.get(d.getTime()) || 0) + e.cost);
    }
    if (!map.size) return null;
    var best = null;
    map.forEach(function (v, k) { if (!best || v > best.v) best = { k: k, v: v }; });
    return { id: 'biggest-day', title: 'Biggest day this week',
      body: new Date(best.k).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' }) + ' — ' + fmt$(best.v) + '.' };
  }

  function ruleCacheWaste(events) {
    if (!events.length) return null;
    // Sessions where cache_creation tokens are large but cache_read usage is small.
    var bySess = new Map();
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (!bySess.has(e.session)) bySess.set(e.session, { cw: 0, cr: 0, cost: 0 });
      var s = bySess.get(e.session);
      s.cw += e.cwTok; s.cr += e.crTok; s.cost += e.cost;
    }
    var worst = null;
    bySess.forEach(function (s, id) {
      if (s.cw > 50000 && s.cr < s.cw * 0.5) {
        if (!worst || s.cw > worst.cw) worst = { id: id, cw: s.cw, cr: s.cr, cost: s.cost };
      }
    });
    if (!worst) return null;
    return { id: 'cache-waste', title: 'Cache waste alert',
      body: 'Session ' + String(worst.id).slice(0, 8) + ' wrote ' + Math.round(worst.cw / 1000) + 'k cache tokens but reused < 50% — low cache ROI.' };
  }

  function ruleExpensiveHour(events) {
    if (!events.length) return null;
    var arr = new Array(24).fill(0);
    for (var i = 0; i < events.length; i++) arr[events[i].ts.getHours()] += events[i].cost;
    var max = 0, hr = -1;
    for (var h = 0; h < 24; h++) if (arr[h] > max) { max = arr[h]; hr = h; }
    if (hr < 0 || max === 0) return null;
    return { id: 'expensive-hour', title: 'Most-expensive hour-of-day',
      body: hr + ':00 locally accounts for ' + fmt$(max) + ' total (across your window).' };
  }

  function ruleTopTool(events) {
    if (!events.length) return null;
    // Proxy: top model this week (we don't have tool events in scope)
    var cutoff = new Date(Date.now() - 7 * 86400000);
    var map = new Map();
    for (var i = 0; i < events.length; i++) {
      var e = events[i]; if (e.ts < cutoff) continue;
      map.set(e.model, (map.get(e.model) || 0) + e.cost);
    }
    if (!map.size) return null;
    var best = null;
    map.forEach(function (v, k) { if (!best || v > best.v) best = { k: k, v: v }; });
    return { id: 'top-tool', title: 'Top model this week',
      body: best.k + ' drove ' + fmt$(best.v) + ' over the last 7 days.' };
  }

  function ruleComparePeriod(events) {
    if (!events.length) return null;
    var now = Date.now();
    var w = 7 * 86400000;
    var cur = 0, prev = 0;
    for (var i = 0; i < events.length; i++) {
      var e = events[i], t = +e.ts;
      if (t >= now - w) cur += e.cost;
      else if (t >= now - 2 * w && t < now - w) prev += e.cost;
    }
    if (prev === 0 && cur === 0) return null;
    var delta = prev === 0 ? 100 : Math.round(((cur - prev) / prev) * 100);
    var dir = delta >= 0 ? 'up' : 'down';
    return { id: 'compare', title: 'Compare to last period',
      body: 'Last 7d: ' + fmt$(cur) + ' (' + (delta >= 0 ? '+' : '') + delta + '% ' + dir + ' vs prior 7d ' + fmt$(prev) + ').' };
  }

  function ruleBurnReassurance(events) {
    if (!window.ClaudeMeter || !window.ClaudeMeter.pill) return null;
    var pill = document.getElementById('heroPill');
    var s = pill && pill.dataset && pill.dataset.sentence;
    if (!s) return null;
    return { id: 'burn-reassurance', title: 'Burn-rate check', body: s };
  }

  function compute() {
    var events = getEvents();
    var cards = [];
    [ruleBiggestDay, ruleCacheWaste, ruleExpensiveHour, ruleTopTool, ruleComparePeriod, ruleBurnReassurance].forEach(function (rule) {
      try { var c = rule(events); if (c) cards.push(c); } catch (e) { console.error('[insight]', e); }
    });
    // Surface pinned first
    var pin = null;
    try { pin = localStorage.getItem(PIN_KEY); } catch (_) {}
    if (pin) {
      var idx = cards.findIndex(function (c) { return c.id === pin; });
      if (idx > 0) { var x = cards.splice(idx, 1)[0]; cards.unshift(x); }
    }
    return cards.slice(0, 6);
  }

  var idx = 0;
  function render() {
    var host = document.getElementById('heroInsights');
    if (!host) return;
    var cards = compute();
    if (!cards.length) { host.innerHTML = '<div class="hero-empty muted">No insights yet — drop data or try demo.</div>'; return; }
    if (idx >= cards.length) idx = 0;
    var c = cards[idx];
    var pin = null; try { pin = localStorage.getItem(PIN_KEY); } catch (_) {}
    host.innerHTML = '';
    var row = document.createElement('div'); row.className = 'hi-row';
    var prev = document.createElement('button'); prev.type = 'button'; prev.className = 'hi-nav'; prev.textContent = '‹';
    prev.onclick = function () { idx = (idx - 1 + cards.length) % cards.length; render(); };
    var next = document.createElement('button'); next.type = 'button'; next.className = 'hi-nav'; next.textContent = '›';
    next.onclick = function () { idx = (idx + 1) % cards.length; render(); };
    var body = document.createElement('div'); body.className = 'hi-card';
    body.innerHTML = '<div class="hi-title">' + esc(c.title) + '</div><div class="hi-body">' + esc(c.body) + '</div>';
    var pinBtn = document.createElement('button'); pinBtn.type = 'button'; pinBtn.className = 'hi-pin';
    pinBtn.textContent = pin === c.id ? '★' : '☆';
    pinBtn.title = 'Pin this insight';
    pinBtn.onclick = function () {
      try {
        if (pin === c.id) localStorage.removeItem(PIN_KEY);
        else localStorage.setItem(PIN_KEY, c.id);
      } catch (_) {}
      render();
    };
    body.appendChild(pinBtn);
    row.appendChild(prev); row.appendChild(body); row.appendChild(next);
    host.appendChild(row);
    var dots = document.createElement('div'); dots.className = 'hi-dots';
    for (var i = 0; i < cards.length; i++) {
      var dot = document.createElement('span'); dot.className = 'hi-dot' + (i === idx ? ' on' : '');
      (function (j) { dot.onclick = function () { idx = j; render(); }; })(i);
      dots.appendChild(dot);
    }
    host.appendChild(dots);
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  window.ClaudeMeter.insights = { render: render, compute: compute };
})();
