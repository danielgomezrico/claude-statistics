/*
 * pricing.js — Model pricing table + editor UI.
 * Public API (window.CM.pricing):
 *   PRICING               : array of { match, in, out, cacheRead, cacheWrite } ($/1M tokens)
 *   priceFor(model)       : finds first substring match, defaults to last entry
 *   renderPriceGrid(rootEl, onEdit)
 *                         : mounts editable grid into rootEl; calls onEdit() on any change
 */
(function () {
  window.CM = window.CM || {};

  var PRICING = [
    { match: 'opus',   in: 15.00, out: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
    { match: 'sonnet', in:  3.00, out: 15.00, cacheRead: 0.30, cacheWrite:  3.75 },
    { match: 'haiku',  in:  1.00, out:  5.00, cacheRead: 0.10, cacheWrite:  1.25 },
    { match: '',       in:  3.00, out: 15.00, cacheRead: 0.30, cacheWrite:  3.75 },
  ];

  function priceFor(model) {
    var m = (model || '').toLowerCase();
    for (var i = 0; i < PRICING.length; i++) {
      if (PRICING[i].match && m.indexOf(PRICING[i].match) >= 0) return PRICING[i];
    }
    return PRICING[PRICING.length - 1];
  }

  function renderPriceGrid(grid, onEdit) {
    if (!grid) return;
    // Keep the existing header row (present in index.html) and append entries.
    PRICING.forEach(function (p, i) {
      var mk = function (val, key) {
        var el = document.createElement('input');
        el.type = 'number';
        el.step = '0.01';
        el.value = val;
        el.oninput = function () {
          PRICING[i][key] = parseFloat(el.value) || 0;
          if (onEdit) onEdit();
        };
        return el;
      };
      var lbl = document.createElement('input');
      lbl.type = 'text';
      lbl.value = p.match || '(default)';
      lbl.readOnly = (p.match === '');
      lbl.oninput = function () {
        PRICING[i].match = lbl.value;
        if (onEdit) onEdit();
      };
      grid.appendChild(lbl);
      grid.appendChild(mk(p.in, 'in'));
      grid.appendChild(mk(p.out, 'out'));
      grid.appendChild(mk(p.cacheRead, 'cacheRead'));
      grid.appendChild(mk(p.cacheWrite, 'cacheWrite'));
    });
  }

  window.CM.pricing = { PRICING: PRICING, priceFor: priceFor, renderPriceGrid: renderPriceGrid };
})();
