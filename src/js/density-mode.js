/* density-mode.js — Wave 3 D2 / §8.3
 * Three modes: comfortable | dense | compact, persisted in localStorage cm.density.
 * Sets a class on <html>; mounts a chip in the filter bar (right side).
 * Public API: window.ClaudeMeter.density = { get(), set(mode), mountChip(container) }
 */
(function(){
  window.ClaudeMeter = window.ClaudeMeter || {};
  var KEY = "cm.density";
  var MODES = ["comfortable","dense","compact"];
  var LABEL = { comfortable: "Comfortable", dense: "Dense", compact: "Compact" };

  function get(){
    try { var v = localStorage.getItem(KEY); if (MODES.indexOf(v) >= 0) return v; } catch(e){}
    return "comfortable";
  }
  function apply(mode){
    var html = document.documentElement;
    MODES.forEach(function(m){ html.classList.remove("density-"+m); });
    html.classList.add("density-"+mode);
  }
  function set(mode){
    if (MODES.indexOf(mode) < 0) mode = "comfortable";
    try { localStorage.setItem(KEY, mode); } catch(e){}
    apply(mode);
    if (chipEl) chipEl.textContent = "Density: " + LABEL[mode];
    if (menuEl) {
      var btns = menuEl.querySelectorAll("button");
      btns.forEach(function(b){ b.classList.toggle("active", b.dataset.mode === mode); });
    }
  }

  var chipEl = null, menuEl = null;

  function buildMenu(){
    var wrap = document.createElement("div");
    wrap.className = "cm-density-menu";
    MODES.forEach(function(m){
      var b = document.createElement("button");
      b.type = "button"; b.dataset.mode = m; b.textContent = LABEL[m];
      if (m === get()) b.classList.add("active");
      b.addEventListener("click", function(){
        set(m);
        closeMenu();
      });
      wrap.appendChild(b);
    });
    return wrap;
  }
  function closeMenu(){
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
  }
  function openMenu(){
    closeMenu();
    menuEl = document.createElement("div");
    menuEl.className = "fb-menu";
    menuEl.appendChild(buildMenu());
    document.body.appendChild(menuEl);
    var r = chipEl.getBoundingClientRect();
    menuEl.style.left = Math.max(8, r.right - 200) + "px";
    menuEl.style.top = (r.bottom + window.scrollY + 4) + "px";
    setTimeout(function(){
      document.addEventListener("click", docClick, { once: true });
    }, 0);
    function docClick(e){
      if (menuEl && (menuEl.contains(e.target) || (chipEl && chipEl.contains(e.target)))) {
        document.addEventListener("click", docClick, { once: true });
        return;
      }
      closeMenu();
    }
  }

  function mountChip(container){
    if (!container) {
      container = document.getElementById("filterBar");
    }
    if (!container) return;
    if (chipEl && chipEl.parentNode) chipEl.parentNode.removeChild(chipEl);
    chipEl = document.createElement("button");
    chipEl.type = "button";
    chipEl.className = "fb-chip density-chip";
    chipEl.textContent = "Density: " + LABEL[get()];
    chipEl.style.marginLeft = "auto";
    chipEl.addEventListener("click", openMenu);
    container.appendChild(chipEl);
  }

  // Apply persisted mode immediately so first paint is correct.
  apply(get());

  window.ClaudeMeter.density = { get: get, set: set, mountChip: mountChip, MODES: MODES };
})();
