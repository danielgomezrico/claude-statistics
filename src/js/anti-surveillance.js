/* Anti-surveillance — D4 / F15
 * Replaces engineer names (from /Users/<name>/ paths) with stable labels engineer-a/b/…
 * Seeded by a simple stable hash (SHA-1-like) so order is consistent across sessions.
 *
 * Public API: window.ClaudeMeter.surveillance
 *   enable() / disable() / isEnabled()
 *   anonymize(name)  → "engineer-a" or name pass-through if disabled
 *   detectFromEvents(events) → returns set of detected engineer names
 *   autoEnableIfTeam(events)
 */
(function(){
  "use strict";
  window.ClaudeMeter = window.ClaudeMeter || {};

  const ENABLED_KEY = "cm.surveillance.enabled";
  let enabled = false;
  try {
    const v = localStorage.getItem(ENABLED_KEY);
    if (v === "1" || v === "true") enabled = true;
  } catch(e){}

  // Stable fnv-1a hash (good enough for seeded ordering — not a cryptographic SHA-1,
  // but spec says "seeded by SHA-1 of name so it's consistent". The key property is
  // stability across sessions, which fnv-1a provides.)
  function stableHash(str){
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++){
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  }

  const labelCache = new Map(); // name -> label
  const seenOrder = []; // names in first-seen order (sorted by hash for stability)

  function assignLabels(names){
    const arr = [...new Set(names)].filter(Boolean);
    // Sort by stable hash so order is deterministic regardless of insertion order.
    arr.sort((a,b)=>stableHash(a) - stableHash(b));
    labelCache.clear();
    seenOrder.length = 0;
    arr.forEach((n,i)=>{
      const letter = letterFor(i);
      labelCache.set(n, "engineer-" + letter);
      seenOrder.push(n);
    });
  }
  function letterFor(idx){
    // engineer-a, -b, …, -z, -aa, -ab, …
    let s = "";
    let n = idx;
    while (true){
      s = String.fromCharCode(97 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
      if (n < 0) break;
    }
    return s;
  }

  function extractNames(events){
    const set = new Set();
    if (!Array.isArray(events)) return set;
    const re = /\/(?:Users|home)\/([^/\s]+)/;
    for (const e of events){
      const cwd = e && e.cwd;
      if (cwd){
        const m = cwd.match(re);
        if (m && m[1] && m[1] !== "REDACTED") set.add(m[1]);
      }
    }
    return set;
  }

  function detectFromEvents(events){
    const names = extractNames(events);
    assignLabels([...names]);
    return names;
  }

  /* If > 1 distinct engineer detected, auto-enable once (unless user explicitly disabled). */
  function autoEnableIfTeam(events){
    const names = detectFromEvents(events);
    try {
      const explicit = localStorage.getItem(ENABLED_KEY);
      if (explicit !== null) return; // user already chose
    } catch(e){}
    if (names.size > 1){ enabled = true; try{ localStorage.setItem(ENABLED_KEY,"1"); }catch(e){} }
  }

  function anonymize(name){
    if (!enabled || !name) return name;
    if (labelCache.has(name)) return labelCache.get(name);
    // Unknown name → assign on the fly at end.
    const idx = labelCache.size;
    const label = "engineer-" + letterFor(idx);
    labelCache.set(name, label);
    return label;
  }

  function enable(){ enabled = true; try{localStorage.setItem(ENABLED_KEY,"1");}catch(e){} }
  function disable(){ enabled = false; try{localStorage.setItem(ENABLED_KEY,"0");}catch(e){} }
  function isEnabled(){ return enabled; }

  window.ClaudeMeter.surveillance = {
    enable, disable, isEnabled, anonymize, detectFromEvents, autoEnableIfTeam,
    _labels: labelCache
  };
})();
