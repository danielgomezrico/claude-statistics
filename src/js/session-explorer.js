/*
 * session-explorer.js — A15: Virtualized session table in Zone F (Deep Dive).
 * Aggregates STATE.events -> one row per session. Renders ~25 visible rows,
 * recycling absolutely-positioned row <div>s for 100k+ session scalability.
 *
 * Virtualization math (must match .se-row height in CSS):
 *   ROW_H = 25px (row height incl. bottom border)
 *   startIdx = floor(scrollTop / ROW_H); endIdx = ceil((scrollTop + viewportH) / ROW_H)
 * Off-by-one in ROW_H vs CSS causes drift — keep in sync.
 *
 * Public API: window.ClaudeMeter.sessionExplorer = {
 *   render, openSession(id), getSessions, getSelection
 * }
 */
(function () {
  window.ClaudeMeter = window.ClaudeMeter || {};

  var ROW_H = 25; // px — must match .se-row total height in session-explorer.css
  var BUFFER = 6; // rows above/below viewport to render

  var state = {
    sessions: [],          // all aggregated sessions (unfiltered by chips)
    filteredSessions: [],  // after chips + search
    sort: { key: 'cost', dir: 'desc' },
    chips: {
      model: null,        // string or null
      project: null,
      branch: null,
      stopReason: null,
      hasError: false,
      sidechainOnly: false,
    },
    search: '',
    selected: new Set(),    // session ids
    lastClickIdx: -1,       // for shift-range select
  };

  function aggregate(events) {
    var byId = new Map();
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      var id = e.session || '—';
      if (!byId.has(id)) {
        byId.set(id, {
          id: id,
          tsFirst: +e.ts, tsLast: +e.ts,
          project: e.project || '—',
          branch: e.branch || e.gitBranch || '—',
          model: e.model || 'unknown',
          models: new Set(),
          tools: new Set(),
          stopReason: e.stopReason || e.stop_reason || '',
          cost: 0, msgs: 0,
          inTok: 0, outTok: 0, crTok: 0, cwTok: 0,
          hasError: false,
          sidechain: !!(e.isSidechain || e.sidechain),
          events: [],
        });
      }
      var s = byId.get(id);
      if (+e.ts < s.tsFirst) s.tsFirst = +e.ts;
      if (+e.ts > s.tsLast) s.tsLast = +e.ts;
      s.models.add(e.model);
      if (e.tool) s.tools.add(e.tool);
      if (Array.isArray(e.tools)) e.tools.forEach(function (t) { s.tools.add(t); });
      if (e.stopReason || e.stop_reason) s.stopReason = e.stopReason || e.stop_reason;
      s.cost += e.cost || 0;
      s.msgs++;
      s.inTok += e.inTok || 0;
      s.outTok += e.outTok || 0;
      s.crTok += e.crTok || 0;
      s.cwTok += e.cwTok || 0;
      if (e.error || e.isError) s.hasError = true;
      if (e.isSidechain || e.sidechain) s.sidechain = true;
      s.events.push(e);
    }
    var arr = [];
    byId.forEach(function (s) {
      s.durationMs = Math.max(0, s.tsLast - s.tsFirst);
      var totalIn = s.inTok + s.crTok;
      s.cacheHitPct = totalIn > 0 ? (s.crTok / totalIn) * 100 : 0;
      s.modelLabel = s.models.size > 1 ? (s.models.size + ' models') : s.model;
      s.toolsLabel = s.tools.size ? s.tools.size + ' tools' : '—';
      arr.push(s);
    });
    return arr;
  }

  function applyChipsAndSearch(sessions) {
    var c = state.chips;
    var q = state.search.trim().toLowerCase();
    return sessions.filter(function (s) {
      if (c.model && s.model !== c.model && !s.models.has(c.model)) return false;
      if (c.project && s.project !== c.project) return false;
      if (c.branch && s.branch !== c.branch) return false;
      if (c.stopReason && s.stopReason !== c.stopReason) return false;
      if (c.hasError && !s.hasError) return false;
      if (c.sidechainOnly && !s.sidechain) return false;
      if (q) {
        var hay = (s.id + ' ' + s.project + ' ' + s.branch + ' ' + s.model + ' ' + s.stopReason).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function sortRows() {
    var k = state.sort.key, dir = state.sort.dir === 'asc' ? 1 : -1;
    state.filteredSessions.sort(function (a, b) {
      var av, bv;
      switch (k) {
        case 'time': av = a.tsLast; bv = b.tsLast; break;
        case 'project': av = a.project; bv = b.project; break;
        case 'branch': av = a.branch; bv = b.branch; break;
        case 'model': av = a.model; bv = b.model; break;
        case 'duration': av = a.durationMs; bv = b.durationMs; break;
        case 'tools': av = a.tools.size; bv = b.tools.size; break;
        case 'stopReason': av = a.stopReason; bv = b.stopReason; break;
        case 'cost': av = a.cost; bv = b.cost; break;
        case 'cacheHit': av = a.cacheHitPct; bv = b.cacheHitPct; break;
        case 'tokens': av = a.inTok + a.outTok; bv = b.inTok + b.outTok; break;
        case 'sidechain': av = a.sidechain ? 1 : 0; bv = b.sidechain ? 1 : 0; break;
        default: av = a.cost; bv = b.cost;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  function fmt$(n) { return '$' + (n || 0).toFixed(2); }
  function fmtPct(n) { return (n || 0).toFixed(0) + '%'; }
  function fmtTok(n) { if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'; return String(n || 0); }
  function fmtDur(ms) {
    if (ms < 60000) return Math.round(ms / 1000) + 's';
    if (ms < 3600000) return Math.round(ms / 60000) + 'm';
    return (ms / 3600000).toFixed(1) + 'h';
  }
  function fmtTime(ts) {
    var d = new Date(ts);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var els = {};
  var pool = []; // recycled row DOMs
  var currentRange = { start: -1, end: -1 };

  function buildToolbar(container) {
    container.innerHTML =
      '<div class="se-toolbar">' +
        '<input type="text" class="se-search" placeholder="Search sessions (press / to focus)" id="seSearch" />' +
        '<div class="se-chips" id="seChips"></div>' +
        '<button type="button" class="btn" id="seExportJson" style="font-size:11px;padding:4px 10px">Export selection JSON</button>' +
        '<button type="button" class="btn" id="seExportCsv" style="font-size:11px;padding:4px 10px">Export selection CSV</button>' +
        '<div class="se-meta" id="seMeta"></div>' +
      '</div>' +
      '<div class="se-table-wrap">' +
        '<div class="se-thead" id="seThead"></div>' +
        '<div class="se-viewport" id="seViewport">' +
          '<div class="se-spacer" id="seSpacer"></div>' +
        '</div>' +
      '</div>';
    els.search = container.querySelector('#seSearch');
    els.chips = container.querySelector('#seChips');
    els.thead = container.querySelector('#seThead');
    els.viewport = container.querySelector('#seViewport');
    els.spacer = container.querySelector('#seSpacer');
    els.meta = container.querySelector('#seMeta');
    els.exportJson = container.querySelector('#seExportJson');
    els.exportCsv = container.querySelector('#seExportCsv');

    els.search.addEventListener('input', function () {
      state.search = els.search.value || '';
      refilter();
    });
    els.exportJson.addEventListener('click', function () { exportSelection('json'); });
    els.exportCsv.addEventListener('click', function () { exportSelection('csv'); });

    renderHeader();
    renderChips();
    els.viewport.addEventListener('scroll', draw);
  }

  var COLUMNS = [
    { k: 'time',      label: 'Time' },
    { k: 'project',   label: 'Project' },
    { k: 'branch',    label: 'Branch' },
    { k: 'model',     label: 'Model' },
    { k: 'duration',  label: 'Dur', cls: 'num' },
    { k: 'tools',     label: 'Tools', cls: 'num' },
    { k: 'stopReason',label: 'Stop' },
    { k: 'cost',      label: 'Cost', cls: 'num' },
    { k: 'cacheHit',  label: 'Cache%', cls: 'num' },
    { k: 'tokens',    label: 'In/Out', cls: 'num' },
    { k: 'sidechain', label: 'SC', cls: 'num' },
    { k: 'link',      label: '→', cls: 'num' },
  ];

  function renderHeader() {
    if (!els.thead) return;
    els.thead.innerHTML = '';
    COLUMNS.forEach(function (c) {
      var d = document.createElement('div');
      d.className = c.cls || '';
      d.textContent = c.label;
      if (c.k !== 'link') {
        d.addEventListener('click', function () {
          if (state.sort.key === c.k) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
          else { state.sort.key = c.k; state.sort.dir = c.k === 'time' || c.k === 'cost' || c.k === 'duration' || c.k === 'tokens' ? 'desc' : 'asc'; }
          sortRows(); draw(); renderHeader();
        });
      }
      if (c.k === state.sort.key) {
        var caret = document.createElement('span');
        caret.className = 'caret';
        caret.textContent = state.sort.dir === 'asc' ? '▲' : '▼';
        d.appendChild(caret);
      }
      els.thead.appendChild(d);
    });
  }

  function renderChips() {
    if (!els.chips) return;
    var c = state.chips;
    var mkOpts = function (key) {
      var vals = new Set();
      state.sessions.forEach(function (s) {
        if (key === 'model') s.models.forEach(function (m) { vals.add(m); });
        else if (s[key]) vals.add(s[key]);
      });
      return ['', Array.from(vals).sort()].flat();
    };
    var mkSel = function (key, label, cur) {
      var opts = mkOpts(key);
      var html = '<div class="se-chip-group"><label>' + label + '</label><select data-key="' + key + '">';
      opts.forEach(function (v) {
        html += '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + (v === '' ? 'any' : esc(v)) + '</option>';
      });
      html += '</select></div>';
      return html;
    };
    els.chips.innerHTML =
      mkSel('model', 'model', c.model) +
      mkSel('project', 'project', c.project) +
      mkSel('branch', 'branch', c.branch) +
      mkSel('stopReason', 'stop', c.stopReason) +
      '<div class="se-chip ' + (c.hasError ? 'on' : '') + '" data-toggle="hasError">has-error</div>' +
      '<div class="se-chip ' + (c.sidechainOnly ? 'on' : '') + '" data-toggle="sidechainOnly">sidechain only</div>';
    els.chips.querySelectorAll('select').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var k = sel.dataset.key;
        state.chips[k] = sel.value || null;
        refilter();
      });
    });
    els.chips.querySelectorAll('[data-toggle]').forEach(function (el) {
      el.addEventListener('click', function () {
        var k = el.dataset.toggle;
        state.chips[k] = !state.chips[k];
        el.classList.toggle('on', state.chips[k]);
        refilter();
      });
    });
  }

  function refilter() {
    state.filteredSessions = applyChipsAndSearch(state.sessions);
    sortRows();
    draw();
    if (els.meta) els.meta.textContent = state.filteredSessions.length + ' of ' + state.sessions.length + ' sessions';
  }

  function draw() {
    if (!els.viewport || !els.spacer) return;
    var rows = state.filteredSessions;
    var total = rows.length * ROW_H;
    els.spacer.style.height = total + 'px';
    if (!rows.length) {
      poolHideAll();
      els.spacer.innerHTML = '<div class="se-empty">No sessions match these filters.</div>';
      return;
    }
    // Make sure the empty-state child doesn't persist
    if (els.spacer.querySelector('.se-empty')) {
      var emp = els.spacer.querySelector('.se-empty'); if (emp) emp.remove();
    }
    var scrollTop = els.viewport.scrollTop;
    var viewH = els.viewport.clientHeight || 560;
    var startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER);
    var endIdx = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + BUFFER);
    var count = endIdx - startIdx;

    // grow pool
    while (pool.length < count) {
      var el = document.createElement('div');
      el.className = 'se-row';
      els.spacer.appendChild(el);
      pool.push(el);
    }
    // hide surplus
    for (var p = count; p < pool.length; p++) pool[p].style.display = 'none';

    for (var i = 0; i < count; i++) {
      var idx = startIdx + i;
      var row = rows[idx];
      var el2 = pool[i];
      el2.style.display = '';
      el2.style.transform = 'translateY(' + (idx * ROW_H) + 'px)';
      el2.dataset.id = row.id;
      el2.dataset.idx = String(idx);
      el2.classList.toggle('selected', state.selected.has(row.id));
      el2.innerHTML = rowHtml(row);
      bindRowEvents(el2);
    }
    currentRange.start = startIdx; currentRange.end = endIdx;
  }

  function poolHideAll() { for (var i = 0; i < pool.length; i++) pool[i].style.display = 'none'; }

  function rowHtml(s) {
    return '' +
      '<div title="' + esc(fmtTime(s.tsLast)) + '">' + esc(fmtTime(s.tsLast)) + '</div>' +
      '<div title="' + esc(s.project) + '">' + esc(s.project) + '</div>' +
      '<div title="' + esc(s.branch) + '">' + esc(s.branch) + '</div>' +
      '<div title="' + esc(s.modelLabel) + '">' + esc(s.modelLabel) + '</div>' +
      '<div class="num">' + fmtDur(s.durationMs) + '</div>' +
      '<div class="num">' + s.tools.size + '</div>' +
      '<div class="' + (s.hasError ? 'err' : '') + '" title="' + esc(s.stopReason) + '">' + esc(s.stopReason || '—') + '</div>' +
      '<div class="num">' + fmt$(s.cost) + '</div>' +
      '<div class="num">' + fmtPct(s.cacheHitPct) + '</div>' +
      '<div class="num">' + fmtTok(s.inTok) + '/' + fmtTok(s.outTok) + '</div>' +
      '<div class="num">' + (s.sidechain ? 'Y' : '') + '</div>' +
      '<div class="link num" data-action="open">open</div>';
  }

  function bindRowEvents(el) {
    el.onclick = function (ev) {
      var id = el.dataset.id;
      var idx = parseInt(el.dataset.idx, 10);
      if (ev.target && ev.target.dataset && ev.target.dataset.action === 'open') {
        ev.stopPropagation();
        openDrawer(id);
        return;
      }
      if (ev.shiftKey && state.lastClickIdx >= 0) {
        var a = Math.min(state.lastClickIdx, idx);
        var b = Math.max(state.lastClickIdx, idx);
        for (var i = a; i <= b; i++) state.selected.add(state.filteredSessions[i].id);
      } else if (ev.metaKey || ev.ctrlKey) {
        if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
        state.lastClickIdx = idx;
      } else {
        state.selected.clear();
        state.selected.add(id);
        state.lastClickIdx = idx;
      }
      draw();
    };
  }

  // --- Drawer ---
  var drawer, backdrop;
  function ensureDrawer() {
    if (drawer) return;
    backdrop = document.createElement('div'); backdrop.className = 'se-backdrop';
    drawer = document.createElement('aside'); drawer.className = 'se-drawer';
    drawer.innerHTML = '<div class="se-drawer-head"><h3>Session</h3><button type="button" class="btn" id="seDrawerClose">Close</button></div><div class="se-drawer-body" id="seDrawerBody"></div>';
    document.body.appendChild(backdrop); document.body.appendChild(drawer);
    backdrop.addEventListener('click', closeDrawer);
    drawer.querySelector('#seDrawerClose').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
  }
  function openDrawer(id) {
    ensureDrawer();
    var s = state.sessions.find(function (x) { return x.id === id; });
    if (!s) return;
    var body = drawer.querySelector('#seDrawerBody');
    var evs = s.events.slice().sort(function (a, b) { return +a.ts - +b.ts; });
    var rowsHtml = '';
    for (var i = 0; i < evs.length && i < 500; i++) {
      var e = evs[i];
      rowsHtml += '<tr><td>' + esc(new Date(e.ts).toLocaleString()) + '</td><td>' + esc(e.model || '') + '</td><td class="num">' + fmtTok(e.inTok) + '</td><td class="num">' + fmtTok(e.outTok) + '</td><td class="num">' + fmt$(e.cost || 0) + '</td></tr>';
    }
    body.innerHTML =
      '<div style="margin-bottom:10px">' +
        '<div><strong>' + esc(s.id) + '</strong></div>' +
        '<div class="muted">' + esc(s.project) + ' · ' + esc(s.branch) + '</div>' +
        '<div style="margin-top:6px">cost ' + fmt$(s.cost) + ' · msgs ' + s.msgs + ' · dur ' + fmtDur(s.durationMs) + ' · cache ' + fmtPct(s.cacheHitPct) + (s.hasError ? ' · <span class="err">has-error</span>' : '') + (s.sidechain ? ' · sidechain' : '') + '</div>' +
      '</div>' +
      '<table><thead><tr><th>Time</th><th>Model</th><th class="num">In</th><th class="num">Out</th><th class="num">Cost</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>' +
      (evs.length > 500 ? '<div class="muted" style="margin-top:8px;font-size:11px">Showing first 500 of ' + evs.length + ' events.</div>' : '');
    backdrop.classList.add('show');
    drawer.classList.add('open');
  }
  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.remove('open');
    backdrop.classList.remove('show');
  }

  // --- Export ---
  function exportSelection(format) {
    var picked = state.selected.size
      ? state.filteredSessions.filter(function (s) { return state.selected.has(s.id); })
      : state.filteredSessions;
    if (!picked.length) { alert('No sessions selected or visible.'); return; }

    // Collect underlying events per selected session
    var rows = [];
    picked.forEach(function (s) { s.events.forEach(function (e) { rows.push(e); }); });

    if (window.ClaudeMeter.csvExport && typeof window.ClaudeMeter.csvExport.downloadSelection === 'function') {
      try { window.ClaudeMeter.csvExport.downloadSelection(rows, format); return; } catch (_) {}
    }

    // Local fallback
    var blob, name;
    var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    if (format === 'json') {
      blob = new Blob([JSON.stringify(picked.map(sessionToJson), null, 2)], { type: 'application/json' });
      name = 'claude-sessions-' + stamp + '.json';
    } else {
      var lines = ['timestamp_iso,session,project,model,in_tokens,out_tokens,cache_read_tokens,cache_write_tokens,cost_usd'];
      rows.forEach(function (e) {
        lines.push([
          new Date(e.ts).toISOString(),
          csvEsc(e.session), csvEsc(e.project), csvEsc(e.model),
          e.inTok || 0, e.outTok || 0, e.crTok || 0, e.cwTok || 0,
          (e.cost || 0).toFixed(6)
        ].join(','));
      });
      blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      name = 'claude-sessions-' + stamp + '.csv';
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }
  function sessionToJson(s) {
    return {
      id: s.id, project: s.project, branch: s.branch,
      model: s.model, models: Array.from(s.models),
      first: new Date(s.tsFirst).toISOString(),
      last: new Date(s.tsLast).toISOString(),
      durationMs: s.durationMs,
      msgs: s.msgs, cost: s.cost,
      inTok: s.inTok, outTok: s.outTok, crTok: s.crTok, cwTok: s.cwTok,
      cacheHitPct: s.cacheHitPct,
      stopReason: s.stopReason,
      hasError: s.hasError, sidechain: s.sidechain,
      tools: Array.from(s.tools),
    };
  }
  function csvEsc(s) { if (s == null) return ''; s = String(s); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

  // --- Public entry points ---
  function render() {
    var root = document.getElementById('sessionExplorer');
    if (!root) return;
    if (!els.search) buildToolbar(root);
    var events = (window.STATE && window.STATE.events) || [];
    if (window.ClaudeMeter.filterBar) events = window.ClaudeMeter.filterBar.applyFilters(events);
    state.sessions = aggregate(events);
    // Re-render chip options since projects/models may have changed
    renderChips();
    refilter();
  }

  function openSession(id) {
    var zone = document.getElementById('zoneF');
    if (zone) { zone.open = true; zone.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    render();
    // Reset filters that may hide the target, then focus it
    state.search = '';
    if (els.search) els.search.value = '';
    state.chips = { model: null, project: null, branch: null, stopReason: null, hasError: false, sidechainOnly: false };
    renderChips();
    refilter();
    var idx = state.filteredSessions.findIndex(function (s) { return s.id === id; });
    if (idx >= 0 && els.viewport) {
      els.viewport.scrollTop = Math.max(0, idx * ROW_H - 60);
      state.selected.clear(); state.selected.add(id);
      draw();
      openDrawer(id);
    }
  }

  // `/` focuses search when Zone F open + not already in an input
  document.addEventListener('keydown', function (e) {
    if (e.key !== '/') return;
    var active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
    var zone = document.getElementById('zoneF');
    if (!zone || !zone.open) return;
    e.preventDefault();
    if (els.search) els.search.focus();
  });

  window.ClaudeMeter.sessionExplorer = {
    render: render,
    openSession: openSession,
    getSessions: function () { return state.sessions.slice(); },
    getSelection: function () { return Array.from(state.selected); },
  };
})();
