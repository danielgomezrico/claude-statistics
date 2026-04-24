/*
 * five-hour-anchor.js — F21: Priya beachhead. Claude Max plans enforce a
 * rolling 5-hour usage window; this anchor tells users where they are in
 * that window with a reassuring tone (never alarming).
 *
 * Thresholds mirror Wave 1 hero pill: <60% green, 60-90% yellow, >90% red.
 *
 * Public API: window.ClaudeMeter.fiveHourAnchor.render()
 */
(function () {
  window.ClaudeMeter = window.ClaudeMeter || {};

  var WINDOW_MS = 5 * 60 * 60 * 1000;

  // Rough per-window budget heuristics by plan (USD API-eq cost).
  // Not a contract — users can't see Anthropic's real caps; this gives a
  // visual anchor rather than a hard ceiling.
  function budgetForPlan(plan) {
    if (plan === 20)  return 4;    // Pro
    if (plan === 100) return 20;   // Max 5×
    if (plan === 200) return 40;   // Max 20×
    return 0;
  }

  function compute() {
    var events = (window.STATE && window.STATE.events) || [];
    var filtered = window.ClaudeMeter && window.ClaudeMeter.filterBar ? window.ClaudeMeter.filterBar.applyFilters(events) : events;
    var now = Date.now();
    var cutoff = now - WINDOW_MS;
    var cost = 0;
    var firstTs = null;
    for (var i = 0; i < filtered.length; i++) {
      var t = +filtered[i].ts;
      if (t >= cutoff && t <= now) {
        cost += filtered[i].cost || 0;
        if (firstTs == null || t < firstTs) firstTs = t;
      }
    }
    var planSel = document.getElementById('plan');
    var plan = planSel ? parseFloat(planSel.value) || 0 : 0;
    var budget = budgetForPlan(plan);
    // "Remaining" = time until the oldest in-window event ages out (when budget resets).
    // If no events in window, full 5h remain.
    var remainingMs = firstTs == null ? WINDOW_MS : Math.max(0, (firstTs + WINDOW_MS) - now);
    var pct = budget ? Math.min(999, Math.round((cost / budget) * 100)) : 0;
    var status = pct < 60 ? 'green' : pct <= 90 ? 'yellow' : 'red';
    return {
      cost: cost, budget: budget, pct: pct, status: status,
      remainingMs: remainingMs, plan: plan,
    };
  }

  function fmtMins(ms) {
    var m = Math.round(ms / 60000);
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return h + 'h ' + r + 'm';
  }

  function sentenceFor(d) {
    if (!d.plan || !d.budget) {
      return 'No plan selected — tracking your rolling 5-hour usage only.';
    }
    if (d.status === 'green') {
      return "You're using " + d.pct + '% of your 5-hour window · ' + fmtMins(d.remainingMs) + ' until it refreshes · $' + d.cost.toFixed(2) + ' so far.';
    }
    if (d.status === 'yellow') {
      return "5-hour window: " + d.pct + '% used · ' + fmtMins(d.remainingMs) + ' remaining · $' + d.cost.toFixed(2) + ' so far. Plenty of room to keep going.';
    }
    // red — still reassuring per persona Priya
    return "You're near the top of this 5-hour window (" + d.pct + '%) · ' + fmtMins(d.remainingMs) + ' until it refreshes · $' + d.cost.toFixed(2) + ' so far. Take a short break and you\'ll be back.';
  }

  function ensureMount() {
    var el = document.getElementById('fiveHourAnchor');
    if (!el) return null;
    if (el.dataset.built === '1') return el;
    el.dataset.built = '1';
    el.innerHTML =
      '<div class="fha-row">' +
        '<div class="fha-dot"></div>' +
        '<div class="fha-sentence muted">Loading 5-hour window…</div>' +
      '</div>' +
      '<div class="fha-bar"><div class="fha-fill"></div></div>';
    // Inline CSS (small, scoped) — avoids a new stylesheet.
    if (!document.getElementById('fhaStyle')) {
      var st = document.createElement('style'); st.id = 'fhaStyle';
      st.textContent =
        '#fiveHourAnchor{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin-bottom:12px}' +
        '#fiveHourAnchor .fha-row{display:flex;align-items:center;gap:10px}' +
        '#fiveHourAnchor .fha-dot{width:10px;height:10px;border-radius:999px;background:var(--muted);flex:0 0 10px}' +
        '#fiveHourAnchor.green .fha-dot{background:var(--good)}' +
        '#fiveHourAnchor.yellow .fha-dot{background:var(--warn)}' +
        '#fiveHourAnchor.red .fha-dot{background:var(--bad)}' +
        '#fiveHourAnchor .fha-sentence{font-size:13px;color:var(--text)}' +
        '#fiveHourAnchor .fha-bar{margin-top:8px;height:6px;background:var(--panel2);border-radius:999px;overflow:hidden;border:1px solid var(--border)}' +
        '#fiveHourAnchor .fha-fill{height:100%;width:0%;background:var(--good);transition:width .3s}' +
        '#fiveHourAnchor.yellow .fha-fill{background:var(--warn)}' +
        '#fiveHourAnchor.red .fha-fill{background:var(--bad)}';
      document.head.appendChild(st);
    }
    return el;
  }

  function render() {
    var el = ensureMount();
    if (!el) return;
    var d = compute();
    el.className = d.status;
    var sen = el.querySelector('.fha-sentence');
    var fill = el.querySelector('.fha-fill');
    if (sen) { sen.textContent = sentenceFor(d); sen.classList.remove('muted'); }
    if (fill) fill.style.width = Math.min(100, d.pct) + '%';
    el.title = 'Rolling 5-hour window · cost $' + d.cost.toFixed(2) + (d.budget ? ' of ~$' + d.budget.toFixed(0) + ' anchor' : '');
  }

  window.ClaudeMeter.fiveHourAnchor = { render: render, compute: compute };

  // Re-render every minute so "remaining" ticks down without needing user action.
  setInterval(function () {
    try { if (document.getElementById('fiveHourAnchor')) render(); } catch (_) {}
  }, 60000);
})();
