/*
 * filter-bar.js — Sticky global filter bar (date / projects / models / plan / compare / reset).
 * Derives project/model options from STATE.events when available.
 * Exposes window.ClaudeMeter.filterBar:
 *   init(containerEl)
 *   getFilters() -> { range, projects, models, plan, compare }
 *   applyFilters(events) -> filtered events
 *   onChange(fn) -> unsubscribe
 * Debounced at 100ms; writes to URL hash via window.ClaudeMeter.urlHash.
 */
(function () {
  window.ClaudeMeter = window.ClaudeMeter || {};

  var listeners = [];
  var filters = {
    range: null,        // { start: Date, end: Date } or null (=all)
    rangePreset: 'all',
    projects: [],       // empty = all
    models: [],         // empty = all
    plan: null,         // string: '0'|'20'|'100'|'200'|'custom:NN'|null
    compare: 'off',     // 'off'|'prev'|'yoy'|'custom'
  };
  var debounceT = null;
  var root = null;

  function notify() {
    clearTimeout(debounceT);
    debounceT = setTimeout(function () {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](filters); } catch (e) { console.error('[filter-bar]', e); }
      }
      if (window.ClaudeMeter.urlHash) window.ClaudeMeter.urlHash.write(filters);
    }, 100);
  }

  function onChange(fn) {
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function getFilters() { return filters; }

  function applyFilters(events) {
    if (!events || !events.length) return events || [];
    var out = events;
    if (filters.range && filters.range.start && filters.range.end) {
      var s = +filters.range.start, e = +filters.range.end;
      out = out.filter(function (ev) { var t = +ev.ts; return t >= s && t <= e; });
    }
    if (filters.projects && filters.projects.length) {
      var pset = new Set(filters.projects);
      out = out.filter(function (ev) { return pset.has(ev.project); });
    }
    if (filters.models && filters.models.length) {
      var mset = new Set(filters.models);
      out = out.filter(function (ev) { return mset.has(ev.model); });
    }
    return out;
  }

  function preset(name) {
    var now = new Date();
    var end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    var start;
    if (name === '7d') start = new Date(end.getTime() - 6 * 86400000);
    else if (name === '30d') start = new Date(end.getTime() - 29 * 86400000);
    else if (name === '90d') start = new Date(end.getTime() - 89 * 86400000);
    else if (name === 'mtd') start = new Date(now.getFullYear(), now.getMonth(), 1);
    else if (name === 'ytd') start = new Date(now.getFullYear(), 0, 1);
    else return null;
    start.setHours(0, 0, 0, 0);
    return { start: start, end: end };
  }

  function fmtRange(r) {
    if (!r || !r.start || !r.end) return 'all';
    var opts = { month: 'short', day: 'numeric' };
    return r.start.toLocaleDateString(undefined, opts) + '-' + r.end.toLocaleDateString(undefined, opts);
  }

  function getEvents() {
    // Prefer state module if present
    if (window.CM && window.CM.state) return window.CM.state.get('events') || [];
    if (window.STATE && window.STATE.events) return window.STATE.events;
    return [];
  }

  function uniqueOptions(field) {
    var set = new Set();
    var evs = getEvents();
    for (var i = 0; i < evs.length; i++) set.add(evs[i][field]);
    return Array.from(set).filter(Boolean).sort();
  }

  function makeChip(label, onClick) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'fb-chip';
    el.textContent = label;
    el.addEventListener('click', onClick);
    return el;
  }

  function openMenu(anchor, contentEl) {
    closeMenus();
    var m = document.createElement('div');
    m.className = 'fb-menu';
    m.appendChild(contentEl);
    document.body.appendChild(m);
    var r = anchor.getBoundingClientRect();
    m.style.left = Math.max(8, r.left) + 'px';
    m.style.top = (r.bottom + window.scrollY + 4) + 'px';
    setTimeout(function () {
      document.addEventListener('click', docClick, { once: true });
    }, 0);
    function docClick(e) {
      if (m.contains(e.target) || anchor.contains(e.target)) {
        document.addEventListener('click', docClick, { once: true });
        return;
      }
      closeMenus();
    }
  }
  function closeMenus() {
    var ms = document.querySelectorAll('.fb-menu');
    ms.forEach(function (m) { m.remove(); });
  }

  function buildDateMenu(chip) {
    var wrap = document.createElement('div');
    var presets = [['7d', '7d'], ['30d', '30d'], ['90d', '90d'], ['mtd', 'MTD'], ['ytd', 'YTD'], ['all', 'All']];
    var row = document.createElement('div'); row.className = 'fb-menu-row';
    presets.forEach(function (p) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'fb-chip sm'; b.textContent = p[1];
      b.addEventListener('click', function () {
        filters.rangePreset = p[0];
        filters.range = p[0] === 'all' ? null : preset(p[0]);
        updateChipLabels();
        notify();
        closeMenus();
      });
      row.appendChild(b);
    });
    wrap.appendChild(row);

    var custom = document.createElement('div'); custom.className = 'fb-menu-row';
    var s = document.createElement('input'); s.type = 'date';
    var e = document.createElement('input'); e.type = 'date';
    var apply = document.createElement('button'); apply.type = 'button'; apply.className = 'fb-chip sm'; apply.textContent = 'Apply';
    apply.addEventListener('click', function () {
      if (s.value && e.value) {
        filters.rangePreset = 'custom';
        filters.range = { start: new Date(s.value + 'T00:00:00'), end: new Date(e.value + 'T23:59:59') };
        updateChipLabels();
        notify();
        closeMenus();
      }
    });
    custom.appendChild(s); custom.appendChild(e); custom.appendChild(apply);
    wrap.appendChild(custom);
    return wrap;
  }

  function buildMultiMenu(field, selectedRef) {
    var wrap = document.createElement('div');
    var search = document.createElement('input');
    search.type = 'text'; search.placeholder = 'Search…'; search.className = 'fb-search';
    wrap.appendChild(search);

    var list = document.createElement('div'); list.className = 'fb-list';
    var opts = uniqueOptions(field);

    function renderList(filter) {
      list.innerHTML = '';
      var allBtn = document.createElement('label'); allBtn.className = 'fb-opt';
      var allCb = document.createElement('input'); allCb.type = 'checkbox'; allCb.checked = selectedRef.value.length === 0;
      allCb.addEventListener('change', function () { if (allCb.checked) { selectedRef.value = []; renderList(filter); updateChipLabels(); notify(); } });
      allBtn.appendChild(allCb); allBtn.appendChild(document.createTextNode(' all')); list.appendChild(allBtn);
      opts.filter(function (o) { return !filter || o.toLowerCase().indexOf(filter.toLowerCase()) >= 0; }).forEach(function (o) {
        var lab = document.createElement('label'); lab.className = 'fb-opt';
        var cb = document.createElement('input'); cb.type = 'checkbox';
        cb.checked = selectedRef.value.indexOf(o) >= 0;
        cb.addEventListener('change', function () {
          if (cb.checked) { if (selectedRef.value.indexOf(o) < 0) selectedRef.value.push(o); }
          else { selectedRef.value = selectedRef.value.filter(function (x) { return x !== o; }); }
          updateChipLabels();
          notify();
        });
        lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + o));
        list.appendChild(lab);
      });
    }
    search.addEventListener('input', function () { renderList(search.value); });
    renderList('');
    wrap.appendChild(list);
    return wrap;
  }

  function buildPlanMenu() {
    var wrap = document.createElement('div'); wrap.className = 'fb-menu-col';
    var opts = [
      ['0', 'None (API only)'],
      ['20', 'Pro ($20/mo)'],
      ['100', 'Max 5× ($100/mo)'],
      ['200', 'Max 20× ($200/mo)'],
    ];
    opts.forEach(function (o) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'fb-chip sm';
      b.textContent = o[1];
      b.addEventListener('click', function () {
        filters.plan = o[0];
        syncPlanSelect(o[0]);
        updateChipLabels();
        notify();
        closeMenus();
      });
      wrap.appendChild(b);
    });
    var customRow = document.createElement('div'); customRow.className = 'fb-menu-row';
    var inp = document.createElement('input'); inp.type = 'number'; inp.placeholder = 'custom $/mo';
    var apply = document.createElement('button'); apply.type = 'button'; apply.className = 'fb-chip sm'; apply.textContent = 'Set';
    apply.addEventListener('click', function () {
      if (inp.value) {
        filters.plan = 'custom:' + inp.value;
        syncPlanSelect(inp.value);
        updateChipLabels();
        notify();
        closeMenus();
      }
    });
    customRow.appendChild(inp); customRow.appendChild(apply);
    wrap.appendChild(customRow);
    return wrap;
  }

  function syncPlanSelect(value) {
    var sel = document.getElementById('plan');
    if (!sel) return;
    // Add custom option if not present
    var numeric = value.toString().replace('custom:', '');
    var has = false;
    for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === numeric) { has = true; break; }
    if (!has) {
      var opt = document.createElement('option');
      opt.value = numeric; opt.textContent = 'Custom ($' + numeric + '/mo)';
      sel.appendChild(opt);
    }
    sel.value = numeric;
    sel.dispatchEvent(new Event('change'));
  }

  function buildCompareMenu() {
    var wrap = document.createElement('div'); wrap.className = 'fb-menu-col';
    var opts = [['off', 'Off'], ['prev', 'Previous period'], ['yoy', 'Year-over-year'], ['custom', 'Custom']];
    opts.forEach(function (o) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'fb-chip sm';
      b.textContent = o[1];
      b.addEventListener('click', function () {
        filters.compare = o[0];
        updateChipLabels();
        notify();
        closeMenus();
      });
      wrap.appendChild(b);
    });
    return wrap;
  }

  var chipDate, chipProj, chipModel, chipPlan, chipCompare;

  function updateChipLabels() {
    if (!root) return;
    chipDate.textContent = 'Date: ' + (filters.rangePreset === 'custom' ? fmtRange(filters.range) : filters.rangePreset);
    chipProj.textContent = 'Projects: ' + (filters.projects.length ? filters.projects.length + ' selected' : 'all');
    chipModel.textContent = 'Models: ' + (filters.models.length ? filters.models.length + ' selected' : 'all');
    var planLabel = filters.plan === '0' ? 'None' : filters.plan === '20' ? 'Pro' : filters.plan === '100' ? 'Max5' : filters.plan === '200' ? 'Max20' : filters.plan && filters.plan.toString().indexOf('custom:') === 0 ? '$' + filters.plan.split(':')[1] : 'Max5';
    chipPlan.textContent = 'Plan: ' + planLabel;
    chipCompare.textContent = 'Compare: ' + ({ off: 'off', prev: 'prev period', yoy: 'YoY', custom: 'custom' }[filters.compare] || 'off');
  }

  function init(container) {
    root = container;
    container.classList.add('fb-bar');
    container.innerHTML = '';

    var projRef = { value: filters.projects };
    var modelRef = { value: filters.models };

    chipDate = makeChip('Date: all', function () { openMenu(chipDate, buildDateMenu()); });
    chipProj = makeChip('Projects: all', function () { projRef.value = filters.projects; openMenu(chipProj, buildMultiMenu('project', projRef)); filters.projects = projRef.value; });
    chipModel = makeChip('Models: all', function () { modelRef.value = filters.models; openMenu(chipModel, buildMultiMenu('model', modelRef)); filters.models = modelRef.value; });
    chipPlan = makeChip('Plan: Max5', function () { openMenu(chipPlan, buildPlanMenu()); });
    chipCompare = makeChip('Compare: off', function () { openMenu(chipCompare, buildCompareMenu()); });
    var chipReset = makeChip('Reset', function () {
      filters = { range: null, rangePreset: 'all', projects: [], models: [], plan: null, compare: 'off' };
      updateChipLabels();
      if (window.ClaudeMeter.urlHash) window.ClaudeMeter.urlHash.clear();
      notify();
    });
    chipReset.classList.add('reset');

    [chipDate, chipProj, chipModel, chipPlan, chipCompare, chipReset].forEach(function (c) { container.appendChild(c); });

    // Rehydrate from URL
    if (window.ClaudeMeter.urlHash) {
      var h = window.ClaudeMeter.urlHash.read();
      if (h.range) { filters.range = h.range; filters.rangePreset = 'custom'; }
      if (h.projects) filters.projects = h.projects;
      if (h.models) filters.models = h.models;
      if (h.plan) { filters.plan = h.plan; syncPlanSelect(h.plan.toString().replace('custom:', '')); }
      if (h.compare) filters.compare = h.compare;
    }

    window.addEventListener('cm:hashchange', function (e) {
      var h = e.detail || {};
      if (h.range) { filters.range = h.range; filters.rangePreset = 'custom'; }
      if (h.projects) filters.projects = h.projects;
      if (h.models) filters.models = h.models;
      if (h.compare) filters.compare = h.compare;
      updateChipLabels();
      notify();
    });

    // Keyboard shortcuts: d/w/m -> bucket
    document.addEventListener('keydown', function (e) {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var k = e.key.toLowerCase();
      if (k === 'd' || k === 'w' || k === 'm') {
        var tab = document.querySelector('#bucketTabs .tab[data-bucket="' + (k === 'd' ? 'day' : k === 'w' ? 'week' : 'month') + '"]');
        if (tab) tab.click();
      }
    });

    updateChipLabels();
  }

  window.ClaudeMeter.filterBar = {
    init: init,
    getFilters: getFilters,
    applyFilters: applyFilters,
    onChange: onChange,
  };
})();
