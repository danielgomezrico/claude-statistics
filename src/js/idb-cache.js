/*
 * idb-cache.js — IndexedDB parse cache (Wave 3 / perf).
 *
 * Caches parser output keyed by content-addressed hash of the input file list
 * (filenames + sizes + lastModified). On parse: hash key, look up; if hit,
 * hydrate STATE.events directly + skip parse. On parse complete: write back.
 *
 * Eviction: cap total cache at 50 MB; evict oldest entries (LRU by lastUsed).
 *
 * Disable switch: localStorage `cm.cache.disabled` truthy -> all ops no-op.
 *
 * Public API (window.ClaudeMeter.idbCache):
 *   isAvailable()        -> bool
 *   isDisabled()         -> bool
 *   keyFor(fileList)     -> Promise<string>
 *   get(key)             -> Promise<{events, rollups, version, savedAt} | null>
 *   set(key, payload)    -> Promise<void>
 *   clear()              -> Promise<void>
 *   list()               -> Promise<Array<{key, savedAt, lastUsed, size, n}>>
 *   stats()              -> Promise<{count, totalSize, capBytes}>
 */
(function () {
  window.ClaudeMeter = window.ClaudeMeter || {};

  var DB_NAME = 'claude-meter-cache';
  var STORE = 'parses';
  var VERSION = 1;
  var CAP_BYTES = 50 * 1024 * 1024; // 50 MB
  var DISABLED_KEY = 'cm.cache.disabled';

  function isAvailable() {
    try { return typeof indexedDB !== 'undefined' && !!indexedDB; }
    catch (_) { return false; }
  }

  function isDisabled() {
    try { return !!localStorage.getItem(DISABLED_KEY); }
    catch (_) { return false; }
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      if (!isAvailable()) return reject(new Error('IDB unavailable'));
      var req;
      try { req = indexedDB.open(DB_NAME, VERSION); }
      catch (e) { return reject(e); }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'key' });
          os.createIndex('byLastUsed', 'lastUsed');
          os.createIndex('bySavedAt', 'savedAt');
        }
      };
      req.onerror = function () { reject(req.error || new Error('IDB open failed')); };
      req.onblocked = function () { reject(new Error('IDB blocked')); };
      req.onsuccess = function () { resolve(req.result); };
    });
  }

  function tx(mode) {
    return openDb().then(function (db) {
      var t = db.transaction(STORE, mode);
      return { db: db, store: t.objectStore(STORE), tx: t };
    });
  }

  function promisify(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function keyFor(fileList) {
    // Stable representation: sorted by name then size+lastModified.
    var arr = Array.from(fileList || []).map(function (f) {
      return [
        (f.webkitRelativePath || f.name || ''),
        f.size || 0,
        f.lastModified || 0,
      ].join('|');
    }).sort();
    var s = arr.join('\n');
    if (window.crypto && window.crypto.subtle && window.TextEncoder) {
      return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(function (buf) {
        return 'sha256-' + Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      });
    }
    // Fallback: FNV-1a (non-crypto, but stable).
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    return Promise.resolve('fnv1a-' + h.toString(16));
  }

  function get(key) {
    if (isDisabled() || !isAvailable()) return Promise.resolve(null);
    return tx('readonly').then(function (h) {
      return promisify(h.store.get(key));
    }).then(function (row) {
      if (!row) return null;
      // Touch lastUsed asynchronously; not critical if it fails.
      tx('readwrite').then(function (h2) {
        row.lastUsed = Date.now();
        try { h2.store.put(row); } catch (_) {}
      }).catch(function () {});
      return row;
    }).catch(function (e) {
      console.warn('[idb-cache] get failed:', e);
      return null;
    });
  }

  function approxSize(payload) {
    try { return JSON.stringify(payload).length; }
    catch (_) { return 0; }
  }

  function set(key, payload) {
    if (isDisabled() || !isAvailable()) return Promise.resolve();
    var size = approxSize(payload);
    var row = {
      key: key,
      savedAt: Date.now(),
      lastUsed: Date.now(),
      size: size,
      n: (payload && payload.events && payload.events.length) || 0,
      payload: payload,
    };
    return evictIfNeeded(size).then(function () {
      return tx('readwrite');
    }).then(function (h) {
      h.store.put(row);
      return new Promise(function (resolve, reject) {
        h.tx.oncomplete = function () { resolve(); };
        h.tx.onerror = function () { reject(h.tx.error); };
        h.tx.onabort = function () { reject(h.tx.error || new Error('tx abort')); };
      });
    }).catch(function (e) {
      console.warn('[idb-cache] set failed:', e);
    });
  }

  function clear() {
    if (!isAvailable()) return Promise.resolve();
    return tx('readwrite').then(function (h) {
      h.store.clear();
      return new Promise(function (resolve, reject) {
        h.tx.oncomplete = function () { resolve(); };
        h.tx.onerror = function () { reject(h.tx.error); };
      });
    });
  }

  function list() {
    if (!isAvailable()) return Promise.resolve([]);
    return tx('readonly').then(function (h) {
      return promisify(h.store.getAll());
    }).then(function (rows) {
      return rows.map(function (r) {
        return { key: r.key, savedAt: r.savedAt, lastUsed: r.lastUsed, size: r.size || 0, n: r.n || 0 };
      });
    }).catch(function () { return []; });
  }

  function stats() {
    return list().then(function (rows) {
      var total = rows.reduce(function (s, r) { return s + (r.size || 0); }, 0);
      return { count: rows.length, totalSize: total, capBytes: CAP_BYTES };
    });
  }

  function evictIfNeeded(incoming) {
    return list().then(function (rows) {
      var current = rows.reduce(function (s, r) { return s + (r.size || 0); }, 0);
      if (current + incoming <= CAP_BYTES) return;
      // LRU eviction: oldest lastUsed first.
      rows.sort(function (a, b) { return a.lastUsed - b.lastUsed; });
      var toFree = (current + incoming) - CAP_BYTES;
      var freed = 0;
      var keys = [];
      for (var i = 0; i < rows.length && freed < toFree; i++) {
        keys.push(rows[i].key); freed += rows[i].size || 0;
      }
      if (!keys.length) return;
      return tx('readwrite').then(function (h) {
        keys.forEach(function (k) { try { h.store.delete(k); } catch (_) {} });
        return new Promise(function (resolve) {
          h.tx.oncomplete = function () { resolve(); };
          h.tx.onerror = function () { resolve(); };
        });
      });
    }).catch(function () {});
  }

  window.ClaudeMeter.idbCache = {
    isAvailable: isAvailable,
    isDisabled: isDisabled,
    keyFor: keyFor,
    get: get,
    set: set,
    clear: clear,
    list: list,
    stats: stats,
    CAP_BYTES: CAP_BYTES,
  };
})();
