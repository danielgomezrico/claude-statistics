/* mobile.js — Wave 3 D3
 * Mobile-specific JS:
 *  1. Collapses filter-bar chips behind a "Filters ▾" toggle on <900px.
 *  2. Marks data tables with .cm-mobile-cards + sets data-label per cell so CSS card list works.
 *  3. Adds tap-and-hold (touchstart/touchend ~600ms) on chart <canvas> elements,
 *     opening a native <dialog> sheet with [Filter / Share PNG / Export CSV].
 *  4. No-ops on >900px viewports.
 */
(function(){
  window.ClaudeMeter = window.ClaudeMeter || {};
  var BREAKPOINT = 900;
  var HOLD_MS = 600;

  function isMobile(){ return window.matchMedia("(max-width: 899.98px)").matches; }

  // 1. Filter bar accordion --------------------------------------------------
  function installFilterAccordion(){
    var fb = document.getElementById("filterBar");
    if (!fb) return;
    if (fb.querySelector(".cm-mobile-toggle")) return;
    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "fb-chip cm-mobile-toggle";
    toggle.innerHTML = "Filters <span aria-hidden='true'>&#9662;</span>";
    fb.insertBefore(toggle, fb.firstChild);
    function syncCollapsed(){
      if (isMobile()) fb.classList.add("cm-collapsed");
      else fb.classList.remove("cm-collapsed");
    }
    toggle.addEventListener("click", function(){ fb.classList.toggle("cm-collapsed"); });
    window.addEventListener("resize", syncCollapsed);
    syncCollapsed();
  }

  // 2. Tables → card lists ---------------------------------------------------
  function tagTable(t){
    if (!t || t.classList.contains("cm-mobile-cards")) return;
    t.classList.add("cm-mobile-cards");
    var heads = [];
    var ths = t.querySelectorAll("thead th");
    ths.forEach(function(th){ heads.push((th.textContent||"").trim()); });
    var rows = t.querySelectorAll("tbody tr");
    rows.forEach(function(tr){
      var cells = tr.querySelectorAll("td");
      cells.forEach(function(td, i){ if (!td.hasAttribute("data-label")) td.setAttribute("data-label", heads[i] || ""); });
    });
  }
  function tagAllTables(){
    var ts = document.querySelectorAll("#monthTable, #projTable, table.cm-mobile-eligible");
    ts.forEach(tagTable);
  }
  // Re-tag whenever bodies change (cheap MutationObserver).
  function observeTable(t){
    if (!t || t.__cmObserved) return;
    t.__cmObserved = true;
    var mo = new MutationObserver(function(){ tagTable(t); });
    mo.observe(t, { childList: true, subtree: true });
  }

  // 3. Tap-and-hold sheet ----------------------------------------------------
  function ensureSheet(){
    var d = document.getElementById("cmTapSheet");
    if (d) return d;
    d = document.createElement("dialog");
    d.id = "cmTapSheet";
    d.innerHTML =
      '<div class="cm-sheet-head" id="cmSheetTitle">Chart actions</div>' +
      '<div class="cm-sheet-body">' +
        '<button type="button" data-act="filter">Filter to this view</button>' +
        '<button type="button" data-act="share">Share PNG</button>' +
        '<button type="button" data-act="export">Export CSV</button>' +
      '</div>' +
      '<div class="cm-sheet-foot"><button type="button" data-act="close" class="fb-chip">Close</button></div>';
    document.body.appendChild(d);
    d.addEventListener("click", function(e){
      var b = e.target.closest("button[data-act]"); if (!b) return;
      var act = b.dataset.act;
      if (act === "close") { try { d.close(); } catch(_){ d.removeAttribute("open"); } return; }
      if (act === "share") {
        var src = d.__sourceCanvas;
        if (src && src.toDataURL) {
          var url = src.toDataURL("image/png");
          var a = document.createElement("a");
          a.href = url; a.download = "claude-meter-chart.png"; a.click();
        }
      } else if (act === "export") {
        if (window.ClaudeMeter && window.ClaudeMeter.csvExport) window.ClaudeMeter.csvExport.download();
      } else if (act === "filter") {
        // Best-effort: scroll to filter bar so user can tweak filters.
        var fb = document.getElementById("filterBar");
        if (fb) fb.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      try { d.close(); } catch(_){ d.removeAttribute("open"); }
    });
    return d;
  }
  function openSheet(canvas){
    var d = ensureSheet();
    d.__sourceCanvas = canvas;
    var t = document.getElementById("cmSheetTitle");
    if (t) t.textContent = (canvas && canvas.id ? canvas.id : "Chart") + " — actions";
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
  }

  function attachHold(canvas){
    if (!canvas || canvas.__cmHold) return;
    canvas.__cmHold = true;
    var timer = null, startX = 0, startY = 0, moved = false;
    canvas.addEventListener("touchstart", function(e){
      if (!isMobile()) return;
      moved = false;
      var t = e.touches && e.touches[0]; if (!t) return;
      startX = t.clientX; startY = t.clientY;
      timer = setTimeout(function(){ if (!moved) openSheet(canvas); }, HOLD_MS);
    }, { passive: true });
    canvas.addEventListener("touchmove", function(e){
      var t = e.touches && e.touches[0]; if (!t) return;
      if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) {
        moved = true; if (timer) { clearTimeout(timer); timer = null; }
      }
    }, { passive: true });
    canvas.addEventListener("touchend", function(){ if (timer) { clearTimeout(timer); timer = null; } }, { passive: true });
    canvas.addEventListener("touchcancel", function(){ if (timer) { clearTimeout(timer); timer = null; } }, { passive: true });
  }
  function attachAllCanvases(){
    document.querySelectorAll("canvas").forEach(attachHold);
  }

  function init(){
    installFilterAccordion();
    tagAllTables();
    var mt = document.getElementById("monthTable"); if (mt) observeTable(mt);
    var pt = document.getElementById("projTable"); if (pt) observeTable(pt);
    ensureSheet();
    attachAllCanvases();
    // Re-attach when new canvases land (e.g. after dash unhide / chart re-create).
    var mo = new MutationObserver(function(){ attachAllCanvases(); tagAllTables(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.ClaudeMeter.mobile = { isMobile: isMobile, openSheet: openSheet };
})();
