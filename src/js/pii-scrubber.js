/* PII Scrubber — D3 / F8
 * Client-side PII / API-key stripper for exports.
 * Persona: Sofia S3 (trust floor — scrub-before-share default ON).
 *
 * Public API: window.ClaudeMeter.pii
 *   scrub(text, { aggressive }) -> { scrubbed, redactions:[{type,count}] }
 *   previewExport(text, opts) -> Promise<string|null>
 *   wrapExport(runExportFn) — wraps an export function so output is scrubbed + previewed
 *   isEnabled()/setEnabled(bool)
 */
(function(){
  "use strict";
  window.ClaudeMeter = window.ClaudeMeter || {};

  const ENABLED_KEY = "cm.pii.enabled";
  let enabled = true;
  try {
    const v = localStorage.getItem(ENABLED_KEY);
    if (v === "0" || v === "false") enabled = false;
  } catch(e){}

  function isEnabled(){ return enabled; }
  function setEnabled(b){
    enabled = !!b;
    try { localStorage.setItem(ENABLED_KEY, enabled?"1":"0"); } catch(e){}
  }

  /* Luhn check for card digits only. */
  function luhn(digits){
    let sum = 0, alt = false;
    for (let i = digits.length - 1; i >= 0; i--){
      let n = parseInt(digits[i], 10);
      if (alt){ n *= 2; if (n > 9) n -= 9; }
      sum += n; alt = !alt;
    }
    return sum % 10 === 0;
  }

  // Regex patterns (ordered — API keys first).
  const P_ANT    = /sk-ant-[a-zA-Z0-9_-]{20,}/g;
  const P_SK     = /\bsk-[a-zA-Z0-9]{20,}\b/g;
  const P_JWT    = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
  const P_EMAIL  = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  const P_PHONE  = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{3,4}/g;
  const P_CARD   = /\b(?:\d[ -]?){13,19}\b/g;
  const P_IPV4   = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
  const P_IPV6   = /\b(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}\b/g;
  const P_HOME   = /\/(Users|home)\/([^/\s"'\\]+)/g;
  const P_GH_URL = /\bhttps?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?/g;

  function scrub(text, opts){
    opts = opts || {};
    const aggressive = !!opts.aggressive;
    if (typeof text !== "string") text = String(text == null ? "" : text);
    const counts = { apiKey:0, jwt:0, email:0, phone:0, card:0, ip:0, home:0, github:0 };

    let out = text;
    out = out.replace(P_ANT, ()=>{ counts.apiKey++; return "[REDACTED_API_KEY]"; });
    out = out.replace(P_SK,  ()=>{ counts.apiKey++; return "[REDACTED_API_KEY]"; });
    out = out.replace(P_JWT, ()=>{ counts.jwt++; return "[REDACTED_JWT]"; });
    out = out.replace(P_EMAIL, ()=>{ counts.email++; return "[REDACTED_EMAIL]"; });
    out = out.replace(P_CARD, (m)=>{
      const digits = m.replace(/[^0-9]/g, "");
      if (digits.length >= 13 && digits.length <= 19 && luhn(digits)){
        counts.card++; return "[REDACTED_CARD]";
      }
      return m;
    });
    out = out.replace(P_PHONE, (m)=>{
      const digits = m.replace(/[^0-9]/g, "");
      if (digits.length >= 7 && digits.length <= 15){ counts.phone++; return "[REDACTED_PHONE]"; }
      return m;
    });
    out = out.replace(P_IPV4, ()=>{ counts.ip++; return "[REDACTED_IP]"; });
    out = out.replace(P_IPV6, (m)=>{
      // Avoid matching simple timestamps/uuids pieces — require at least two colons already matched.
      counts.ip++; return "[REDACTED_IP]";
    });
    out = out.replace(P_HOME, (_m, root)=>{ counts.home++; return "/"+root+"/[REDACTED]"; });
    if (aggressive){
      out = out.replace(P_GH_URL, ()=>{ counts.github++; return "[REDACTED_GITHUB]"; });
    }

    const redactions = Object.entries(counts)
      .filter(([,v])=>v>0)
      .map(([type,count])=>({type,count}));
    return { scrubbed: out, redactions };
  }

  /* Modal preview: resolves with the scrubbed text if committed, or null if cancelled. */
  function previewExport(text, opts){
    return new Promise((resolve)=>{
      if (!enabled){ resolve(text); return; }
      const { scrubbed, redactions } = scrub(text, opts);
      if (!redactions.length){ resolve(scrubbed); return; }
      const overlay = document.createElement("div");
      overlay.className = "cm-pii-overlay";
      overlay.innerHTML = `
        <div class="cm-pii-modal">
          <h3>Export scrub preview</h3>
          <div class="cm-pii-summary">${redactions.map(r=>`<span class="pill warn">${r.count}× ${r.type}</span>`).join(" ")}</div>
          <div class="cm-pii-hint">Scrub-on-export is ON. Review and commit, or cancel.</div>
          <pre class="cm-pii-preview"></pre>
          <div class="cm-pii-actions">
            <button type="button" class="btn" data-act="cancel">Cancel</button>
            <button type="button" class="btn primary" data-act="commit">Commit export</button>
          </div>
        </div>`;
      overlay.querySelector(".cm-pii-preview").textContent = scrubbed.length > 4000 ? scrubbed.slice(0,4000)+"\n…(truncated preview)" : scrubbed;
      overlay.addEventListener("click", (ev)=>{
        const act = ev.target && ev.target.getAttribute && ev.target.getAttribute("data-act");
        if (!act) return;
        document.body.removeChild(overlay);
        resolve(act === "commit" ? scrubbed : null);
      });
      document.body.appendChild(overlay);
    });
  }

  /* Wrap an export function that returns a string (or Promise of string).
     The wrapped function routes through the preview modal. */
  function wrapExport(fn, opts){
    return async function(...args){
      const raw = await Promise.resolve(fn.apply(this, args));
      if (!enabled || typeof raw !== "string") return raw;
      const final = await previewExport(raw, opts);
      return final;
    };
  }

  /* Style injected once. */
  function injectStyle(){
    if (document.getElementById("cm-pii-style")) return;
    const s = document.createElement("style");
    s.id = "cm-pii-style";
    s.textContent = `
      .cm-pii-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999}
      .cm-pii-modal{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:20px;max-width:700px;width:90%;max-height:80vh;display:flex;flex-direction:column;gap:10px}
      .cm-pii-modal h3{margin:0;font-size:14px}
      .cm-pii-summary{display:flex;gap:6px;flex-wrap:wrap}
      .cm-pii-hint{font-size:12px;color:var(--muted)}
      .cm-pii-preview{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow:auto;white-space:pre-wrap;word-break:break-all;max-height:40vh}
      .cm-pii-actions{display:flex;justify-content:flex-end;gap:8px}
    `;
    document.head.appendChild(s);
  }
  injectStyle();

  window.ClaudeMeter.pii = { scrub, previewExport, wrapExport, isEnabled, setEnabled };

  /* Auto-wrap csvExport if present. */
  function tryWrapCsvExport(){
    const ce = window.ClaudeMeter && window.ClaudeMeter.csvExport;
    if (!ce || ce.__piiWrapped) return;
    ["exportCSV","exportJSON","exportMD","export"].forEach(k=>{
      if (typeof ce[k] === "function"){
        const orig = ce[k];
        ce[k] = wrapExport(orig);
      }
    });
    ce.__piiWrapped = true;
  }
  // Attempt now + later in case csvExport loads after.
  tryWrapCsvExport();
  setTimeout(tryWrapCsvExport, 500);
  setTimeout(tryWrapCsvExport, 2000);
})();
