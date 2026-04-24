/*
 * hero-pill.js — Insurance hero pill.
 * Given current-month usage + plan budget + day-of-month elapsed, produces:
 *   { status: 'green'|'yellow'|'red', sentence: string, pct: number }
 * Status thresholds (projected % of plan by month end):
 *   <60%  green, 60-90% yellow, >90% red
 * Public API: window.ClaudeMeter.pill.render(data?)
 *   data = { mCost, plan, dayOfMonth, daysInMonth }; if omitted reads from STATE.
 */
(function () {
  window.ClaudeMeter = window.ClaudeMeter || {};

  function computeStatus(mCost, plan, dayOfMonth, daysInMonth) {
    if (!plan || plan <= 0) return { status: 'green', pct: 0, projected: 0, sentence: 'No plan selected — tracking API-equivalent spend only.' };
    var dayFrac = Math.max(1, dayOfMonth) / daysInMonth;
    var projected = mCost / dayFrac;              // linear extrapolation
    var pct = Math.round((projected / plan) * 100);
    var status = pct < 60 ? 'green' : pct <= 90 ? 'yellow' : 'red';
    var planLabel = planName(plan);
    var sentence;
    if (status === 'green') sentence = "You're on track to use " + pct + '% of ' + planLabel + ' this month — keep coding.';
    else if (status === 'yellow') sentence = "You're tracking to " + pct + '% of ' + planLabel + ' — watch your pace.';
    else sentence = "At this rate you'll hit " + pct + '% of ' + planLabel + ' — consider easing off or upgrading.';
    return { status: status, pct: pct, projected: projected, sentence: sentence };
  }

  function planName(plan) {
    if (plan === 20) return 'Pro';
    if (plan === 100) return 'Max5';
    if (plan === 200) return 'Max20';
    return '$' + plan + '/mo';
  }

  function getData() {
    var events = (window.STATE && window.STATE.events) || [];
    var now = new Date();
    var mStart = new Date(now.getFullYear(), now.getMonth(), 1);
    var mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    var mCost = 0;
    var filters = window.ClaudeMeter && window.ClaudeMeter.filterBar && window.ClaudeMeter.filterBar.getFilters();
    var filtered = window.ClaudeMeter && window.ClaudeMeter.filterBar ? window.ClaudeMeter.filterBar.applyFilters(events) : events;
    for (var i = 0; i < filtered.length; i++) {
      if (filtered[i].ts >= mStart) mCost += filtered[i].cost;
    }
    var planSel = document.getElementById('plan');
    var plan = planSel ? parseFloat(planSel.value) || 0 : 0;
    return {
      mCost: mCost,
      plan: plan,
      dayOfMonth: now.getDate(),
      daysInMonth: mEnd.getDate(),
    };
  }

  function render(data) {
    var el = document.getElementById('heroPill');
    if (!el) return;
    var d = data || getData();
    var r = computeStatus(d.mCost, d.plan, d.dayOfMonth, d.daysInMonth);
    el.className = 'hero-pill ' + r.status;
    el.innerHTML = '<span class="hero-dot"></span><span class="hero-sentence">' + escapeHtml(r.sentence) + '</span>';
    el.dataset.sentence = r.sentence;

    // Right-click → copy sentence
    el.oncontextmenu = function (e) {
      e.preventDefault();
      try {
        navigator.clipboard.writeText(r.sentence);
        var flash = document.createElement('div');
        flash.textContent = 'Copied';
        flash.className = 'hero-flash';
        el.appendChild(flash);
        setTimeout(function () { flash.remove(); }, 1200);
      } catch (_) {}
    };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  window.ClaudeMeter.pill = { render: render, computeStatus: computeStatus };
})();
