/*
 * state.js — Central app state + pub/sub.
 * Public API (window.CM.state):
 *   get(key)                  → value
 *   set(key, value)           → publishes 'change:<key>' and 'change'
 *   patch(obj)                → multi-key set, single 'change' publish
 *   subscribe(eventName, fn)  → returns unsubscribe()
 *   publish(eventName, data)
 *   raw                       → direct (mutation-allowed) reference for hot paths
 *
 * Canonical keys:
 *   events   : Event[]       (all parsed events, never filtered)
 *   charts   : {[id]: Chart}
 *   bucket   : 'hour'|'day'|'week'|'month'
 *   plan     : number        ($/mo subscription cost)
 *   theme    : 'dark'|'light'
 *   motion   : 'full'|'reduced'|'none'
 *   demo     : boolean
 */
(function () {
  window.CM = window.CM || {};

  var listeners = Object.create(null);
  var raw = {
    events: [],
    charts: {},
    bucket: 'day',
    plan: 100,
    theme: 'dark',
    motion: 'full',
    demo: false,
  };

  function publish(name, data) {
    var ls = listeners[name];
    if (!ls) return;
    for (var i = 0; i < ls.length; i++) {
      try { ls[i](data); } catch (e) { console.error('[state]', name, e); }
    }
  }

  function subscribe(name, fn) {
    (listeners[name] = listeners[name] || []).push(fn);
    return function () {
      var ls = listeners[name];
      if (!ls) return;
      var i = ls.indexOf(fn);
      if (i >= 0) ls.splice(i, 1);
    };
  }

  function get(key) { return raw[key]; }
  function set(key, value) {
    raw[key] = value;
    publish('change:' + key, value);
    publish('change', { key: key, value: value });
  }
  function patch(obj) {
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) {
      raw[k] = obj[k];
      publish('change:' + k, obj[k]);
    }
    publish('change', { patch: obj });
  }

  window.CM.state = { get: get, set: set, patch: patch, subscribe: subscribe, publish: publish, raw: raw };
})();
