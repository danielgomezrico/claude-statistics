/*
 * drift-diff.js — A25 Drift Diff Report (Wave 3 / F23).
 *
 * "How did Anthropic's pricing change affect me, and can I prove it?"
 *
 * Re-costs the same usage under each pricing regime in the bundled
 * pricing-changelog.json + shows month-over-month diff with pricing-event
 * annotations + reversal calc + signed hash for tamper-evidence.
 *
 * Public API (window.ClaudeMeter.driftDiff):
 *   load()              -> Promise<changelog> (cached)
 *   open(monthKey)      -> open drawer at YYYY-MM (default: most recent month)
 *   close()
 *   computeMonthly(events, changelog) -> { months, regimes, totalsByRegime }
 *   signHash(events, changelog) -> Promise<string>  (sha256 hex)
 */
(function () {
  window.ClaudeMeter = window.ClaudeMeter || {};

  var CHANGELOG_URL = 'src/data/pricing-changelog.json';
  var _changelog = null;
  var _chart = null;
  var _root = null;
  var _open = false;

  function fmtMoney(n) {
    var v = +n || 0;
    var sign = v < 0 ? '-' : '';
    var abs = Math.abs(v);
    return sign + '$' + abs.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  }

  function fmtPct(n) {
    if (!isFinite(n)) return '—';
    var sign = n > 0 ? '+' : '';
    return sign + (n * 100).toFixed(1) + '%';
  }

  function load() {
    if (_changelog) return Promise.resolve(_changelog);
    return fetch(CHANGELOG_URL, { cache: 'force-cache' })
      .then(function (r) { if (!r.ok) throw new Error('changelog ' + r.status); return r.json(); })
      .then(function (j) { _changelog = j; return j; })
      .catch(function (e) {
        console.warn('[drift-diff] changelog load failed:', e);
        _changelog = { schema: 1, regimes: [] };
        return _changelog;
      });
  }

  /**
   * Pick the regime in effect at event-time for an event's model.
   * Falls back to highest-priority match (longest prefix match) on date <= event.
   */
  function regimeFor(regimes, model, eventDate) {
    var m = (model || '').toLowerCase();
    var bestActive = null;
    var bestActiveLen = -1;
    var fallback = null;
    for (var i = 0; i < regimes.length; i++) {
      var r = regimes[i];
      var active = !r.effective || new Date(r.effective) <= eventDate;
      var matches = r.match ? m.indexOf(r.match) >= 0 : false;
      if (matches && active && r.match.length > bestActiveLen) {
        bestActive = r; bestActiveLen = r.match.length;
      }
      if (!r.match) fallback = r; // default catch-all
    }
    return bestActive || fallback || null;
  }

  /**
   * Re-cost a single event under a specific regime row.
   */
  function costUnder(ev, regime) {
    if (!regime) return 0;
    return (ev.inTok * regime.input
          + ev.outTok * regime.output
          + ev.crTok * (regime.cacheRead || 0)
          + ev.cwTok * (regime.cacheWrite || 0)) / 1e6;
  }

  /**
   * Bucket events into YYYY-MM keys. Returns:
   *   months: ["2024-06", ...] sorted
   *   underCurrent: { month -> total $ at time-of-event regime }
   *   underReverted: { month -> total $ if previous regime stayed in effect }
   *   pricingEventsByMonth: { month -> [regime,...] effective in that month }
   */
  function computeMonthly(events, changelog) {
    var regimes = (changelog && changelog.regimes) || [];
    // For reversal: compute "what if Anthropic had kept the previous regime?"
    // i.e. for each event, find the regime that was in effect *before* the
    // current one (same model match, latest effective < current).
    function previousRegime(model, eventDate) {
      var current = regimeFor(regimes, model, eventDate);
      if (!current || !current.match) return current;
      var bestPrev = null, bestPrevDate = null;
      for (var i = 0; i < regimes.length; i++) {
        var r = regimes[i];
        if (!r.match || r.match !== current.match) continue;
        if (!r.effective) continue;
        var rd = new Date(r.effective);
        if (rd >= eventDate) continue;
        if (rd >= new Date(current.effective || 0)) continue;
        if (!bestPrevDate || rd > bestPrevDate) { bestPrev = r; bestPrevDate = rd; }
      }
      return bestPrev || current; // if no prior, current itself
    }

    var byMonth = {};
    var monthsSet = {};
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      var d = e.ts instanceof Date ? e.ts : new Date(e.ts);
      if (isNaN(+d)) continue;
      var key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      monthsSet[key] = true;
      var bucket = byMonth[key] = byMonth[key] || { current: 0, reverted: 0, msgs: 0 };
      var rCur = regimeFor(regimes, e.model, d);
      var rPrev = previousRegime(e.model, d);
      bucket.current += costUnder(e, rCur);
      bucket.reverted += costUnder(e, rPrev);
      bucket.msgs++;
    }
    var months = Object.keys(monthsSet).sort();

    // Regime cumulative series — for each regime, replay all events under that
    // pricing as if it had always been in effect. This drives the "lines per
    // regime" chart. Limit to top-N most-relevant regimes (those that match at
    // least one event) so the chart stays readable.
    var relevantRegimes = [];
    var relevantSet = {};
    for (var j = 0; j < events.length; j++) {
      var ed = events[j].ts instanceof Date ? events[j].ts : new Date(events[j].ts);
      var rg = regimeFor(regimes, events[j].model, ed);
      if (rg && rg.id && !relevantSet[rg.id]) {
        relevantSet[rg.id] = true;
        relevantRegimes.push(rg);
      }
    }

    var totalsByRegime = relevantRegimes.map(function (r) {
      var perMonth = {};
      months.forEach(function (m) { perMonth[m] = 0; });
      for (var k = 0; k < events.length; k++) {
        var ev = events[k];
        // Only re-cost events whose model would match this regime's match string
        var lo = (ev.model || '').toLowerCase();
        if (r.match && lo.indexOf(r.match) < 0) continue;
        var dd = ev.ts instanceof Date ? ev.ts : new Date(ev.ts);
        var mk = dd.getFullYear() + '-' + String(dd.getMonth() + 1).padStart(2, '0');
        if (perMonth[mk] === undefined) continue;
        perMonth[mk] += costUnder(ev, r);
      }
      // Cumulative
      var cum = 0;
      var series = months.map(function (m) { cum += perMonth[m]; return { m: m, v: cum }; });
      return { regime: r, perMonth: perMonth, series: series };
    });

    // Pricing-events that fall inside the analyzed range
    var pricingEventsByMonth = {};
    if (months.length) {
      var first = months[0], last = months[months.length - 1];
      regimes.forEach(function (r) {
        if (!r.effective) return;
        var d = new Date(r.effective);
        var mk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        if (mk >= first && mk <= last) {
          (pricingEventsByMonth[mk] = pricingEventsByMonth[mk] || []).push(r);
        }
      });
    }

    return {
      months: months,
      byMonth: byMonth,
      totalsByRegime: totalsByRegime,
      pricingEventsByMonth: pricingEventsByMonth,
    };
  }

  // sha256 over input — uses subtle.crypto if present, else fallback to a
  // tiny synchronous FNV-1a (clearly labeled as non-cryptographic in UI).
  function signHash(events, changelog) {
    var summary = {
      n: events.length,
      first: events.length ? (new Date(events[0].ts)).toISOString() : null,
      last: events.length ? (new Date(events[events.length - 1].ts)).toISOString() : null,
      inTok: events.reduce(function (s, e) { return s + (e.inTok || 0); }, 0),
      outTok: events.reduce(function (s, e) { return s + (e.outTok || 0); }, 0),
      crTok: events.reduce(function (s, e) { return s + (e.crTok || 0); }, 0),
      cwTok: events.reduce(function (s, e) { return s + (e.cwTok || 0); }, 0),
      changelog: (changelog && changelog.regimes ? changelog.regimes.map(function (r) { return r.id + '@' + r.effective; }).join('|') : ''),
    };
    var json = JSON.stringify(summary);
    if (window.crypto && window.crypto.subtle && window.TextEncoder) {
      var enc = new TextEncoder().encode(json);
      return window.crypto.subtle.digest('SHA-256', enc).then(function (buf) {
        var arr = Array.from(new Uint8Array(buf));
        return 'sha256:' + arr.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      });
    }
    // Fallback FNV-1a 32-bit (non-cryptographic) — at least changes when input changes.
    var h = 2166136261 >>> 0;
    for (var i = 0; i < json.length; i++) { h ^= json.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    return Promise.resolve('fnv1a:' + h.toString(16));
  }

  // -- DOM ----------------------------------------------------------------
  function ensureRoot() {
    if (_root) return _root;
    _root = document.getElementById('driftDrawer');
    if (_root) return _root;
    _root = document.createElement('div');
    _root.id = 'driftDrawer';
    _root.setAttribute('role', 'dialog');
    _root.setAttribute('aria-modal', 'true');
    _root.setAttribute('aria-label', 'Drift Diff Report');
    _root.innerHTML = '<div class="dd-shell">'
      + '<div class="dd-head">'
      + '<div><h2>Drift Diff Report</h2><div class="dd-sub">Re-costs the same usage under each pricing regime so you can compare what Anthropic charged vs. what they would have charged under prior rates. Bundled changelog only — verify before tax/audit use.</div></div>'
      + '<div class="dd-actions">'
      + '<button class="btn primary" id="ddPrint">Download signed PDF</button>'
      + '<button class="btn" id="ddShare">Copy share link</button>'
      + '<button class="btn-close" id="ddClose">Close</button>'
      + '</div>'
      + '</div>'
      + '<div class="dd-controls"><label style="margin:0">Month <select id="ddMonth"></select></label> <span id="ddEvents" class="dd-events"></span></div>'
      + '<div class="dd-grid">'
      + '<div class="dd-card"><h3>Cumulative cost — under each pricing regime</h3><canvas id="ddChart"></canvas></div>'
      + '<div class="dd-card"><h3>Reversal table — what if Anthropic reverted to previous rates?</h3><div id="ddTable"></div></div>'
      + '</div>'
      + '<div class="dd-hash" id="ddHash">computing signature…</div>'
      + '</div>';
    document.body.appendChild(_root);
    _root.querySelector('#ddClose').addEventListener('click', close);
    _root.querySelector('#ddPrint').addEventListener('click', function () { window.print(); });
    _root.querySelector('#ddShare').addEventListener('click', shareLink);
    _root.querySelector('#ddMonth').addEventListener('change', function (e) { renderMonth(e.target.value); });
    _root.addEventListener('click', function (e) { if (e.target === _root) close(); });
    document.addEventListener('keydown', function (e) {
      if (_open && e.key === 'Escape') close();
    });
    return _root;
  }

  function shareLink() {
    var month = _root && _root.querySelector('#ddMonth').value;
    var url = window.location.pathname + window.location.search + '#zone=drift' + (month ? '&date=' + month : '');
    if (navigator.clipboard) {
      navigator.clipboard.writeText(window.location.origin + url).then(function () {
        var btn = _root.querySelector('#ddShare'); if (!btn) return;
        var prev = btn.textContent; btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = prev; }, 1500);
      });
    } else {
      try { history.replaceState(null, '', url); } catch (e) {}
    }
  }

  function getEvents() {
    return (window.STATE && window.STATE.events) || [];
  }

  function renderMonth(monthKey) {
    var events = getEvents();
    if (!events.length) { console.warn('[drift-diff] no events to render'); return; }
    load().then(function (changelog) {
      var data = computeMonthly(events, changelog);
      if (!data.months.length) { _root.querySelector('#ddTable').innerHTML = '<div class="muted" style="font-size:12px">No monthly data.</div>'; return; }
      var sel = _root.querySelector('#ddMonth');
      if (sel.options.length !== data.months.length) {
        sel.innerHTML = '';
        data.months.forEach(function (m) {
          var o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o);
        });
      }
      var target = monthKey && data.months.indexOf(monthKey) >= 0 ? monthKey : data.months[data.months.length - 1];
      sel.value = target;

      // Pricing event pills for the target month
      var pe = _root.querySelector('#ddEvents');
      pe.innerHTML = '';
      var evs = data.pricingEventsByMonth[target] || [];
      if (evs.length) {
        evs.forEach(function (r) {
          var pill = document.createElement('span'); pill.className = 'dd-event-pill';
          pill.textContent = r.effective + ' · ' + r.id;
          pe.appendChild(pill);
        });
      } else {
        pe.innerHTML = '<span class="muted">No pricing events landed inside this month.</span>';
      }

      drawChart(data);
      drawTable(data, target);

      // Sign hash
      signHash(events, changelog).then(function (h) {
        var el = _root.querySelector('#ddHash');
        el.textContent = 'Tamper-evident signature: ' + h
          + '  ·  ' + events.length + ' events  ·  changelog ' + (changelog.regimes || []).length + ' regimes';
      });
    });
  }

  function drawChart(data) {
    var canvas = _root.querySelector('#ddChart');
    var ctx = canvas.getContext('2d');
    if (_chart) { try { _chart.destroy(); } catch (e) {} _chart = null; }
    var palette = ['#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7', '#a7afc2'];
    var datasets = data.totalsByRegime.slice(0, 8).map(function (g, i) {
      return {
        label: g.regime.id,
        data: g.series.map(function (p) { return p.v; }),
        borderColor: palette[i % palette.length],
        backgroundColor: palette[i % palette.length] + '22',
        tension: 0.25,
        pointRadius: 2,
        fill: false,
      };
    });
    if (typeof Chart === 'undefined') return;
    _chart = new Chart(ctx, {
      type: 'line',
      data: { labels: data.months, datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#a7afc2', font: { size: 11 } } },
          tooltip: { callbacks: { label: function (c) { return c.dataset.label + ': ' + fmtMoney(c.parsed.y); } } },
        },
        scales: {
          x: { ticks: { color: '#8a93a6' }, grid: { color: '#262b38' } },
          y: { ticks: { color: '#8a93a6', callback: function (v) { return '$' + v; } }, grid: { color: '#262b38' } },
        },
      },
    });
  }

  function drawTable(data, focusMonth) {
    var box = _root.querySelector('#ddTable');
    var rows = data.months.map(function (m) {
      var b = data.byMonth[m] || { current: 0, reverted: 0, msgs: 0 };
      var delta = b.current - b.reverted;
      var pct = b.reverted ? delta / b.reverted : 0;
      return { m: m, cur: b.current, rev: b.reverted, delta: delta, pct: pct, msgs: b.msgs, focus: m === focusMonth };
    });
    var html = '<table><thead><tr>'
      + '<th>Month</th><th class="num">Msgs</th>'
      + '<th class="num">As-billed</th><th class="num">If reverted</th><th class="num">Δ vs reverted</th><th class="num">Δ%</th>'
      + '</tr></thead><tbody>';
    rows.forEach(function (r) {
      var cls = r.delta > 0 ? 'delta-up' : r.delta < 0 ? 'delta-down' : '';
      html += '<tr' + (r.focus ? ' style="background:#0b0d12"' : '') + '>'
        + '<td>' + r.m + '</td>'
        + '<td class="num">' + r.msgs.toLocaleString() + '</td>'
        + '<td class="num">' + fmtMoney(r.cur) + '</td>'
        + '<td class="num">' + fmtMoney(r.rev) + '</td>'
        + '<td class="num ' + cls + '">' + (r.delta >= 0 ? '+' : '') + fmtMoney(r.delta).replace('-', '−') + '</td>'
        + '<td class="num ' + cls + '">' + fmtPct(r.pct) + '</td>'
        + '</tr>';
    });
    var totalCur = rows.reduce(function (s, r) { return s + r.cur; }, 0);
    var totalRev = rows.reduce(function (s, r) { return s + r.rev; }, 0);
    var totalDelta = totalCur - totalRev;
    html += '<tr style="font-weight:600;border-top:2px solid var(--border)">'
      + '<td>TOTAL</td><td class="num">' + rows.reduce(function (s, r) { return s + r.msgs; }, 0).toLocaleString() + '</td>'
      + '<td class="num">' + fmtMoney(totalCur) + '</td>'
      + '<td class="num">' + fmtMoney(totalRev) + '</td>'
      + '<td class="num">' + (totalDelta >= 0 ? '+' : '') + fmtMoney(totalDelta).replace('-', '−') + '</td>'
      + '<td class="num">' + fmtPct(totalRev ? totalDelta / totalRev : 0) + '</td>'
      + '</tr>';
    html += '</tbody></table>';
    box.innerHTML = html;
  }

  function open(monthKey) {
    ensureRoot();
    _open = true;
    _root.classList.add('open');
    document.documentElement.style.overflow = 'hidden';
    renderMonth(monthKey);
  }
  function close() {
    if (!_root) return;
    _open = false;
    _root.classList.remove('open');
    document.documentElement.style.overflow = '';
    if (_chart) { try { _chart.destroy(); } catch (e) {} _chart = null; }
    // Strip drift hash if present.
    if (window.location.hash.indexOf('zone=drift') >= 0) {
      try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) {}
    }
  }

  // Wire URL hash: #zone=drift&date=YYYY-MM
  function checkHash() {
    var h = window.location.hash || '';
    if (h.indexOf('zone=drift') < 0) return;
    var m = /date=([0-9]{4}-[0-9]{2})/.exec(h);
    open(m && m[1]);
  }
  window.addEventListener('hashchange', checkHash);
  // Defer initial check until events are likely loaded.
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(checkHash, 200);
  });

  window.ClaudeMeter.driftDiff = {
    load: load,
    open: open,
    close: close,
    computeMonthly: computeMonthly,
    signHash: signHash,
  };
})();
