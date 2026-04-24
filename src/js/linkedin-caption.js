/*
 * linkedin-caption.js — F17 Pre-filled LinkedIn caption suggestion.
 * Deterministic templates, NO LLM. Tone follows narrative report 05:
 * data-confident, non-judgmental, no emoji, no shaming.
 *
 * Template:
 *   "I just crossed $X in Claude Code usage this month on my $Y/mo plan
 *    — {Z}× ROI. Screenshot: claude-meter (github link)"
 *
 * Respects redact (when on, replaces $ amount with "a generous amount").
 *
 * Public API: window.ClaudeMeter.linkedinCaption = { build, copy }
 */
(function(){
  "use strict";
  window.ClaudeMeter = window.ClaudeMeter || {};

  var GH = "github.com/danielgomezrico/claude-statistics";

  function fmt$(n){ return "$"+(n||0).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2}); }
  function planName(p){
    if (p === 20) return "Pro";
    if (p === 100) return "Max 5×";
    if (p === 200) return "Max 20×";
    return p ? "$"+p+"/mo" : "API-only";
  }

  function compute(){
    var ev = (window.STATE && window.STATE.events) || [];
    if (window.ClaudeMeter.filterBar) ev = window.ClaudeMeter.filterBar.applyFilters(ev);
    var now = new Date();
    var mStart = new Date(now.getFullYear(), now.getMonth(), 1);
    var mCost = 0;
    for (var i=0;i<ev.length;i++){ if (ev[i].ts >= mStart) mCost += ev[i].cost||0; }
    var planSel = document.getElementById("plan");
    var plan = planSel ? parseFloat(planSel.value)||0 : 0;
    return { mCost: mCost, plan: plan };
  }

  function redactOn(){
    try { return !!(window.ClaudeMeter.redact && window.ClaudeMeter.redact.getExport && window.ClaudeMeter.redact.getExport()); } catch(e){}
    try { return !!(window.ClaudeMeter.redact && window.ClaudeMeter.redact.isEnabled && window.ClaudeMeter.redact.isEnabled()); } catch(e){}
    return false;
  }

  function build(){
    var r = compute();
    var redact = redactOn();
    var amount = redact ? "a generous amount" : fmt$(r.mCost);
    var roi = (r.plan && r.plan > 0) ? (r.mCost / r.plan).toFixed(1) : null;

    if (!r.plan){
      return "I just crossed " + amount + " in Claude Code usage this month — running API-only. Numbers from claude-meter (" + GH + ").";
    }
    if (roi){
      var month = new Date().toLocaleDateString(undefined,{month:"long",year:"numeric"});
      return "I just crossed " + amount + " in Claude Code usage this " + month + " on my $"+ r.plan +"/mo plan ("+ planName(r.plan) +") — " + roi + "× ROI. Screenshot from claude-meter (" + GH + ").";
    }
    return "I just crossed " + amount + " in Claude Code usage this month — claude-meter (" + GH + ").";
  }

  function copy(){
    var caption = build();
    var done = function(){
      if (window.ClaudeMeter.exportMenu && window.ClaudeMeter.exportMenu.toast){
        window.ClaudeMeter.exportMenu.toast("Caption copied");
      } else {
        var t = document.createElement("div"); t.className="cm-toast show"; t.textContent="Caption copied";
        document.body.appendChild(t); setTimeout(function(){ if (t.parentNode) t.parentNode.removeChild(t); }, 1800);
      }
    };
    var fail = function(){
      // Fallback: show prompt with selectable text
      window.prompt("Copy caption manually:", caption);
    };
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(caption).then(done).catch(function(){
        try {
          var ta = document.createElement("textarea"); ta.value = caption;
          ta.style.position="fixed"; ta.style.opacity="0";
          document.body.appendChild(ta); ta.select(); document.execCommand("copy");
          document.body.removeChild(ta); done();
        } catch(e){ fail(); }
      });
    } else {
      try {
        var ta2 = document.createElement("textarea"); ta2.value = caption;
        ta2.style.position="fixed"; ta2.style.opacity="0";
        document.body.appendChild(ta2); ta2.select(); document.execCommand("copy");
        document.body.removeChild(ta2); done();
      } catch(e){ fail(); }
    }
  }

  function mount(){
    var strip = document.querySelector(".hero-share");
    if (!strip || strip.querySelector("#linkedinCaptionBtn")) return;
    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "btn"; btn.id = "linkedinCaptionBtn";
    btn.textContent = "📋 LinkedIn caption";
    btn.title = "Copy a deterministic caption (no LLM)";
    btn.addEventListener("click", copy);
    var settings = document.getElementById("shareStripSettings");
    if (settings) strip.insertBefore(btn, settings); else strip.appendChild(btn);
  }

  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", mount);
  } else { mount(); }
  setTimeout(mount, 500);

  window.ClaudeMeter.linkedinCaption = { build: build, copy: copy, mount: mount };
})();
