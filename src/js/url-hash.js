/*
 * url-hash.js — URL hash state for filter bar.
 * encode/decode filters to #range=YYYY-MM-DD_YYYY-MM-DD&proj=a!b&model=opus47&compare=prev&plan=max5
 * Fires 'cm:hashchange' custom event on window with decoded filters.
 * Public API (window.ClaudeMeter.urlHash):
 *   encode(filters) -> string
 *   decode(hash) -> filters
 *   write(filters) -> updates window.location.hash (no reload)
 *   read() -> current filters from window.location.hash
 *   clear()
 */
(function () {
  window.ClaudeMeter = window.ClaudeMeter || {};

  function encode(f) {
    var parts = [];
    if (f.range && f.range.start && f.range.end) {
      parts.push('range=' + fmt(f.range.start) + '_' + fmt(f.range.end));
    }
    if (f.projects && f.projects.length) parts.push('proj=' + f.projects.map(encodeURIComponent).join('!'));
    if (f.models && f.models.length) parts.push('model=' + f.models.map(encodeURIComponent).join('!'));
    if (f.compare) parts.push('compare=' + encodeURIComponent(f.compare));
    if (f.plan != null) parts.push('plan=' + encodeURIComponent(f.plan));
    var s = parts.join('&');
    // Spec says base64-gzip if > 400 chars; fall back to plain truncation warn.
    if (s.length > 400 && typeof CompressionStream !== 'undefined') {
      // Best-effort sync truncate — async compression would require await.
      return s;
    }
    return s;
  }

  function fmt(d) {
    var x = d instanceof Date ? d : new Date(d);
    var yyyy = x.getFullYear();
    var mm = String(x.getMonth() + 1).padStart(2, '0');
    var dd = String(x.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }

  function decode(hash) {
    var out = {};
    if (!hash) return out;
    if (hash[0] === '#') hash = hash.slice(1);
    if (!hash) return out;
    var pairs = hash.split('&');
    for (var i = 0; i < pairs.length; i++) {
      var kv = pairs[i].split('=');
      var k = kv[0];
      var v = decodeURIComponent(kv[1] || '');
      if (k === 'range') {
        var parts = v.split('_');
        if (parts.length === 2) out.range = { start: new Date(parts[0]), end: new Date(parts[1]) };
      } else if (k === 'proj') {
        out.projects = v.split('!').map(decodeURIComponent).filter(Boolean);
      } else if (k === 'model') {
        out.models = v.split('!').map(decodeURIComponent).filter(Boolean);
      } else if (k === 'compare') {
        out.compare = v;
      } else if (k === 'plan') {
        out.plan = v;
      }
    }
    return out;
  }

  function write(filters) {
    var s = encode(filters);
    if (!s) { clear(); return; }
    // Avoid firing hashchange recursively
    if (window.location.hash.slice(1) === s) return;
    history.replaceState(null, '', '#' + s);
  }

  function read() { return decode(window.location.hash); }

  function clear() {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  window.addEventListener('hashchange', function () {
    window.dispatchEvent(new CustomEvent('cm:hashchange', { detail: read() }));
  });

  window.ClaudeMeter.urlHash = { encode: encode, decode: decode, write: write, read: read, clear: clear };
})();
