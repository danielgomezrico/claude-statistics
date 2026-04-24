/*
 * saved-views.js — A21 Named saved views.
 * Save / load named views in localStorage cm.views.<name>, storing the
 * URL-hash state from window.ClaudeMeter.urlHash.
 *
 * UI:
 *   - [Save view] button in hero share strip.
 *   - [Load view ▾] dropdown in Zone G card.
 *
 * Public API: window.ClaudeMeter.savedViews = { save, load, list, remove }
 */
(function(){
  "use strict";
  window.ClaudeMeter = window.ClaudeMeter || {};

  var KEY_PREFIX = "cm.views.";

  function list(){
    var out = [];
    try {
      for (var i=0;i<localStorage.length;i++){
        var k = localStorage.key(i);
        if (k && k.indexOf(KEY_PREFIX) === 0){
          out.push({ name: k.slice(KEY_PREFIX.length), key: k });
        }
      }
    } catch(e){}
    out.sort(function(a,b){ return a.name<b.name?-1:1; });
    return out;
  }

  function currentHashState(){
    try {
      if (window.ClaudeMeter.urlHash && window.ClaudeMeter.urlHash.read){
        return window.ClaudeMeter.urlHash.read();
      }
    } catch(e){}
    var h = window.location.hash || "";
    return { __raw: h.replace(/^#/, "") };
  }

  function save(name){
    name = (name || "").trim();
    if (!name) return false;
    var state = currentHashState();
    try {
      var serialized = window.ClaudeMeter.urlHash && window.ClaudeMeter.urlHash.encode
        ? window.ClaudeMeter.urlHash.encode(state)
        : (state.__raw || "");
      localStorage.setItem(KEY_PREFIX+name, serialized);
      return true;
    } catch(e){ console.error("[savedViews] save failed", e); return false; }
  }

  function load(name){
    var raw;
    try { raw = localStorage.getItem(KEY_PREFIX+name); } catch(e){ return false; }
    if (raw == null) return false;
    history.replaceState(null, "", "#"+raw);
    // Trigger hashchange so filters re-apply.
    try { window.dispatchEvent(new HashChangeEvent("hashchange")); }
    catch(e){ window.dispatchEvent(new Event("hashchange")); }
    return true;
  }

  function remove(name){
    try { localStorage.removeItem(KEY_PREFIX+name); return true; } catch(e){ return false; }
  }

  // ----- UI ------------------------------------------------------------------
  function toast(msg){
    if (window.ClaudeMeter.exportMenu && window.ClaudeMeter.exportMenu.toast){
      window.ClaudeMeter.exportMenu.toast(msg); return;
    }
    var t = document.createElement("div"); t.className = "cm-toast show"; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function(){ if (t.parentNode) t.parentNode.removeChild(t); }, 1800);
  }

  function mountShareStripButton(){
    var strip = document.querySelector(".hero-share");
    if (!strip || strip.querySelector("#shareStripSaveView")) return;
    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "btn"; btn.id = "shareStripSaveView";
    btn.textContent = "Save view";
    btn.addEventListener("click", function(){
      var name = prompt("Save current view as:");
      if (!name) return;
      if (save(name)){ toast("View “"+name+"” saved"); refreshDropdown(); }
      else toast("Save failed.");
    });
    var settings = document.getElementById("shareStripSettings");
    if (settings) strip.insertBefore(btn, settings); else strip.appendChild(btn);
  }

  function mountZoneGCard(){
    if (document.getElementById("savedViewsCard")) return;
    var dash = document.getElementById("dash"); if (!dash) return;
    var details = document.createElement("details");
    details.className = "card";
    details.id = "savedViewsCard";
    details.innerHTML =
      '<summary>ZONE G · Saved views (A21)</summary>'+
      '<div style="padding:12px 0">'+
      '  <div class="muted" style="font-size:12px;margin-bottom:8px">Named views are stored in <code>localStorage</code> under <code>cm.views.&lt;name&gt;</code>. They restore filters via the URL hash.</div>'+
      '  <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">'+
      '    <select id="savedViewsSelect" style="min-width:200px"><option value="">(no views saved)</option></select>'+
      '    <button type="button" class="btn" id="savedViewsLoad">Load view →</button>'+
      '    <button type="button" class="btn" id="savedViewsDelete">Delete</button>'+
      '  </div>'+
      '</div>';
    // Insert near other Zone G details (after monthly summary card)
    var anchor = document.querySelector("#dash > details:last-of-type");
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(details, anchor.nextSibling);
    else dash.appendChild(details);

    var sel = details.querySelector("#savedViewsSelect");
    var btnLoad = details.querySelector("#savedViewsLoad");
    var btnDel = details.querySelector("#savedViewsDelete");

    btnLoad.addEventListener("click", function(){
      var name = sel.value;
      if (!name) { toast("Select a view first."); return; }
      if (load(name)) toast("Loaded view “"+name+"”"); else toast("Load failed.");
    });
    btnDel.addEventListener("click", function(){
      var name = sel.value;
      if (!name) { toast("Select a view first."); return; }
      if (!confirm("Delete view “"+name+"”?")) return;
      remove(name); refreshDropdown(); toast("Deleted “"+name+"”");
    });
    refreshDropdown();
  }

  function refreshDropdown(){
    var sel = document.getElementById("savedViewsSelect");
    if (!sel) return;
    var views = list();
    sel.innerHTML = "";
    if (!views.length){
      sel.innerHTML = '<option value="">(no views saved)</option>'; return;
    }
    sel.innerHTML = '<option value="">— pick a view —</option>'+
      views.map(function(v){ return '<option value="'+escapeHtml(v.name)+'">'+escapeHtml(v.name)+'</option>'; }).join("");
  }
  function escapeHtml(s){ return String(s).replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }

  function mount(){
    mountShareStripButton();
    mountZoneGCard();
  }

  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", mount);
  } else { mount(); }
  // Re-attempt on dash unhide
  setTimeout(mount, 500);
  setTimeout(mount, 2000);

  window.ClaudeMeter.savedViews = { save: save, load: load, list: list, remove: remove, mount: mount };
})();
