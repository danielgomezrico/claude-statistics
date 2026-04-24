/*
 * team-zip-merge.js — F22 Engineer-controlled sanitized team extract.
 * Drop multiple .zip / .json engineer exports here, merge into one dataset
 * with stable engineer anonymization (window.ClaudeMeter.surveillance),
 * download sanitized_team.json.
 *
 * Mounts a Zone G <details> drag-drop card.
 *
 * Public API: window.ClaudeMeter.teamZipMerge = { mount, ingestFiles }
 */
(function(){
  "use strict";
  window.ClaudeMeter = window.ClaudeMeter || {};

  function el(tag, cls, txt){ var e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }

  function readFileAsArrayBuffer(file){
    return new Promise(function(res, rej){
      var r = new FileReader();
      r.onload = function(){ res(r.result); };
      r.onerror = function(){ rej(r.error); };
      r.readAsArrayBuffer(file);
    });
  }
  function readFileAsText(file){
    return new Promise(function(res, rej){
      var r = new FileReader();
      r.onload = function(){ res(r.result); };
      r.onerror = function(){ rej(r.error); };
      r.readAsText(file);
    });
  }

  function detectEngineerName(events){
    var re = /\/(?:Users|home)\/([^/\s]+)/;
    for (var i=0;i<events.length;i++){
      var cwd = events[i] && events[i].cwd;
      if (cwd){ var m = cwd.match(re); if (m && m[1] && m[1] !== "REDACTED") return m[1]; }
    }
    return null;
  }

  function extractEvents(parsed){
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.events)) return parsed.events;
    return [];
  }

  function anonymizeEvent(e, label){
    // Replace engineer-name in cwd with the assigned label.
    var clone = Object.assign({}, e);
    if (clone.cwd){
      clone.cwd = String(clone.cwd).replace(/\/(Users|home)\/[^/\s]+/, "/$1/"+label);
    }
    clone.engineer = label;
    return clone;
  }

  async function processFile(file){
    var name = (file.name || "").toLowerCase();
    var events = [];
    if (name.endsWith(".json")){
      var txt = await readFileAsText(file);
      try { events = extractEvents(JSON.parse(txt)); } catch(e){ console.warn("[teamZip] bad JSON", file.name, e); }
    } else if (name.endsWith(".zip")){
      var buf = await readFileAsArrayBuffer(file);
      var u8 = new Uint8Array(buf);
      var entries;
      try { entries = (window.ClaudeMeter.zip && window.ClaudeMeter.zip.parse) ? window.ClaudeMeter.zip.parse(u8) : []; }
      catch(e){ console.warn("[teamZip] zip parse failed", file.name, e); return { events:[], engineer:null, source:file.name }; }
      for (var i=0;i<entries.length;i++){
        var ent = entries[i];
        if (/\.json$/i.test(ent.name)){
          try {
            var s = new TextDecoder().decode(ent.bytes);
            var parsed = JSON.parse(s);
            var ev = extractEvents(parsed);
            events = events.concat(ev);
          } catch(err){ console.warn("[teamZip] bad json in zip", ent.name, err); }
        }
      }
    }
    var engineer = detectEngineerName(events);
    return { events: events, engineer: engineer, source: file.name };
  }

  async function ingestFiles(files){
    if (!files || !files.length) return null;
    var results = [];
    for (var i=0;i<files.length;i++){
      try { results.push(await processFile(files[i])); }
      catch(e){ console.warn("[teamZip] processFile error", files[i].name, e); }
    }
    // Build engineer roster sorted by stable hash via surveillance module
    var engineers = results.map(function(r){ return r.engineer || ("file:"+r.source); });
    var surveillance = window.ClaudeMeter.surveillance;
    var labels = {};
    if (surveillance){
      // Force enable + assign
      try { surveillance.enable(); } catch(e){}
      // Inject events to seed assignment, then anonymize each engineer
      var seedEvents = [];
      results.forEach(function(r){ r.events.forEach(function(e){ if (e.cwd) seedEvents.push({cwd:e.cwd}); }); });
      try { surveillance.detectFromEvents(seedEvents); } catch(e){}
      engineers.forEach(function(name){ labels[name] = surveillance.anonymize(name); });
    } else {
      engineers.forEach(function(name, i){ labels[name] = "engineer-"+String.fromCharCode(97+i); });
    }

    var merged = [];
    var sources = [];
    results.forEach(function(r){
      var name = r.engineer || ("file:"+r.source);
      var label = labels[name] || ("engineer-"+(sources.length));
      sources.push({ source:r.source, engineer_label:label, count:r.events.length });
      r.events.forEach(function(e){ merged.push(anonymizeEvent(e, label)); });
    });

    var out = {
      schema: "claude-meter.team.v1",
      generatedAt: new Date().toISOString(),
      sources: sources,
      count: merged.length,
      events: merged,
    };
    var json = JSON.stringify(out, null, 2);
    if (window.ClaudeMeter.pii && window.ClaudeMeter.pii.scrub){
      try { json = window.ClaudeMeter.pii.scrub(json).scrubbed; } catch(e){}
    }
    var blob = new Blob([json], {type:"application/json"});
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = "sanitized_team.json";
    document.body.appendChild(a); a.click();
    setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
    return out;
  }

  function buildCard(){
    var details = el("details","card");
    details.id = "teamZipMerge";
    var summary = el("summary", null, "ZONE G · Team sanitized merge (F22)");
    details.appendChild(summary);

    var inner = el("div");
    inner.style.padding = "12px 0";
    inner.innerHTML =
      '<div class="muted" style="font-size:12px;margin-bottom:10px">Engineer-controlled. Drag multiple <code>.zip</code> or <code>.json</code> exports here. Names get stable <code>engineer-a/b/…</code> labels (anti-surveillance default). Output is downloaded locally as <code>sanitized_team.json</code> — nothing leaves the browser.</div>'+
      '<div id="teamZipDrop" class="drop" style="padding:24px;cursor:pointer">'+
      '  <strong>Drop .zip / .json team exports here</strong>'+
      '  <div class="muted" style="margin-top:6px;font-size:12px">or click to choose files</div>'+
      '  <input type="file" id="teamZipFiles" multiple accept=".zip,.json" style="display:none" />'+
      '</div>'+
      '<div id="teamZipStatus" class="muted" style="margin-top:8px;font-size:12px"></div>';
    details.appendChild(inner);
    return details;
  }

  function wireDrop(root){
    var drop = root.querySelector("#teamZipDrop");
    var input = root.querySelector("#teamZipFiles");
    var status = root.querySelector("#teamZipStatus");
    if (!drop || !input || !status) return;
    drop.addEventListener("click", function(e){ e.stopPropagation(); input.click(); });
    input.addEventListener("change", async function(e){
      e.stopPropagation();
      var fs = [].slice.call(e.target.files);
      await runIngest(fs);
    });
    ["dragenter","dragover"].forEach(function(ev){ drop.addEventListener(ev, function(e){ e.preventDefault(); e.stopPropagation(); drop.classList.add("hover"); }); });
    ["dragleave","drop"].forEach(function(ev){ drop.addEventListener(ev, function(e){ e.preventDefault(); e.stopPropagation(); drop.classList.remove("hover"); }); });
    drop.addEventListener("drop", async function(e){
      var fs = [].slice.call(e.dataTransfer && e.dataTransfer.files || []);
      await runIngest(fs);
    });
    async function runIngest(fs){
      if (!fs.length) return;
      status.textContent = "Merging "+fs.length+" file(s)…";
      try {
        var out = await ingestFiles(fs);
        status.textContent = out
          ? "Merged "+out.count+" events from "+out.sources.length+" source(s) → sanitized_team.json downloaded."
          : "Nothing to merge.";
      } catch(e){
        console.error("[teamZip]", e);
        status.textContent = "Merge failed: "+(e && e.message || e);
      }
    }
  }

  function mount(){
    if (document.getElementById("teamZipMerge")) return;
    var dash = document.getElementById("dash");
    var anchor = document.querySelector("#dash > details:last-of-type");
    var card = buildCard();
    if (anchor && anchor.parentNode){
      anchor.parentNode.insertBefore(card, anchor.nextSibling);
    } else if (dash){
      dash.appendChild(card);
    } else {
      // Defer mount until dash exists.
      var t = setInterval(function(){
        if (document.getElementById("dash")){
          clearInterval(t);
          mount();
        }
      }, 500);
      return;
    }
    wireDrop(card);
  }

  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", mount);
  } else { mount(); }

  window.ClaudeMeter.teamZipMerge = { mount: mount, ingestFiles: ingestFiles };
})();
