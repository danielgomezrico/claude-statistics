/*
 * hero-png.js — F16: 1200×630 share cards.
 *   exportHero()        → ROI headline + cumulative-vs-plan micro-chart.
 *   exportCumulative()  → snapshot of the Cumulative chart at 1200×630.
 * Both embed a tasteful bottom-right watermark (no external image fetches).
 * If window.ClaudeMeter.redact.export exists and indicates redact-on, labels
 * are scrubbed before render.
 */
(function () {
  window.ClaudeMeter = window.ClaudeMeter || {};

  var W = 1200, H = 630, DPR = 2;

  function mkCanvas() {
    var c = document.createElement('canvas');
    c.width = W * DPR; c.height = H * DPR;
    var ctx = c.getContext('2d');
    ctx.scale(DPR, DPR);
    return { canvas: c, ctx: ctx };
  }

  function themeColors() {
    // Read CSS vars from :root; fall back to dark defaults.
    var cs = getComputedStyle(document.documentElement);
    function v(n, d) { var x = cs.getPropertyValue(n).trim(); return x || d; }
    return {
      bg:      v('--bg',      '#0b0d12'),
      panel:   v('--panel',   '#12151c'),
      panel2:  v('--panel2',  '#171b24'),
      border:  v('--border',  '#262b38'),
      text:    v('--text',    '#e6e8ee'),
      muted:   v('--muted',   '#a7afc2'),
      accent:  v('--accent',  '#d97757'),
      accent2: v('--accent2', '#6ea8ff'),
      good:    v('--good',    '#22c55e'),
      warn:    v('--warn',    '#eab308'),
      bad:     v('--bad',     '#ef4444'),
    };
  }

  function redactOn() {
    var r = window.ClaudeMeter && window.ClaudeMeter.redact;
    if (!r) return false;
    try { return !!(r.export && r.export()); } catch (_) {}
    try { return !!r.isOn; } catch (_) {}
    return false;
  }

  function fmt$(n) { return '$' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 }); }

  function computeRoi() {
    var events = (window.STATE && window.STATE.events) || [];
    var filtered = window.ClaudeMeter && window.ClaudeMeter.filterBar ? window.ClaudeMeter.filterBar.applyFilters(events) : events;
    var now = new Date();
    var mStart = new Date(now.getFullYear(), now.getMonth(), 1);
    var mCost = 0;
    for (var i = 0; i < filtered.length; i++) {
      if (filtered[i].ts >= mStart) mCost += filtered[i].cost || 0;
    }
    var planSel = document.getElementById('plan');
    var plan = planSel ? parseFloat(planSel.value) || 0 : 0;
    var saved = Math.max(0, mCost - plan);
    return { mCost: mCost, plan: plan, saved: saved, planLabel: planName(plan) };
  }

  function planName(p) {
    if (p === 20) return 'Pro';
    if (p === 100) return 'Max 5×';
    if (p === 200) return 'Max 20×';
    return p ? '$' + p + '/mo' : 'API-only';
  }

  function cumulativeSeries() {
    var events = (window.STATE && window.STATE.events) || [];
    var filtered = window.ClaudeMeter && window.ClaudeMeter.filterBar ? window.ClaudeMeter.filterBar.applyFilters(events) : events;
    if (!filtered.length) return { cost: [], sub: [], labels: [] };
    var byDay = new Map();
    for (var i = 0; i < filtered.length; i++) {
      var d = new Date(filtered[i].ts); d.setHours(0,0,0,0);
      var k = d.getTime();
      byDay.set(k, (byDay.get(k) || 0) + (filtered[i].cost || 0));
    }
    var keys = Array.from(byDay.keys()).sort(function (a, b) { return a - b; });
    var planSel = document.getElementById('plan');
    var plan = planSel ? parseFloat(planSel.value) || 0 : 0;
    var perDay = plan / 30.4375;
    var cum = 0, cost = [], sub = [], labels = [];
    var firstTs = keys[0];
    for (var j = 0; j < keys.length; j++) {
      cum += byDay.get(keys[j]);
      cost.push(cum);
      var days = (keys[j] - firstTs) / 86400000 + 1;
      sub.push(plan ? perDay * days : 0);
      labels.push(new Date(keys[j]));
    }
    return { cost: cost, sub: sub, labels: labels };
  }

  function drawBackground(ctx, c) {
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);
    // Soft accent gradient block
    var g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, c.accent + '22');
    g.addColorStop(1, c.accent2 + '11');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function drawWatermark(ctx, c) {
    // Small chart-bar logo + text, bottom-right.
    var x0 = W - 360, y0 = H - 48;
    // Logo: 3 bars
    ctx.fillStyle = c.accent;
    ctx.fillRect(x0, y0 + 10, 6, 18);
    ctx.fillRect(x0 + 10, y0 + 4, 6, 24);
    ctx.fillRect(x0 + 20, y0 - 2, 6, 30);
    // Text
    ctx.fillStyle = c.muted;
    ctx.font = '500 16px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('claude-meter · github.com/danielgomezrico/claude-statistics', x0 + 34, y0 + 14);
  }

  function drawMicroChart(ctx, c, x, y, w, h, series) {
    // Axes panel
    ctx.fillStyle = c.panel;
    ctx.strokeStyle = c.border;
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 12);
    ctx.fill(); ctx.stroke();

    if (!series.cost.length) {
      ctx.fillStyle = c.muted;
      ctx.font = '14px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('No data yet', x + w / 2, y + h / 2);
      return;
    }
    var max = Math.max.apply(null, series.cost.concat(series.sub));
    if (max <= 0) max = 1;
    var n = series.cost.length;
    var pad = 14;

    function sx(i) { return x + pad + (i / Math.max(1, n - 1)) * (w - 2 * pad); }
    function sy(v) { return y + h - pad - (v / max) * (h - 2 * pad); }

    // Sub line
    ctx.strokeStyle = c.accent2;
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var px = sx(i), py = sy(series.sub[i]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Cost filled area
    var grd = ctx.createLinearGradient(0, y, 0, y + h);
    grd.addColorStop(0, c.accent + 'cc');
    grd.addColorStop(1, c.accent + '11');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.moveTo(sx(0), sy(0));
    for (var j = 0; j < n; j++) ctx.lineTo(sx(j), sy(series.cost[j]));
    ctx.lineTo(sx(n - 1), sy(0));
    ctx.closePath();
    ctx.fill();
    // Cost line
    ctx.strokeStyle = c.accent; ctx.lineWidth = 3;
    ctx.beginPath();
    for (var k = 0; k < n; k++) {
      var kx = sx(k), ky = sy(series.cost[k]);
      if (k === 0) ctx.moveTo(kx, ky); else ctx.lineTo(kx, ky);
    }
    ctx.stroke();

    // Legend
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = c.accent; ctx.fillRect(x + 12, y + 12, 14, 3);
    ctx.fillStyle = c.text; ctx.fillText('cumulative API-eq', x + 32, y + 6);
    ctx.fillStyle = c.accent2; ctx.fillRect(x + 12, y + 28, 14, 3);
    ctx.fillStyle = c.text; ctx.fillText('cumulative subscription', x + 32, y + 22);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function downloadCanvas(canvas, name) {
    if (canvas.toBlob) {
      canvas.toBlob(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click();
        setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
      }, 'image/png');
    } else {
      var a2 = document.createElement('a');
      a2.href = canvas.toDataURL('image/png'); a2.download = name;
      document.body.appendChild(a2); a2.click();
      setTimeout(function () { document.body.removeChild(a2); }, 100);
    }
  }

  function exportHero() {
    var c = themeColors();
    var m = mkCanvas();
    var ctx = m.ctx;
    drawBackground(ctx, c);

    var roi = computeRoi();
    var redacted = redactOn();

    // Title strip
    ctx.fillStyle = c.muted;
    ctx.font = '500 20px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(redacted ? 'Claude Meter' : 'Claude Meter · this month', 60, 60);

    // Headline
    ctx.fillStyle = c.text;
    ctx.font = '800 92px system-ui, -apple-system, sans-serif';
    var headline = roi.plan && roi.saved > 0
      ? fmt$(roi.saved) + ' saved vs API'
      : roi.plan
        ? fmt$(roi.mCost) + ' used of ' + fmt$(roi.plan) + ' plan'
        : fmt$(roi.mCost) + ' in API-equivalent spend';
    ctx.fillText(headline, 60, 100);

    // Support sentence
    ctx.fillStyle = c.muted;
    ctx.font = '400 22px system-ui, sans-serif';
    var sub = roi.plan && roi.saved > 0
      ? 'On your ' + roi.planLabel + ' plan — ran ' + fmt$(roi.mCost) + ' of API-equivalent cost, paid ' + fmt$(roi.plan) + '.'
      : roi.plan
        ? 'On your ' + roi.planLabel + ' plan — still within your subscription.'
        : 'No subscription — tracking API-equivalent cost only.';
    ctx.fillText(sub, 60, 210);

    // Micro-chart (cumulative vs plan)
    var series = cumulativeSeries();
    drawMicroChart(ctx, c, 60, 280, W - 120, 270, series);

    drawWatermark(ctx, c);

    var stamp = new Date().toISOString().slice(0, 10);
    downloadCanvas(m.canvas, 'claude-meter-hero-' + stamp + '.png');
  }

  function exportCumulative() {
    var c = themeColors();
    var m = mkCanvas();
    var ctx = m.ctx;
    drawBackground(ctx, c);

    ctx.fillStyle = c.muted;
    ctx.font = '500 20px system-ui, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('Cumulative spend vs subscription', 60, 50);

    var roi = computeRoi();
    ctx.fillStyle = c.text;
    ctx.font = '700 36px system-ui, sans-serif';
    var title = roi.plan
      ? fmt$(roi.mCost) + ' · ' + roi.planLabel + ' plan'
      : fmt$(roi.mCost) + ' API-equivalent this month';
    ctx.fillText(title, 60, 80);

    var series = cumulativeSeries();
    drawMicroChart(ctx, c, 60, 150, W - 120, H - 150 - 80, series);

    drawWatermark(ctx, c);

    var stamp = new Date().toISOString().slice(0, 10);
    downloadCanvas(m.canvas, 'claude-meter-cumulative-' + stamp + '.png');
  }

  window.ClaudeMeter.heroPng = {
    exportHero: exportHero,
    exportCumulative: exportCumulative,
  };
})();
