(function(){
  "use strict";
  window.ClaudeMeter = window.ClaudeMeter || {};

  // Robust fullscreen: instead of promoting a card in-place with position:fixed
  // (which breaks whenever an ancestor has transform/filter/overflow and becomes
  // the containing block), we MOVE the card into a body-level overlay. A body
  // child cannot be trapped by any ancestor, so the modal always fills the viewport.
  // Styles are self-injected so this never depends on stylesheet load order.

  var overlay = null;        // .fs-overlay (fixed, body-level)
  var wrap = null;           // .fs-overlay-wrap (flex host)
  var current = null;        // the card currently in fullscreen
  var placeholder = null;    // comment node marking the card's original DOM slot
  var lastToggleAt = 0;

  function ensureStyles(){
    if (document.getElementById("fs-styles")) return;
    var css = [
      ".fs-overlay{position:fixed;inset:0;z-index:99999;display:flex;box-sizing:border-box;",
        "padding:2.4vh 2.4vw;background:rgba(3,5,8,.86);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);}",
      ".fs-overlay-wrap{flex:1 1 auto;display:flex;min-width:0;min-height:0;}",
      ".fs-overlay .card{flex:1 1 auto!important;display:flex!important;flex-direction:column!important;",
        "min-width:0;min-height:0;width:100%!important;height:100%!important;max-width:none!important;",
        "max-height:none!important;margin:0!important;position:relative;overflow:auto;",
        "border-radius:14px;box-shadow:0 24px 70px rgba(0,0,0,.6);}",
      // the diagram mount wrapper (cstl/helix/tflow/universe) must become a flex column so the stage can grow
      ".fs-overlay .cstl,.fs-overlay .helix,.fs-overlay .tflow,.fs-overlay .universe{",
        "display:flex!important;flex-direction:column!important;flex:1 1 auto!important;min-height:0!important;}",
      // the WebGL stage fills the remaining height
      ".fs-overlay .cstl-stage,.fs-overlay .helix-stage,.fs-overlay .tflow-stage,",
      ".fs-overlay .universe-stage,.fs-overlay .pcity-stage{",
        "flex:1 1 auto!important;min-height:0!important;height:auto!important;}",
      ".fs-overlay canvas{max-height:none!important;}",
      "body.fs-open{overflow:hidden!important;}",
      ".fs-toggle{position:absolute;top:10px;right:10px;z-index:100000;width:30px;height:30px;",
        "display:inline-flex;align-items:center;justify-content:center;border-radius:8px;",
        "border:1px solid var(--border,#2a2f3a);background:var(--panel,#12151c);color:var(--text,#e6e8ee);",
        "cursor:pointer;font-size:15px;line-height:1;padding:0;}",
      ".fs-toggle:hover{border-color:#6ea8ff88;color:#fff;}"
    ].join("");
    var st = document.createElement("style");
    st.id = "fs-styles";
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  function getCard(el){
    return (el && el.closest) ? el.closest(".card.big, section.card.big, .card") : el;
  }

  function injectButton(card){
    if (!card) return;
    // direct-child toggle only (don't count a nested card's button)
    for (var i=0;i<card.children.length;i++){ if (card.children[i].classList && card.children[i].classList.contains("fs-toggle")) return; }
    if (getComputedStyle(card).position === "static") card.style.position = "relative";

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fs-toggle";
    btn.textContent = "⛶"; // ⛶
    btn.title = "Full screen";
    btn.setAttribute("aria-label", "Full screen");
    btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", function(ev){
      ev.stopPropagation();
      ev.preventDefault();
      toggle(card);
    });
    card.appendChild(btn);

    if (!card._fsDbl){
      card._fsDbl = 1;
      card.addEventListener("dblclick", function(ev){
        if (ev.target.closest && ev.target.closest(".fs-toggle")) return;
        toggle(card);
      });
    }
  }

  function updateBtn(card, isFs){
    var b = null;
    for (var i=0;i<card.children.length;i++){ if (card.children[i].classList && card.children[i].classList.contains("fs-toggle")){ b = card.children[i]; break; } }
    if (!b) return;
    b.textContent = isFs ? "✕" : "⛶"; // ✕ / ⛶
    b.title = isFs ? "Exit full screen (Esc)" : "Full screen";
    b.setAttribute("aria-label", b.title);
    b.setAttribute("aria-expanded", isFs ? "true" : "false");
  }

  function ensureOverlay(){
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "fs-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    wrap = document.createElement("div");
    wrap.className = "fs-overlay-wrap";
    overlay.appendChild(wrap);
    // click outside the card (on the dim backdrop) closes
    overlay.addEventListener("mousedown", function(ev){
      if (ev.target === overlay || ev.target === wrap) close();
    });
  }

  function open(card){
    ensureStyles();
    ensureOverlay();
    // remember original slot
    placeholder = document.createComment("fs-slot");
    card.parentNode.insertBefore(placeholder, card);
    // move card into the overlay and mount the overlay on <body>
    wrap.appendChild(card);
    document.body.appendChild(overlay);
    document.body.classList.add("fs-open");
    card.classList.add("fs-active");
    current = card;
    updateBtn(card, true);
    try { card.focus && card.setAttribute("tabindex","-1"); card.focus(); } catch(e){}
    reflow(card);
  }

  function close(){
    if (!current) return;
    var card = current;
    card.classList.remove("fs-active");
    if (placeholder && placeholder.parentNode){
      placeholder.parentNode.insertBefore(card, placeholder);
      placeholder.parentNode.removeChild(placeholder);
    }
    placeholder = null;
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.body.classList.remove("fs-open");
    current = null;
    updateBtn(card, false);
    // let the returned-to-grid card re-fit
    reflow(card);
    var b = null;
    for (var i=0;i<card.children.length;i++){ if (card.children[i].classList && card.children[i].classList.contains("fs-toggle")){ b = card.children[i]; break; } }
    try { b && b.focus(); } catch(e){}
  }

  function toggle(card){
    if (!card) return;
    var now = Date.now();
    if (now - lastToggleAt < 300) return; // debounce double-clicks
    lastToggleAt = now;
    if (current === card) { close(); return; }
    if (current) close();
    open(card);
  }

  // Resize the diagram after layout settles at several points, so its camera
  // re-fits to the FINAL modal size (and again to the grid size on exit).
  function reflow(card){
    function fire(){ triggerResize(card); }
    requestAnimationFrame(function(){ requestAnimationFrame(fire); });
    setTimeout(fire, 120);
    setTimeout(fire, 340);
    setTimeout(fire, 680);
  }

  function triggerResize(card){
    if (!card) return;
    var evts = (window.STATE && window.STATE.events) || [];
    var CM = window.ClaudeMeter || {};
    function go(api){ if (api){ if (api.resize) api.resize(); else if (api.render) api.render(evts); } }
    if (card.id === "universeCard" || card.querySelector("#threeUniverse")) go(CM.threeUniverse);
    if (card.id === "constellationCard" || card.querySelector("#threeConstellation")) go(CM.threeConstellation);
    if (card.id === "threeHelixCard" || card.querySelector("#threeHelix")) go(CM.threeHelix);
    if (card.id === "threeFlowCard" || card.querySelector("#threeFlow")) go(CM.threeFlow);
    if (card.id === "pricingCityCard" || card.querySelector("#pricingCity")) go(CM.pricingCity);
    window.dispatchEvent(new Event("resize"));
  }

  function onKey(e){
    if (e.key === "Escape" && current){ close(); e.preventDefault(); }
  }

  function enhanceAll(){
    ensureStyles();
    var cards = document.querySelectorAll(".card.big, section.card.big, .card");
    for (var i=0;i<cards.length;i++){
      var c = cards[i];
      if (c.classList.contains("kpi")) continue;
      injectButton(c);
    }
  }

  // public API (used by inline enhance() calls + dynamic cards)
  window.ClaudeMeter.fullscreen = {
    enhance: function(el){ var t = getCard(el); if (t) injectButton(t); },
    toggle:  function(el){ var t = getCard(el); if (t) toggle(t); },
    exit:    function(){ if (current) close(); }
  };

  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", enhanceAll);
  } else {
    enhanceAll();
  }
  document.addEventListener("keydown", onKey, {passive:false});

  // catch late-mounted cards (3D mounts, roi, sunburst, etc.)
  setTimeout(enhanceAll, 1800);
  window.addEventListener("recompute", enhanceAll, {passive:true});
})();
