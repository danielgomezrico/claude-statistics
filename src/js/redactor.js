/* Redactor — D5 / F3
 * Project-name redaction.  Persona: David D5/M8 (share screens without leaking names).
 *
 * Public API: window.ClaudeMeter.redact
 *   enable() / disable() / isEnabled()
 *   apply(name) → stable blurred alias like "project-a7f2"
 *   applyForExport(name) → always redacts when export-default-on
 *   setExport(b) / getExport()
 *   installToggle(hostEl) — mounts eye-icon toggle in header
 */
(function(){
  "use strict";
  window.ClaudeMeter = window.ClaudeMeter || {};

  const UI_KEY = "cm.redact.ui";
  const EXPORT_KEY = "cm.redact.export";

  let uiOn = false;
  let exportOn = true;
  try {
    const u = localStorage.getItem(UI_KEY);
    if (u === "1" || u === "true") uiOn = true;
    const x = localStorage.getItem(EXPORT_KEY);
    if (x === "0" || x === "false") exportOn = false;
  } catch(e){}

  const cache = new Map();

  function stableHash(str){
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++){
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  }

  function alias(name){
    if (!name) return name;
    if (cache.has(name)) return cache.get(name);
    const h = stableHash(String(name)).toString(16).padStart(8,"0").slice(0,4);
    const a = "project-" + h;
    cache.set(name, a);
    return a;
  }

  function apply(name){
    if (!uiOn) return name;
    return alias(name);
  }
  function applyForExport(name){
    if (!exportOn) return name;
    return alias(name);
  }

  function enable(){ uiOn = true; try{localStorage.setItem(UI_KEY,"1");}catch(e){} refreshBodyClass(); fireChange(); }
  function disable(){ uiOn = false; try{localStorage.setItem(UI_KEY,"0");}catch(e){} refreshBodyClass(); fireChange(); }
  function isEnabled(){ return uiOn; }
  function setExport(b){ exportOn = !!b; try{localStorage.setItem(EXPORT_KEY, exportOn?"1":"0");}catch(e){} }
  function getExport(){ return exportOn; }

  const changeListeners = [];
  function onChange(cb){ if (typeof cb === "function") changeListeners.push(cb); }
  function fireChange(){ changeListeners.forEach(cb=>{ try{cb(uiOn);}catch(e){} }); }

  function refreshBodyClass(){
    if (!document.body) return;
    document.body.classList.toggle("cm-redact-on", uiOn);
  }

  /* Eye-icon toggle with "reveal on hover" ergonomic when ON. */
  function installToggle(hostEl){
    if (!hostEl) return;
    if (hostEl.querySelector(".cm-redact-toggle")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-redact-toggle";
    btn.setAttribute("aria-label","Toggle project-name redaction");
    btn.title = "Redact project names (click to toggle, hover to reveal when on)";
    btn.innerHTML = svgEye() + '<span class="cm-redact-label">Off</span>';
    btn.addEventListener("click", ()=>{
      if (uiOn) disable(); else enable();
      update();
    });
    function update(){
      btn.classList.toggle("on", uiOn);
      const lbl = btn.querySelector(".cm-redact-label");
      if (lbl) lbl.textContent = uiOn ? "On" : "Off";
    }
    hostEl.appendChild(btn);
    update();
    refreshBodyClass();
  }

  function svgEye(){
    // Simple open-eye icon; closes visually via CSS when on.
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+
           '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
  }

  function injectStyle(){
    if (document.getElementById("cm-redact-style")) return;
    const s = document.createElement("style");
    s.id = "cm-redact-style";
    s.textContent = `
      .cm-redact-toggle{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;background:var(--panel2);color:var(--muted);border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:12px;transition:.15s}
      .cm-redact-toggle:hover{color:var(--accent);border-color:var(--accent)}
      .cm-redact-toggle.on{color:var(--accent);border-color:var(--accent);background:#d9775722}
      .cm-redact-label{font-weight:500}
      /* Reveal-on-hover ergonomic: when redaction UI is on, the ROI card names
         get a soft blur class that clears on hover. */
      body.cm-redact-on .cm-roi-name, body.cm-redact-on td.cm-redact-target{filter:blur(4px);transition:filter .15s}
      body.cm-redact-on .cm-roi-name:hover, body.cm-redact-on td.cm-redact-target:hover{filter:none}
    `;
    document.head.appendChild(s);
  }
  injectStyle();

  window.ClaudeMeter.redact = {
    enable, disable, isEnabled, apply, applyForExport,
    setExport, getExport, installToggle, onChange
  };
})();
