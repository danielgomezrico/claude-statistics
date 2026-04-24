/* Attribution — D1 / F9
 * cwd-regex per-project mapping with settings UI.
 * Persona: David D2 (lost in projects), D3 (attribution noise).
 *
 * Public API: window.ClaudeMeter.attribution
 *   applyAll(events) -> mutates each event, sets e.attribution
 *   getRules()
 *   setRules(rules)
 *   renderSettings(mountEl)
 *   onChange(cb) — subscribe to rule changes
 */
(function(){
  "use strict";
  window.ClaudeMeter = window.ClaudeMeter || {};

  const STORAGE_KEY = "cm.attribution.rules";

  /* Default: first-path-segment grouping after common prefixes.
   * Matches cwd like /Users/<anyone>/projects/<group>/<anything>
   * → attribution = <group>.  Falls back to last segment project field otherwise. */
  const DEFAULT_RULES = [
    { regex: "^/Users/[^/]+/projects/[^/]+/([^/]+)", displayName: "$1" },
    { regex: "^/Users/[^/]+/work/([^/]+)",           displayName: "$1" },
    { regex: "^/home/[^/]+/projects/[^/]+/([^/]+)",  displayName: "$1" },
    { regex: "^/home/[^/]+/([^/]+)",                 displayName: "$1" },
  ];

  let rules = loadRules();
  const listeners = [];

  function loadRules(){
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return DEFAULT_RULES.slice();
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every(r=>r && typeof r.regex==="string")) return parsed;
    } catch(e){ console.warn("[attribution] loadRules failed:", e); }
    return DEFAULT_RULES.slice();
  }
  function saveRules(){
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rules)); }
    catch(e){ console.warn("[attribution] saveRules failed:", e); }
  }
  function notify(){ listeners.forEach(cb=>{ try{ cb(rules.slice()); } catch(e){ console.warn("[attribution] listener error:", e); } }); }

  function compileRule(r){
    try { return new RegExp(r.regex); } catch(e){ return null; }
  }

  function resolveName(cwd, fallback){
    if (!cwd) return fallback || "unknown";
    for (const r of rules){
      const re = compileRule(r);
      if (!re) continue;
      const m = cwd.match(re);
      if (m){
        let name = r.displayName || "$1";
        // Replace $1..$9 with captures
        name = name.replace(/\$([1-9])/g, (_, i) => m[Number(i)] || "");
        name = name.trim();
        if (name) return name;
      }
    }
    return fallback || "unknown";
  }

  function applyAll(events){
    if (!Array.isArray(events)) return;
    for (const e of events){
      const cwd = e && (e.cwd || "");
      const fallback = e && (e.project || "");
      e.attribution = resolveName(cwd, fallback);
    }
  }

  function getRules(){ return rules.map(r=>({...r})); }
  function setRules(next){
    if (!Array.isArray(next)) return;
    rules = next.filter(r => r && typeof r.regex === "string").map(r=>({regex:r.regex, displayName:r.displayName||"$1"}));
    saveRules(); notify();
  }
  function resetDefaults(){ rules = DEFAULT_RULES.slice(); saveRules(); notify(); }
  function onChange(cb){ if (typeof cb === "function") listeners.push(cb); }

  /* Settings UI — a collapsible <details> rendered into any mount element. */
  function renderSettings(mountEl){
    if (!mountEl) return;
    mountEl.innerHTML = "";
    const details = document.createElement("details");
    details.className = "cm-attr-settings";
    const summary = document.createElement("summary");
    summary.textContent = "Attribution rules (cwd → project name)";
    details.appendChild(summary);

    const body = document.createElement("div");
    body.className = "cm-attr-body";
    details.appendChild(body);

    const list = document.createElement("div");
    list.className = "cm-attr-list";
    body.appendChild(list);

    const actions = document.createElement("div");
    actions.className = "cm-attr-actions";
    const addBtn = mkBtn("+ Add rule", ()=>{ rules.push({ regex:"^/path/([^/]+)", displayName:"$1" }); saveRules(); notify(); redraw(); });
    const resetBtn = mkBtn("Reset defaults", ()=>{ if (confirm("Restore default attribution rules?")){ resetDefaults(); redraw(); }});
    actions.appendChild(addBtn);
    actions.appendChild(resetBtn);
    body.appendChild(actions);

    const hint = document.createElement("div");
    hint.className = "cm-attr-hint";
    hint.textContent = "Rules match cwd in order; first match wins. Use $1..$9 in name for captures. Fallback: event.project.";
    body.appendChild(hint);

    function mkBtn(label, handler){
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn"; b.textContent = label; b.onclick = handler;
      return b;
    }

    function redraw(){
      list.innerHTML = "";
      rules.forEach((r, i)=>{
        const row = document.createElement("div");
        row.className = "cm-attr-row";
        const regex = document.createElement("input");
        regex.type = "text"; regex.value = r.regex; regex.placeholder = "regex";
        regex.oninput = ()=>{ rules[i].regex = regex.value; saveRules(); notify(); };
        const name = document.createElement("input");
        name.type = "text"; name.value = r.displayName; name.placeholder = "$1";
        name.oninput = ()=>{ rules[i].displayName = name.value; saveRules(); notify(); };
        const up = mkBtn("↑", ()=>{ if (i>0){ [rules[i-1],rules[i]]=[rules[i],rules[i-1]]; saveRules(); notify(); redraw(); }});
        const dn = mkBtn("↓", ()=>{ if (i<rules.length-1){ [rules[i+1],rules[i]]=[rules[i],rules[i+1]]; saveRules(); notify(); redraw(); }});
        const rm = mkBtn("×", ()=>{ rules.splice(i,1); saveRules(); notify(); redraw(); });
        row.appendChild(regex); row.appendChild(name); row.appendChild(up); row.appendChild(dn); row.appendChild(rm);
        list.appendChild(row);
      });
      if (!rules.length){
        const empty = document.createElement("div");
        empty.className = "cm-attr-empty";
        empty.textContent = "No rules. Event.project will be used as-is.";
        list.appendChild(empty);
      }
    }
    redraw();
    mountEl.appendChild(details);
  }

  window.ClaudeMeter.attribution = { applyAll, getRules, setRules, resetDefaults, onChange, renderSettings };
})();
