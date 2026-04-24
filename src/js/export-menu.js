/*
 * export-menu.js — A22 full export menu.
 * Adds a [⋯ Export] button to the hero share strip with a dropdown:
 *   CSV · JSON · Markdown · PNG (hero) · PDF · ZIP (all of the above).
 * Vanilla-JS ZIP builder (STORED — no compression, PK 3.0.0 headers).
 * All text exports route through window.ClaudeMeter.pii.scrub() and
 * window.ClaudeMeter.redact when present.  Respects the global filter.
 *
 * Also exposes window.ClaudeMeter.zip = { build, parse } for D3.
 */
(function(){
  "use strict";
  window.ClaudeMeter = window.ClaudeMeter || {};

  // ---------- helpers --------------------------------------------------------
  function filtered(){
    var ev = (window.STATE && window.STATE.events) || [];
    if (window.ClaudeMeter.filterBar) ev = window.ClaudeMeter.filterBar.applyFilters(ev);
    return ev;
  }
  function fmt$(n){ return "$"+(n||0).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2}); }
  function fmtTok(n){ if(n>=1e9)return(n/1e9).toFixed(2)+"B"; if(n>=1e6)return(n/1e6).toFixed(2)+"M"; if(n>=1e3)return(n/1e3).toFixed(1)+"k"; return String(n||0); }
  function safeName(n){
    var s = String(n||"");
    try { if (window.ClaudeMeter.surveillance) s = window.ClaudeMeter.surveillance.anonymize(s); } catch(e){}
    try { if (window.ClaudeMeter.redact && window.ClaudeMeter.redact.applyForExport) s = window.ClaudeMeter.redact.applyForExport(s); } catch(e){}
    return s;
  }
  function scrubText(s){
    try {
      if (window.ClaudeMeter.pii && window.ClaudeMeter.pii.scrub){
        return window.ClaudeMeter.pii.scrub(s).scrubbed;
      }
    } catch(e){}
    return s;
  }
  function stamp(){ return new Date().toISOString().replace(/[:.]/g,"-").slice(0,19); }

  function toast(msg){
    var t = document.createElement("div");
    t.className = "cm-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(function(){ t.classList.add("show"); });
    setTimeout(function(){ t.classList.remove("show"); setTimeout(function(){ if (t.parentNode) t.parentNode.removeChild(t); }, 250); }, 1800);
  }

  // ---------- builders -------------------------------------------------------
  function buildCSV(ev){
    if (window.ClaudeMeter.csvExport && window.ClaudeMeter.csvExport.build){
      return window.ClaudeMeter.csvExport.build(ev);
    }
    var rows = [["timestamp_iso","session","project","model","in_tokens","out_tokens","cache_read_tokens","cache_write_tokens","cost_usd"].join(",")];
    for (var i=0;i<ev.length;i++){
      var e = ev[i];
      var p = safeName(e.project);
      rows.push([new Date(e.ts).toISOString(), e.session, '"'+p.replace(/"/g,'""')+'"', e.model, e.inTok||0, e.outTok||0, e.crTok||0, e.cwTok||0, (e.cost||0).toFixed(6)].join(","));
    }
    return rows.join("\n");
  }
  function buildJSON(ev){
    var arr = ev.map(function(e){
      return {
        ts: new Date(e.ts).toISOString(),
        session: e.session, project: safeName(e.project),
        model: e.model,
        inTok: e.inTok||0, outTok: e.outTok||0,
        crTok: e.crTok||0, cwTok: e.cwTok||0,
        cost: +(e.cost||0).toFixed(6),
      };
    });
    return JSON.stringify({
      schema:"claude-meter.events.v1",
      generatedAt: new Date().toISOString(),
      count: arr.length,
      events: arr,
    }, null, 2);
  }
  function buildMarkdown(ev){
    var totalCost = 0, msgs = ev.length;
    var byMonth = new Map(), byProj = new Map(), byModel = new Map();
    for (var i=0;i<ev.length;i++){
      var e = ev[i];
      var c = e.cost||0;
      totalCost += c;
      var d = new Date(e.ts);
      var mk = d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");
      byMonth.set(mk, (byMonth.get(mk)||0)+c);
      var pk = safeName(e.project);
      byProj.set(pk, (byProj.get(pk)||0)+c);
      byModel.set(e.model, (byModel.get(e.model)||0)+c);
    }
    var planSel = document.getElementById("plan");
    var plan = planSel ? parseFloat(planSel.value)||0 : 0;
    var lines = [];
    lines.push("# Claude Meter — Monthly Summary");
    lines.push("");
    lines.push("Generated " + new Date().toISOString() + ".");
    lines.push("");
    lines.push("## Headline");
    lines.push("");
    lines.push("- Total API-equivalent cost: **" + fmt$(totalCost) + "**");
    lines.push("- Messages: **" + msgs.toLocaleString() + "**");
    if (plan) lines.push("- Subscription: **$" + plan + "/mo** — ROI " + (plan ? (totalCost/plan).toFixed(2) : "—") + "×");
    lines.push("");
    lines.push("## By month");
    lines.push("");
    lines.push("| Month | Cost |");
    lines.push("|---|---:|");
    Array.from(byMonth.entries()).sort(function(a,b){return a[0]<b[0]?-1:1;}).forEach(function(r){
      lines.push("| "+r[0]+" | "+fmt$(r[1])+" |");
    });
    lines.push("");
    lines.push("## Top projects");
    lines.push("");
    lines.push("| Project | Cost |");
    lines.push("|---|---:|");
    Array.from(byProj.entries()).sort(function(a,b){return b[1]-a[1];}).slice(0,15).forEach(function(r){
      lines.push("| "+r[0]+" | "+fmt$(r[1])+" |");
    });
    lines.push("");
    lines.push("## By model");
    lines.push("");
    lines.push("| Model | Cost |");
    lines.push("|---|---:|");
    Array.from(byModel.entries()).sort(function(a,b){return b[1]-a[1];}).forEach(function(r){
      lines.push("| "+r[0]+" | "+fmt$(r[1])+" |");
    });
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("Generated locally by claude-meter. Data never left this browser.");
    return lines.join("\n");
  }

  // ---------- ZIP (STORED) ---------------------------------------------------
  // Tiny ZIP builder, STORED method (PK 3.0.0). Files: [{name, bytes:Uint8Array}].
  // Uses CRC32 polynomial 0xEDB88320.
  var CRC_TABLE = (function(){
    var t = new Uint32Array(256);
    for (var n=0;n<256;n++){
      var c = n;
      for (var k=0;k<8;k++) c = (c & 1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf){
    var c = 0xFFFFFFFF;
    for (var i=0;i<buf.length;i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function strToU8(s){ return new TextEncoder().encode(s); }
  function dosTime(d){
    var t = (d.getHours()<<11) | (d.getMinutes()<<5) | (Math.floor(d.getSeconds()/2));
    return t & 0xFFFF;
  }
  function dosDate(d){
    var v = ((d.getFullYear()-1980)<<9) | ((d.getMonth()+1)<<5) | d.getDate();
    return v & 0xFFFF;
  }
  function pushU16(a, v){ a.push(v & 0xFF, (v>>>8) & 0xFF); }
  function pushU32(a, v){ a.push(v & 0xFF, (v>>>8) & 0xFF, (v>>>16) & 0xFF, (v>>>24) & 0xFF); }

  function buildZIP(files){
    var now = new Date();
    var dT = dosTime(now), dD = dosDate(now);
    var localChunks = [];
    var central = [];
    var offset = 0;
    for (var i=0;i<files.length;i++){
      var f = files[i];
      var name = strToU8(f.name);
      var data = f.bytes;
      var crc = crc32(data);
      var local = [];
      pushU32(local, 0x04034b50);  // local file header sig
      pushU16(local, 20);           // version needed (2.0)
      pushU16(local, 0);            // gp flags
      pushU16(local, 0);            // method = STORED
      pushU16(local, dT);
      pushU16(local, dD);
      pushU32(local, crc);
      pushU32(local, data.length);  // compressed size = original
      pushU32(local, data.length);  // uncompressed size
      pushU16(local, name.length);
      pushU16(local, 0);            // extra
      var localHeader = new Uint8Array(local);
      var lh = new Uint8Array(localHeader.length + name.length + data.length);
      lh.set(localHeader, 0);
      lh.set(name, localHeader.length);
      lh.set(data, localHeader.length + name.length);
      localChunks.push(lh);

      var c = [];
      pushU32(c, 0x02014b50); // central sig
      pushU16(c, 20);          // version made by
      pushU16(c, 20);          // version needed
      pushU16(c, 0);           // gp flags
      pushU16(c, 0);           // method
      pushU16(c, dT);
      pushU16(c, dD);
      pushU32(c, crc);
      pushU32(c, data.length);
      pushU32(c, data.length);
      pushU16(c, name.length);
      pushU16(c, 0); // extra
      pushU16(c, 0); // comment
      pushU16(c, 0); // disk number
      pushU16(c, 0); // internal attrs
      pushU32(c, 0); // external attrs
      pushU32(c, offset);
      var ch = new Uint8Array(c.length + name.length);
      ch.set(new Uint8Array(c), 0);
      ch.set(name, c.length);
      central.push(ch);

      offset += lh.length;
    }
    var centralStart = offset;
    var totalCentral = 0;
    for (var j=0;j<central.length;j++) totalCentral += central[j].length;

    var end = [];
    pushU32(end, 0x06054b50);          // EOCD sig
    pushU16(end, 0);                    // disk
    pushU16(end, 0);                    // disk with central
    pushU16(end, files.length);         // entries on disk
    pushU16(end, files.length);         // entries total
    pushU32(end, totalCentral);
    pushU32(end, centralStart);
    pushU16(end, 0);                    // comment length
    var endU8 = new Uint8Array(end);

    var totalLen = offset + totalCentral + endU8.length;
    var out = new Uint8Array(totalLen);
    var p = 0;
    for (var k=0;k<localChunks.length;k++){ out.set(localChunks[k], p); p += localChunks[k].length; }
    for (var l=0;l<central.length;l++){ out.set(central[l], p); p += central[l].length; }
    out.set(endU8, p);
    return out;
  }

  function parseZIP(u8){
    // Find EOCD by scanning from end
    var n = u8.length;
    var eocd = -1;
    for (var i=n-22;i>=Math.max(0,n-65557);i--){
      if (u8[i]===0x50 && u8[i+1]===0x4b && u8[i+2]===0x05 && u8[i+3]===0x06){ eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Not a ZIP (EOCD missing)");
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var entries = dv.getUint16(eocd+10, true);
    var cdOffset = dv.getUint32(eocd+16, true);
    var files = [];
    var p = cdOffset;
    for (var e=0;e<entries;e++){
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p+10, true);
      var compSize = dv.getUint32(p+20, true);
      var uncSize = dv.getUint32(p+24, true);
      var nameLen = dv.getUint16(p+28, true);
      var extraLen = dv.getUint16(p+30, true);
      var commLen = dv.getUint16(p+32, true);
      var localOff = dv.getUint32(p+42, true);
      var name = new TextDecoder().decode(u8.subarray(p+46, p+46+nameLen));
      // Read local file header to find data offset
      var lhNameLen = dv.getUint16(localOff+26, true);
      var lhExtraLen = dv.getUint16(localOff+28, true);
      var dataStart = localOff + 30 + lhNameLen + lhExtraLen;
      var bytes = u8.subarray(dataStart, dataStart + compSize);
      if (method !== 0){
        // Skip non-STORED (we don't bundle deflate)
        p += 46 + nameLen + extraLen + commLen;
        continue;
      }
      files.push({ name: name, bytes: new Uint8Array(bytes) });
      p += 46 + nameLen + extraLen + commLen;
    }
    return files;
  }

  // ---------- downloads ------------------------------------------------------
  function blobDownload(blob, name){
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function(){ document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
  }

  function exportCSV(){
    var ev = filtered();
    if (!ev.length){ toast("No data to export."); return; }
    var s = scrubText(buildCSV(ev));
    blobDownload(new Blob([s], {type:"text/csv;charset=utf-8"}), "claude-meter-"+stamp()+".csv");
    toast("CSV downloaded");
  }
  function exportJSON(){
    var ev = filtered();
    if (!ev.length){ toast("No data to export."); return; }
    var s = scrubText(buildJSON(ev));
    blobDownload(new Blob([s], {type:"application/json"}), "claude-meter-"+stamp()+".json");
    toast("JSON downloaded");
  }
  function exportMarkdown(){
    var ev = filtered();
    if (!ev.length){ toast("No data to export."); return; }
    var s = scrubText(buildMarkdown(ev));
    blobDownload(new Blob([s], {type:"text/markdown"}), "claude-meter-"+stamp()+".md");
    toast("Markdown downloaded");
  }
  function exportPNG(){
    if (window.ClaudeMeter.heroPng && window.ClaudeMeter.heroPng.exportHero){
      window.ClaudeMeter.heroPng.exportHero();
      toast("Hero PNG downloaded");
    } else {
      toast("PNG exporter not loaded.");
    }
  }
  function exportPDF(){
    // Inject print stylesheet ad-hoc + invoke window.print().
    if (!document.getElementById("cm-print-css")){
      var ln = document.createElement("link");
      ln.rel="stylesheet"; ln.id="cm-print-css"; ln.href="src/css/print.css"; ln.media="print";
      document.head.appendChild(ln);
    }
    toast("Use the system print dialog → Save as PDF");
    setTimeout(function(){ try { window.print(); } catch(e){} }, 200);
  }
  function exportZIP(){
    var ev = filtered();
    if (!ev.length){ toast("No data to export."); return; }
    var files = [
      { name: "events.csv",        bytes: strToU8(scrubText(buildCSV(ev))) },
      { name: "events.json",       bytes: strToU8(scrubText(buildJSON(ev))) },
      { name: "monthly_summary.md",bytes: strToU8(scrubText(buildMarkdown(ev))) },
      { name: "README.txt",        bytes: strToU8("Claude Meter export — generated " + new Date().toISOString() + "\nAll data is local to your browser. PII/keys scrubbed by pii-scrubber.\n") },
    ];
    var u8 = buildZIP(files);
    blobDownload(new Blob([u8], {type:"application/zip"}), "claude-meter-"+stamp()+".zip");
    toast("ZIP downloaded");
  }

  // ---------- UI -------------------------------------------------------------
  function buildMenu(){
    var wrap = document.createElement("span");
    wrap.className = "cm-export-wrap";
    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "btn"; btn.id = "shareStripExportBtn";
    btn.setAttribute("aria-haspopup","menu"); btn.setAttribute("aria-expanded","false");
    btn.textContent = "⋯ Export";
    var menu = document.createElement("div");
    menu.className = "cm-export-menu"; menu.setAttribute("role","menu");
    var items = [
      { k:"csv", label:"CSV", fn: exportCSV },
      { k:"json", label:"JSON", fn: exportJSON },
      { k:"md", label:"Markdown", fn: exportMarkdown },
      { type:"div" },
      { k:"png", label:"PNG (hero)", fn: exportPNG },
      { k:"pdf", label:"PDF (print)", fn: exportPDF },
      { type:"div" },
      { k:"zip", label:"ZIP (all)", fn: exportZIP },
    ];
    items.forEach(function(it){
      if (it.type === "div"){
        var d = document.createElement("div"); d.className = "cm-export-divider";
        menu.appendChild(d); return;
      }
      var b = document.createElement("button");
      b.type="button"; b.className="cm-export-item"; b.setAttribute("role","menuitem");
      b.innerHTML = '<span>'+it.label+'</span><span class="cm-export-key">'+it.k+'</span>';
      b.addEventListener("click", function(){ closeMenu(); try { it.fn(); } catch(e){ console.error("[export]",e); toast("Export failed."); } });
      menu.appendChild(b);
    });
    function openMenu(){ menu.classList.add("open"); btn.setAttribute("aria-expanded","true"); }
    function closeMenu(){ menu.classList.remove("open"); btn.setAttribute("aria-expanded","false"); }
    btn.addEventListener("click", function(e){
      e.stopPropagation();
      if (menu.classList.contains("open")) closeMenu(); else openMenu();
    });
    document.addEventListener("click", function(e){ if (!wrap.contains(e.target)) closeMenu(); });
    document.addEventListener("keydown", function(e){ if (e.key === "Escape") closeMenu(); });
    wrap.appendChild(btn); wrap.appendChild(menu);
    return wrap;
  }

  function mount(){
    var strip = document.querySelector(".hero-share");
    if (!strip || strip.querySelector("#shareStripExportBtn")) return;
    var settingsBtn = document.getElementById("shareStripSettings");
    var node = buildMenu();
    if (settingsBtn) strip.insertBefore(node, settingsBtn);
    else strip.appendChild(node);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else { mount(); }

  window.ClaudeMeter.exportMenu = {
    mount: mount,
    csv: exportCSV, json: exportJSON, md: exportMarkdown,
    png: exportPNG, pdf: exportPDF, zip: exportZIP,
    toast: toast,
  };
  window.ClaudeMeter.zip = { build: buildZIP, parse: parseZIP, crc32: crc32 };
})();
