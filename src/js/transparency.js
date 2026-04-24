/*
 * transparency.js — A23 "What's tracked" right-slide drawer.
 * Three tabs: Fields read · Fields written · Outbound requests (= zero).
 * Triggers: footer link [What's tracked], [?] keyboard shortcut.
 *
 * Public API: window.ClaudeMeter.transparency = { open, close, toggle }.
 */
(function(){
  "use strict";
  window.ClaudeMeter = window.ClaudeMeter || {};

  // -- Static manifest. Mirrors what extractEvent() reads + localStorage usage.
  var FIELDS_READ = [
    { key:"timestamp / createdAt", note:"Event timestamp (ISO or ms)" },
    { key:"message.usage.input_tokens", note:"Input token count" },
    { key:"message.usage.output_tokens", note:"Output token count" },
    { key:"message.usage.cache_read_input_tokens", note:"Cache hits (no charge)" },
    { key:"message.usage.cache_creation_input_tokens", note:"Cache writes (1.25× premium)" },
    { key:"message.model / model", note:"Model id (used for pricing match)" },
    { key:"message.content[].type=='tool_use'", note:"Tool-use names + counts (Zone D)" },
    { key:"message.stop_reason", note:"end_turn / max_tokens / error" },
    { key:"sessionId / session_id", note:"Group events into sessions" },
    { key:"cwd", note:"Working dir (used for project attribution + engineer detection)" },
    { key:"gitBranch", note:"Branch annotation (Zone F display only)" },
    { key:"uuid / parentUuid", note:"Reconstruct sub-agent tree" },
    { key:"isSidechain", note:"Mark sub-agent calls" },
    { key:"teamName / agentName / agentId", note:"Sub-agent metadata (Zone C)" },
    { key:"file path / project folder", note:"derived from drag-dropped folder structure" },
  ];

  var FIELDS_WRITTEN = [
    { key:"localStorage cm.theme", note:"Theme preference (light/dark)" },
    { key:"localStorage cm.pii.enabled", note:"PII scrubber on/off" },
    { key:"localStorage cm.redact.ui", note:"Project-name redaction (UI)" },
    { key:"localStorage cm.redact.export", note:"Project-name redaction (export-default-on)" },
    { key:"localStorage cm.surveillance.enabled", note:"Engineer-name anonymization" },
    { key:"localStorage cm.attribution.rules", note:"cwd-regex attribution rules" },
    { key:"localStorage cm.views.<name>", note:"Saved named views (URL-hash blobs)" },
    { key:"localStorage cm.linkedin.style", note:"LinkedIn caption template choice" },
    { key:"window.location.hash", note:"Filter state encoded in fragment (no server)" },
  ];

  var OUTBOUND = [
    { req:"src/vendor/chart.umd.min.js", to:"same-origin" },
    { req:"src/css/*.css", to:"same-origin" },
    { req:"src/js/*.js", to:"same-origin" },
    { req:"index.html", to:"same-origin" },
  ];

  function el(tag, cls, txt){ var e = document.createElement(tag); if (cls) e.className = cls; if (txt!=null) e.textContent = txt; return e; }

  function buildDrawer(){
    if (document.getElementById("cmTransOverlay")) return;
    var ov = el("div","cm-trans-overlay"); ov.id = "cmTransOverlay";
    var dr = el("div","cm-trans-drawer"); dr.id = "cmTransDrawer";
    dr.setAttribute("role","dialog"); dr.setAttribute("aria-label","What's tracked");

    var head = el("div","cm-trans-head");
    head.appendChild(el("h3", null, "What's tracked"));
    var close = el("button","cm-trans-close"); close.innerHTML = "&times;";
    close.setAttribute("aria-label","Close drawer");
    close.addEventListener("click", api.close);
    head.appendChild(close);
    dr.appendChild(head);

    var tabs = el("div","cm-trans-tabs");
    ["Fields read","Fields written","Outbound = 0"].forEach(function(name, i){
      var t = el("button","cm-trans-tab"+(i===0?" active":""), name);
      t.dataset.tabIdx = String(i);
      t.addEventListener("click", function(){ selectTab(i); });
      tabs.appendChild(t);
    });
    dr.appendChild(tabs);

    var body = el("div","cm-trans-body"); body.id = "cmTransBody";
    dr.appendChild(body);

    var foot = el("div","cm-trans-foot");
    foot.innerHTML = 'Verify yourself: open DevTools → Network → hard reload. Outbound to non-same-origin must be empty. <a href="SECURITY.md#fields-read" target="_blank" rel="noopener" style="color:var(--accent)">SECURITY.md →</a>';
    dr.appendChild(foot);

    document.body.appendChild(ov);
    document.body.appendChild(dr);
    ov.addEventListener("click", api.close);

    selectTab(0);
  }

  function selectTab(idx){
    var tabs = document.querySelectorAll(".cm-trans-tab");
    tabs.forEach(function(t,i){ t.classList.toggle("active", i===idx); });
    var body = document.getElementById("cmTransBody");
    if (!body) return;
    body.innerHTML = "";
    if (idx === 0) renderRead(body);
    else if (idx === 1) renderWritten(body);
    else renderOutbound(body);
  }

  function renderRead(body){
    body.appendChild(el("p", null, "Claude Meter parses your local JSONL files and reads only these JSON fields. Nothing is uploaded."));
    var ul = document.createElement("ul");
    FIELDS_READ.forEach(function(f){
      var li = document.createElement("li");
      li.innerHTML = "<code>"+f.key+"</code> — <span class=\"muted\">"+f.note+"</span>";
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }
  function renderWritten(body){
    body.appendChild(el("p", null, "These are the only persistent writes. All can be cleared via DevTools → Application → Local Storage → Clear."));
    var ul = document.createElement("ul");
    FIELDS_WRITTEN.forEach(function(f){
      var li = document.createElement("li");
      li.innerHTML = "<code>"+f.key+"</code> — <span class=\"muted\">"+f.note+"</span>";
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }
  function renderOutbound(body){
    var p = el("p"); p.innerHTML = 'Intended outbound to non-same-origin: <span class="cm-trans-zero">0</span>'; body.appendChild(p);
    body.appendChild(el("p", null, "All assets are served from the same origin as index.html (file:// or your GitHub Pages domain)."));
    var ul = document.createElement("ul");
    OUTBOUND.forEach(function(r){
      var li = document.createElement("li");
      li.innerHTML = "<code>"+r.req+"</code> → "+r.to;
      ul.appendChild(li);
    });
    body.appendChild(ul);
    body.appendChild(el("h4", null, "How to verify"));
    var ol = document.createElement("ol");
    ["Open DevTools → Network","Hard reload (Cmd/Ctrl+Shift+R)","Filter by 'Other origins' — must be empty","Drop JSONL — network stays silent"].forEach(function(s){
      var li = document.createElement("li"); li.textContent = s; ol.appendChild(li);
    });
    body.appendChild(ol);
  }

  var api = {
    open: function(){
      buildDrawer();
      var ov = document.getElementById("cmTransOverlay");
      var dr = document.getElementById("cmTransDrawer");
      if (ov) ov.classList.add("open");
      if (dr) dr.classList.add("open");
    },
    close: function(){
      var ov = document.getElementById("cmTransOverlay");
      var dr = document.getElementById("cmTransDrawer");
      if (ov) ov.classList.remove("open");
      if (dr) dr.classList.remove("open");
    },
    toggle: function(){
      var dr = document.getElementById("cmTransDrawer");
      if (dr && dr.classList.contains("open")) api.close(); else api.open();
    },
  };

  function wireFooter(){
    var link = document.getElementById("whatsTrackedLink");
    if (link) link.addEventListener("click", function(e){ e.preventDefault(); api.open(); });
  }

  function wireShortcut(){
    document.addEventListener("keydown", function(e){
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey){
        var t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        e.preventDefault(); api.toggle();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function(){ wireFooter(); wireShortcut(); });
  } else { wireFooter(); wireShortcut(); }

  window.ClaudeMeter.transparency = api;
})();
