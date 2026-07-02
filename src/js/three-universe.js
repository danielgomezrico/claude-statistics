import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

(function(){
  "use strict";
  window.ClaudeMeter = window.ClaudeMeter || {};

  const COLORS = { project:0xd97757, model:0x6ea8ff, tool:0x22c55e, cache:0xeab308, era:0x64748b, link:0x475569, comet:0x86efac, dim:0x2a3142, bg:0x000000, star:0xcbd5e1, dust:0x475569, edgeLever:0x86efac, edgeOwn:0x64748b, edgeUse:0x475569 };
  const MODEL_PAL = [0x6ea8ff,0xd97757,0x22c55e,0xeab308,0xa855f7,0x06b6d4,0xef4444,0xf97316];

  let root = null, mounted = false, renderer = null, scene = null, camera = null, controls = null;
  let raf = 0, lastEvents = [], selected = null, hoverNode = null, isolated = null;
  let raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  let uGroup = null, starField = null, dusts = [], nodeMeshes = [], edgeGroup = null;
  let nodeById = {}, adj = {};
  let resizeObserver = null;
  let visObserver = null;
  // See three-constellation.js: skip per-frame work while scrolled off-screen.
  let onScreen = true;
  let pulsePhase = 0;
  let searchTerm = "";
  let lastInteract = Date.now();
  let camTarget = null, lookTarget = null;
  let legend={project:true,model:true,tool:true,cache:true};
  let ripples = [];
  let tipShown = false;
  let tourStep = -1;
  let nodes = [], links = [], graph = {};
  let connected = new Set(), matchIds = new Set();

  function fmt$(n){ return "$"+(n||0).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2}); }
  function fmtTok(n){ if(n>=1e9)return(n/1e9).toFixed(2)+"B"; if(n>=1e6)return(n/1e6).toFixed(2)+"M"; if(n>=1e3)return(n/1e3).toFixed(1)+"k"; return String(n||0); }
  function fmtInt(n){ return (n||0).toLocaleString(); }

  function displayName(raw){
    let n = raw || "unknown";
    try { const s = window.ClaudeMeter && window.ClaudeMeter.surveillance; if(s && typeof s.anonymize==="function") n = s.anonymize(n); }catch(e){}
    try { const r = window.ClaudeMeter && window.ClaudeMeter.redact; if(r && typeof r.apply==="function") n = r.apply(n); }catch(e){}
    return n;
  }
  function visibleEvents(evts){
    let o = Array.isArray(evts)?evts.slice():[];
    try{ const fb=window.ClaudeMeter&&window.ClaudeMeter.filterBar; if(fb&&typeof fb.applyFilters==="function") o=fb.applyFilters(o);}catch(e){}
    return o;
  }
  function isInternal(p){
    const core = window.ClaudeMeter && window.ClaudeMeter.parserCore;
    if(core && typeof core.isInternalAgentProject==="function") return core.isInternalAgentProject(p);
    return ["subagents",".worktree",".agents","worktree","agents"].indexOf(String(p))>=0;
  }

  function getEra(e){
    const ts = e.tsMs || (e.ts ? +new Date(e.ts) : Date.now());
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
  }

  function mount(el){
    if(!el) return;
    root = el; root.className = "universe";
    root.innerHTML =
      '<div class="universe-head">' +
        '<div class="universe-title"><h2>Usage Universe</h2><p>Orbit projects • models • tools • cache as constellations. <strong>Priya</strong> (X3 cache anxiety → permission via connections): see the bridge. <strong>Marcus</strong> (M8 outliers): find expensive clusters. <strong>David</strong> (X13): attribution at a glance.</p></div>' +
        '<div class="universe-controls">' +
          '<input type="text" placeholder="Search…" data-uni-search />'+
          '<button type="button" class="btn sm" data-uni-tour title="Fly through Priya/Marcus/David insights">20s tour</button>'+
          '<button type="button" class="btn sm" data-uni-export title="Export view PNG">PNG</button>'+
          '<button type="button" class="btn" data-uni-focus>Focus</button>'+
          '<button type="button" class="btn" data-uni-reset>Reset</button>'+
          '<button type="button" class="btn" data-uni-cache>Cache</button>'+
          '<button type="button" class="btn" data-uni-exp>$</button>'+
        '</div>'+
      '</div>'+
      '<div class="universe-stage" tabindex="0" aria-label="3D usage universe graph">'+
        '<div class="universe-empty">Load JSONL or demo data to explore the universe.</div>'+
        '<canvas class="universe-minimap" data-uni-minimap width="82" height="82"></canvas>'+
      '</div>'+
      '<div class="universe-legend"></div>'+
      '<div class="universe-tour" data-uni-tour style="display:none"><span class="tour-text"></span> <span class="tour-persona"></span> <button class="btn sm" data-tour-pause>pause</button></div>'+
      '<div class="universe-inspector"><div class="universe-panel" data-uni-inspector><h3>No selection</h3><p>Click nodes (Priya: connections relieve cache anxiety). Esc clears. Legend filters. / search. Arrows cycle.</p></div><div class="universe-bar" data-uni-bar></div></div>';

    const st = stage();
    const srch=root.querySelector("[data-uni-search]");
    if(srch){srch.addEventListener("input",()=>{searchTerm=srch.value.trim().toLowerCase(); updateHighlights();}); srch.addEventListener("keydown",e=>{if(e.key==="Enter")focusSearch();});}
    root.querySelector("[data-uni-focus]").addEventListener("click",focusSearch);
    root.querySelector("[data-uni-reset]").addEventListener("click",resetView);
    root.querySelector("[data-uni-cache]").addEventListener("click",()=>focusCluster("cache"));
    root.querySelector("[data-uni-exp]").addEventListener("click",()=>focusCluster("expensive"));
    const tourBtn=root.querySelector("[data-uni-tour]"); if(tourBtn) tourBtn.addEventListener("click",startTour);
    const expBtn=root.querySelector("[data-uni-export]"); if(expBtn) expBtn.addEventListener("click",exportPNG);
    const pauseBtn=root.querySelector("[data-tour-pause]"); if(pauseBtn) pauseBtn.addEventListener("click",toggleTourPause);

    buildLegend();
    if(st){ st.addEventListener("pointermove",onHover); st.addEventListener("pointerleave",()=>{hoverNode=null;updateHighlights();}); }
    document.addEventListener("keydown",onKey);

    mounted = true;
    resizeObserver = new ResizeObserver(()=>resize());
    resizeObserver.observe(st);
    if (typeof IntersectionObserver !== "undefined" && st){
      visObserver = new IntersectionObserver(function(entries){
        onScreen = entries[entries.length - 1].isIntersecting;
      }, { rootMargin: "200px" });
      visObserver.observe(st);
    }
    render(window.STATE && window.STATE.events ? window.STATE.events : []);
  }

  function stage(){ return root && root.querySelector(".universe-stage"); }

  function buildLegend(){
    const leg=root&&root.querySelector(".universe-legend"); if(!leg)return;
    const types=[["project","Project"],["model","Model"],["tool","Tool"],["cache","Cache"]];
    leg.innerHTML=types.map(([k,l])=>'<span class="universe-chip" data-type="'+k+'"><span class="swatch" style="background:#'+COLORS[k].toString(16).padStart(6,"0")+'"></span>'+l+'</span>').join("");
    leg.querySelectorAll(".universe-chip").forEach(ch=>{
      const k=ch.dataset.type;
      ch.classList.toggle("active",!!legend[k]);
      ch.addEventListener("click",()=>{ legend[k]=!legend[k]; ch.classList.toggle("active",legend[k]); nodeMeshes.forEach((m,i)=>{ const n=nodes[i]; if(n&&n.type!==k && !legend[k]) { if(m.scale)m.scale.setScalar(0.4); } }); setTimeout(rebuild,60); });
    });
  }

  function rebuild(){ if(lastEvents.length) render(lastEvents); }

  function initScene(){
    const host = stage();
    if(!host || renderer) return;
    if(host.clientWidth<60 || host.clientHeight<60) return;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(COLORS.bg);
    scene.fog = new THREE.Fog(COLORS.bg, 38, 92);

    camera = new THREE.PerspectiveCamera(46, host.clientWidth/host.clientHeight, 0.1, 160);
    camera.position.set(22, 11, 28);

    renderer = new THREE.WebGLRenderer({antialias:true, alpha:false, preserveDrawingBuffer:true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.innerHTML = "";
    host.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.minDistance = 4;
    controls.maxDistance = 70;

    scene.add(new THREE.HemisphereLight(0xe8f0ff, 0x11151f, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.6); sun.position.set(12,22,9); scene.add(sun);

    uGroup = new THREE.Group(); scene.add(uGroup);
    animate();
  }

  function render(evts){
    lastEvents = Array.isArray(evts)?evts:[];
    if(!mounted && document.getElementById("threeUniverse")) mount(document.getElementById("threeUniverse"));
    if(!root) return;
    const f = visibleEvents(lastEvents);
    updateStatsBar(0,0,"—");

    if(!f.length){ clearScene(); showEmpty(); return; }
    initScene();
    if(!renderer) return;
    buildUniverse(f);
    resize();
    if(controls) controls.update();
    drawMinimap();
    updateBar();
    const totalC = nodes.reduce((s,nd) => s + (nd.cost||0), 0);
    if(!selected) updateInspector(null, totalC);
    if(!tipShown && lastEvents.length){ setTimeout(showTipOnce, 1400); tipShown=true; }
  }

  function showEmpty(){
    const h = stage(); if(h) h.innerHTML = '<div class="universe-empty">Load JSONL or demo data to orbit the universe.</div>';
    if(renderer){ try{renderer.dispose();}catch(_){} renderer=scene=camera=controls=null; }
  }

  function clearScene(){
    hoverNode = null; selected = null; isolated = null;
    nodeMeshes = []; nodeById = {}; adj = {}; dusts = [];
    nodes = []; links = []; graph = {};
    connected.clear(); matchIds.clear(); hoverNode = null;
    if(starField){ scene && scene.remove(starField); disposeObject(starField); starField = null; }
    if(edgeGroup){ uGroup && uGroup.remove(edgeGroup); disposeObject(edgeGroup); edgeGroup = null; }
    if(uGroup){
      while(uGroup.children.length){ const c = uGroup.children.pop(); disposeObject(c); }
    }
    if(scene){
      dusts.forEach(d => { scene.remove(d); disposeObject(d); });
    }
  }

  function disposeObject(obj){
    obj && obj.traverse(function(ch){
      if(ch.geometry) ch.geometry.dispose();
      if(ch.material){
        const ms = Array.isArray(ch.material)?ch.material:[ch.material];
        ms.forEach(m=>{ if(m.map) m.map.dispose(); m.dispose(); });
      }
    });
  }

  function extractConcepts(evts){
    const filtered = evts.filter(e => !isInternal(e.project));
    if(!filtered.length) return {nodes:[], links:[], leverage:0, n:0, c:0};

    const projs = new Map(), sesss = new Map(), mods = new Map(), tools = new Map();
    let minT=Infinity, maxT=-Infinity, totCW=0, totCR=0, totCWc=0, totCRc=0;

    for(const e of filtered){
      const t = e.tsMs != null ? e.tsMs : (e.ts ? +new Date(e.ts) : 0);
      minT = Math.min(minT, t); maxT = Math.max(maxT, t);
      const p = e.project || "unknown";
      if(!projs.has(p)) projs.set(p, {id:"p_"+p, type:"project", label:displayName(p), val:0, tok:0, sess:new Set(), cr:0, cw:0, msgs:0});
      const pj = projs.get(p); pj.val += e.cost||0; pj.tok += (e.inTok||0)+(e.outTok||0)+(e.crTok||0)+(e.cwTok||0); pj.cr += e.crTok||0; pj.cw += e.cwTok||0; pj.msgs++; pj.sess.add(e.session);

      const sk = e.session + "|" + p;
      if(!sesss.has(sk)) sesss.set(sk, {id:"s_"+sk, type:"session", label:e.session, proj:p, val:e.cost||0, tok:(e.inTok||0)+(e.outTok||0)+(e.crTok||0)+(e.cwTok||0), cr:e.crTok||0, cw:e.cwTok||0, model:e.model||"unknown", tools:{}, ts:t});
      const ss = sesss.get(sk); ss.val += e.cost||0; ss.tok += (e.inTok||0)+(e.outTok||0)+(e.crTok||0)+(e.cwTok||0); ss.cr += e.crTok||0; ss.cw += e.cwTok||0; ss.ts = Math.min(ss.ts||t, t);
      if(e.toolCalls) for(const [tn,c] of Object.entries(e.toolCalls)){ ss.tools[tn]=(ss.tools[tn]||0)+c; tools.set(tn, (tools.get(tn)||0)+c); }

      const m = e.model || "unknown";
      if(!mods.has(m)) mods.set(m, {id:"m_"+m, type:"model", label:m, val:0, cnt:0});
      const md = mods.get(m); md.val += e.cost||0; md.cnt++;

      totCW += e.cwTok||0; totCR += e.crTok||0;
      const pr = (window.PRICING && window.PRICING.find(pp=>pp.match&&m.toLowerCase().includes(pp.match))) || {cacheWrite:3.75,cacheRead:0.3};
      totCWc += (e.cwTok||0)*pr.cacheWrite/1e6; totCRc += (e.crTok||0)*pr.cacheRead/1e6;
    }
    const rT = (maxT-minT)||1;

    let nodes = [], links = [];
    let projArr = Array.from(projs.values()).sort((a,b)=>b.val-a.val);
    if(projArr.length>9) projArr = projArr.slice(0,8).concat({id:"p_other",type:"project",label:"other",val:projArr.slice(8).reduce((s,x)=>s+x.val,0),tok:0,sess:new Set(),cr:0,cw:0});
    projArr.forEach(p => nodes.push(p));

    let sessArr = Array.from(sesss.values()).sort((a,b)=>b.val-a.val).slice(0,26);
    sessArr.forEach(s => nodes.push(s));

    Array.from(mods.values()).sort((a,b)=>b.val-a.val).forEach(m => nodes.push(m));

    let toolArr = Array.from(tools.entries()).sort((a,b)=>b[1]-a[1]).slice(0,11).map(([k,v])=>({id:"t_"+k, type:"tool", label:k, val:v, cnt:v}));
    toolArr.forEach(t => nodes.push(t));

    const lev = totCW>0 ? totCR / totCW : 0;
    const cwN = {id:"cw", type:"cacheWrite", label:"Cache Write (investment)", val:totCWc, tok:totCW};
    const crN = {id:"cr", type:"cacheRead", label:"Cache Read (savings)", val:totCRc, tok:totCR};
    if(totCW+totCR>0){ nodes.push(cwN); nodes.push(crN); }

    const projIdx = new Map(nodes.filter(n=>n.type==="project").map(n=>[n.id,n]));
    sessArr.forEach(s => {
      const match = projArr.find(pp=>pp.label===displayName(s.proj));
      const pid = match ? match.id : (projIdx.has("p_other")?"p_other":null);
      if(pid) links.push({s:pid, t:s.id, type:"owns", w:1.6});
      const mid = "m_"+s.model; if(nodes.find(nn=>nn.id===mid)) links.push({s:s.id, t:mid, type:"model", w:0.8});
      Object.keys(s.tools).slice(0,2).forEach(tn => { const tid="t_"+tn; if(nodes.find(nn=>nn.id===tid)) links.push({s:s.id, t:tid, type:"uses", w:0.6}); });
    });
    if(totCW+totCR>0){
      links.push({s:"cw", t:"cr", type:"leverage", w:Math.max(1.5, Math.min(7,lev*0.9)), label:lev.toFixed(1)+"×"});
    }
    sessArr.filter(s=>s.cw>120||s.cr>300).slice(0,5).forEach(s=>{ links.push({s:s.id, t:"cw", type:"uses", w:0.5}); links.push({s:"cr", t:s.id, type:"uses", w:0.5}); });

    const used = new Set(links.flatMap(l=>[l.s,l.t]));
    nodes = nodes.filter(n => used.has(n.id) || n.type==="project" || n.type==="cacheWrite" || n.type==="cacheRead");

    sessArr.forEach(s => { s.age = (s.ts - minT) / rT; });
    return {nodes, links, leverage:lev, n:nodes.length, c:links.length};
  }

  function doLayout(nodes, links){
    const projNs = nodes.filter(n=>n.type==="project");
    const nP = Math.max(1, projNs.length);
    projNs.forEach((p,i)=>{
      const a = (i/nP) * Math.PI*2 - 0.8;
      p.x = Math.cos(a)*13.5; p.y = (i%2-0.5)*1.4; p.z = Math.sin(a)*7.8 - 0.6;
    });
    const sessNs = nodes.filter(n=>n.type==="session");
    sessNs.forEach(s => {
      const p = projNs.find(pp => pp.id === ("p_"+s.proj) || pp.id==="p_other");
      const baseX = p ? p.x : 0, baseY=p?p.y:0, baseZ=p?p.z:0;
      const rad = 2.6 + (1 - (s.age||0.4)) * 3.8;
      const a2 = ( (s.id.charCodeAt(3)||3) % 7 - 3.5 ) * 0.9;
      s.x = baseX + Math.cos(a2)*rad;
      s.y = baseY + (Math.random()-0.5)*1.4;
      s.z = baseZ - (1-(s.age||0.5))*5.6 - 0.8;
    });
    const modNs = nodes.filter(n=>n.type==="model");
    modNs.forEach((m,i)=>{
      const a = (i/modNs.length)*Math.PI*2 + 0.4;
      m.x = Math.cos(a)*23; m.y = 5.8 + (i%2)*0.6; m.z = Math.sin(a)*6.5 + 1.5;
    });
    const toolNs = nodes.filter(n=>n.type==="tool");
    toolNs.forEach((t,i)=>{
      const a = (i/toolNs.length)*Math.PI*2 + 1.8;
      t.x = Math.cos(a)*9.5; t.y = -3.6; t.z = Math.sin(a)*5.2;
    });
    const cw = nodes.find(n=>n.id==="cw"); if(cw){ cw.x=-2.2; cw.y=1.2; cw.z=2.8; }
    const cr = nodes.find(n=>n.id==="cr"); if(cr){ cr.x=2.6; cr.y=-0.9; cr.z=3.4; }

    const pos = {}; nodes.forEach(n => { pos[n.id] = {x:n.x||0, y:n.y||0, z:n.z||0}; });
    const v = {}; nodes.forEach(n => { v[n.id]={x:0,y:0,z:0}; });
    for(let it=0; it<62; it++){
      for(let i=0;i<nodes.length;i++){
        for(let j=i+1;j<nodes.length;j++){
          const a = pos[nodes[i].id], b=pos[nodes[j].id];
          let dx=a.x-b.x, dy=a.y-b.y, dz=a.z-b.z; let d2=dx*dx+dy*dy+dz*dz+0.8;
          if(d2<26){ const f = 0.014 / d2; v[nodes[i].id].x += dx*f; v[nodes[i].id].y += dy*f; v[nodes[i].id].z += dz*f; v[nodes[j].id].x -= dx*f; v[nodes[j].id].y -= dy*f; v[nodes[j].id].z -= dz*f; }
        }
      }
      links.forEach(lk=>{
        const a=pos[lk.s], b=pos[lk.t]; if(!a||!b) return;
        let dx=b.x-a.x, dy=b.y-a.y, dz=b.z-a.z; let d=Math.sqrt(dx*dx+dy*dy+dz*dz)+0.1;
        const tgt = lk.type==="leverage" ? 5.2 : lk.type==="owns" ? 3.1 : 7.4;
        const f = (d-tgt)*0.028;
        const nx=dx/d*f, ny=dy/d*f, nz=dz/d*f;
        v[lk.s].x += nx*0.6; v[lk.s].y += ny*0.6; v[lk.s].z += nz*0.6;
        v[lk.t].x -= nx*0.6; v[lk.t].y -= ny*0.6; v[lk.t].z -= nz*0.6;
      });
      nodes.forEach(n=>{
        if(n.type!=="session") return;
        const pid = "p_"+n.proj; const pp = pos[pid] || pos["p_other"];
        if(pp){ const dx=pp.x-n.x*0.7, dy=pp.y-n.y*0.7, dz=pp.z-n.z*0.7; v[n.id].x += dx*0.008; v[n.id].y += dy*0.008; v[n.id].z += dz*0.008; }
      });
      nodes.forEach(n=>{
        const vv = v[n.id]; const pp=pos[n.id];
        pp.x += vv.x; pp.y += vv.y; pp.z += vv.z;
        vv.x *= 0.78; vv.y *=0.78; vv.z*=0.78;
        const lim=29; pp.x=Math.max(-lim,Math.min(lim,pp.x)); pp.z=Math.max(-lim,Math.min(lim,pp.z));
        if(n.type==="model") pp.y = Math.max(4.5, Math.min(9, pp.y));
      });
    }
    nodes.forEach(n=>{ const p=pos[n.id]; n.x=p.x; n.y=p.y; n.z=p.z; });
  }

  function buildUniverse(f){
    clearScene(); isolated = null;
    connected.clear();
    matchIds.clear();
    hoverNode = null;
    const data = extractConcepts(f);
    const {nodes: nlist, links: llist, leverage, n, c} = data;
    nodes = nlist || [];
    links = llist || [];
    nodes.forEach(nd => { nd.cost = nd.cost || nd.val || 0; nd.val = nd.cost; });
    if(!nodes.length){ showEmpty(); return; }
    doLayout(nodes, links);

    nodes.forEach(nd => {
      const m = makeNode(nd);
      if(!m) return;
      uGroup.add(m); nodeMeshes.push(m); nodeById[nd.id] = m;
    });
    buildStarAndDust(nodes);

    edgeGroup = makeEdges(nodes, links);
    uGroup.add(edgeGroup);

    adj = {}; links.forEach(l=>{ (adj[l.s]=adj[l.s]||[]).push(l.t); (adj[l.t]=adj[l.t]||[]).push(l.s); });

    graph = {}; nodes.forEach(nd => { graph[nd.id] = []; });
    links.forEach(l => {
      (graph[l.s] = graph[l.s] || []).push(l.t);
      (graph[l.t] = graph[l.t] || []).push(l.s);
    });

    updateStatsBar(data.n || nodes.length, data.c || links.length, leverage);
    setTimeout(()=>{ try{ fitCamera(nodes); }catch(e){} }, 60);

    const cwM = nodeById["cw"]; if(cwM) uGroup.add(labelSprite("INVEST", cwM.position.x, cwM.position.y+1.8, cwM.position.z, 1.8));
    const crM = nodeById["cr"]; if(crM) uGroup.add(labelSprite("SAVINGS", crM.position.x, crM.position.y+1.8, crM.position.z, 1.8));
  }

  function makeNode(nd){
    let sz = Math.max(0.22, Math.min(1.28, Math.log1p(nd.val||1)*0.27 ));
    const col = COLORS[nd.type]||COLORS.dim;
    let mesh;
    if(nd.type==='project'){
      mesh=new THREE.Mesh(new THREE.IcosahedronGeometry(sz*1.1,1), new THREE.MeshPhongMaterial({color:col, shininess:14, emissive:0x2a1810, emissiveIntensity:0.25}));
    }else if(nd.type==='tool'){
      mesh=new THREE.Mesh(new THREE.OctahedronGeometry(sz*0.95,0), new THREE.MeshPhongMaterial({color:col, shininess:6, emissive:0x0a2a18, emissiveIntensity:0.18}));
    }else if(nd.type==='model'){
      const g=new THREE.Group();
      const core=new THREE.Mesh(new THREE.SphereGeometry(sz*0.6,10,8), new THREE.MeshPhongMaterial({color:col, shininess:22, emissive:0x112244, emissiveIntensity:0.3}));
      const ring=new THREE.Mesh(new THREE.TorusGeometry(sz*0.92, sz*0.13,6,18), new THREE.MeshPhongMaterial({color:COLORS.era, shininess:4, opacity:0.6}));
      ring.material.transparent = true;
      ring.rotation.x=Math.PI*0.4; g.add(core); g.add(ring); mesh=g; mesh.userData={node:nd,isGroup:true};
    }else if(nd.type==='era'){
      mesh=new THREE.Mesh(new THREE.BoxGeometry(sz*2.6,0.12,sz*0.4), new THREE.MeshPhongMaterial({color:COLORS.era, shininess:2, emissive:0x222233, emissiveIntensity:0.15}));
    }else if(nd.type==='cache' || nd.type==='cacheWrite' || nd.type==='cacheRead'){
      const g=new THREE.Group();
      const s1=new THREE.Mesh(new THREE.SphereGeometry(sz,12,10), new THREE.MeshPhongMaterial({color:col, shininess:10, emissive:0x1a2a1a, emissiveIntensity:0.35}));
      const s2=new THREE.Mesh(new THREE.SphereGeometry(sz*1.25,8,6), new THREE.MeshBasicMaterial({color:col, opacity:0.18}));
      s2.material.transparent = true;
      g.add(s1); g.add(s2); mesh=g; mesh.userData={node:nd,isGroup:true};
    }else {
      mesh=new THREE.Mesh(new THREE.SphereGeometry(sz,12,10), new THREE.MeshPhongMaterial({color:col, shininess:10, emissive:0x1a2a1a, emissiveIntensity:0.35}));
    }
    if(!mesh.userData) mesh.userData={node:nd};
    mesh.position.set(nd.x||0,nd.y||0,nd.z||0);
    return mesh;
  }

  function makeEdges(nodes, links){
    const g = new THREE.Group();
    const nmap = {}; nodes.forEach(nd => { nmap[nd.id] = nd; });
    links.forEach(lk => {
      const a = nmap[lk.s], b = nmap[lk.t]; if(!a||!b) return;
      const pts = [new THREE.Vector3(a.x,a.y,a.z), new THREE.Vector3(b.x,b.y,b.z)];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const col = lk.type==="leverage" ? COLORS.edgeLever : (lk.type==="owns" ? COLORS.edgeOwn : COLORS.edgeUse);
      const mat = new THREE.LineBasicMaterial({color:col, opacity: lk.type==="leverage" ? 0.9 : 0.55});
      mat.transparent = true;
      const line = new THREE.Line(geo, mat);
      if(lk.label){
        const mid = pts[0].clone().lerp(pts[1], 0.5);
        g.add(labelSprite(lk.label, mid.x, mid.y+0.7, mid.z, 1.4));
      }
      g.add(line);
      if(lk.type==="leverage" && lk.w>2){
        const curve = new THREE.LineCurve3(pts[0], pts[1]);
        for(let k=0; k<3; k++){
          const m = new THREE.Mesh(new THREE.SphereGeometry(0.07,5,5), new THREE.MeshBasicMaterial({color:COLORS.edgeLever, opacity:0.85}));
          m.material.transparent = true;
          m.userData = {t: k*0.33, spd:0.022, curve};
          g.add(m); dusts.push(m);
        }
      }
    });
    return g;
  }

  function addGalaxyDust(cx,cy,cz, count=38, spread=2.8){
    const pos = new Float32Array(count*3);
    for(let i=0;i<count*3;i+=3){
      pos[i] = cx + (Math.random()-0.5)*spread*1.6;
      pos[i+1] = cy + (Math.random()-0.5)*spread*0.8;
      pos[i+2] = cz + (Math.random()-0.5)*spread*1.4;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos,3));
    const m = new THREE.PointsMaterial({size:0.026, color:COLORS.dust, opacity:0.32, depthWrite:false});
    m.transparent = true;
    const p = new THREE.Points(g, m);
    scene.add(p); dusts.push(p);
  }

  function makeStarField(){
    const N=1800; const pos = new Float32Array(N*3);
    for(let i=0; i<N*3; i+=3){
      const r = 46 + Math.random()*29;
      const th = Math.random()*Math.PI*2;
      const ph = Math.acos(2*Math.random()-1);
      pos[i] = r * Math.sin(ph) * Math.cos(th);
      pos[i+1] = r * Math.sin(ph) * Math.sin(th) * 0.55;
      pos[i+2] = r * Math.cos(ph) * 0.75 - 4;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({size:0.045, color:COLORS.star, opacity:0.65, depthWrite:false, sizeAttenuation:true});
    mat.transparent = true;
    starField = new THREE.Points(geo, mat);
    scene.add(starField);
  }

  function buildStarAndDust(nodes){
    if(!starField) makeStarField();
    nodes.filter(n=>n.type==="project").forEach(p => addGalaxyDust(p.x,p.y,p.z, 31, 3.1));
  }

  function onHover(ev){
    if(!renderer || !camera || !uGroup) return;
    lastInteract = Date.now();
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX-rect.left)/rect.width)*2-1;
    pointer.y = -((ev.clientY-rect.top)/rect.height)*2+1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(nodeMeshes, true);
    let nd=null; if(hits.length){ let o=hits[0].object; while(o&&! (o.userData&&o.userData.node)) o=o.parent; nd=o&&o.userData&&o.userData.node; }
    const prev = hoverNode;
    hoverNode = nd;
    if(hoverNode !== prev){
      highlight(hoverNode ? hoverNode.id : null, false);
    }
  }

  function onSelect(ev){
    if(!renderer || !camera || !nodeMeshes.length) return;
    lastInteract = Date.now(); if(controls) controls.autoRotate = false;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX-rect.left)/rect.width)*2-1;
    pointer.y = -((ev.clientY-rect.top)/rect.height)*2+1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(nodeMeshes, true);
    if(hits.length){
      let o=hits[0].object; while(o&&! (o.userData&&o.userData.node)) o=o.parent; const nd=o&&o.userData&&o.userData.node;
      if(nd) selectNode(nd);
    }
  }

  function onDouble(ev){
    if(!renderer || !nodeMeshes.length) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX-rect.left)/rect.width)*2-1;
    pointer.y = -((ev.clientY-rect.top)/rect.height)*2+1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(nodeMeshes, true);
    if(hits.length){
      let o=hits[0].object; while(o&&! (o.userData&&o.userData.node)) o=o.parent; const nd=o&&o.userData&&o.userData.node;
      if(nd) isolate(nd);
    }
  }

  function highlight(id, permanent){
    nodeMeshes.forEach(m => {
      const nd = m.userData.node; if(!nd) return;
      const active = id && (nd.id === id || (adj[id] && adj[id].indexOf(nd.id)>-1));
      const base = COLORS[nd.type] || COLORS.era;
      const mat = m.material || (m.children && m.children.find(c=>c&&c.material&&c.material.color)&&c.material);
      if(mat && mat.color) mat.color.setHex(active ? 0xffffff : base);
      const s = Math.max(0.32, Math.min(1.55, Math.log1p((nd.val||1)/80)*0.38));
      m.scale.setScalar(active ? s*1.35 : s);
    });
  }

  function selectNode(nd){
    selected = nd;
    const conn = adj[nd.id] || [];
    highlight(nd.id, true);
    updateInspector(nd);
    focusNode(nd);
    addRipple(new THREE.Vector3(nd.x||0, nd.y||0, nd.z||0));
    drawMinimap(); updateBar();
  }

  function isolate(nd){
    isolated = nd.id;
    const keep = new Set([nd.id, ...(adj[nd.id]||[])]);
    nodeMeshes.forEach(m => {
      const ndd = m.userData.node;
      const vis = keep.has(ndd.id);
      m.visible = vis;
    });
    if(edgeGroup) edgeGroup.children.forEach(ch => {
      if(ch.userData && ch.userData.s && ch.userData.t){
        ch.visible = keep.has(ch.userData.s) && keep.has(ch.userData.t);
      }
    });
    focusNode(nd);
  }

  function showAll(){
    isolated = null;
    nodeMeshes.forEach(m => m.visible = true);
    if(edgeGroup) edgeGroup.children.forEach(ch => ch.visible = true);
    highlight(null, false);
  }

  function surprise(){
    const high = [...nodeMeshes].sort((a,b)=>{
      const va = (a.userData.node.val||0), vb=(b.userData.node.val||0);
      return vb-va;
    }).slice(0,5).map(m=>m.userData.node);
    if(!high.length) return;
    const target = high[Math.floor(Math.random()*high.length)];
    selectNode(target);
    setTimeout(()=> { if(target) isolate(target); }, 420);
  }

  function focusNode(nd){
    if(!camera||!controls) return;
    lastInteract = Date.now(); if(controls) controls.autoRotate=false;
    const p = {x:nd.x||0, y:nd.y||0, z:nd.z||0};
    camTarget = new THREE.Vector3(p.x+9, p.y+4, p.z+11);
    lookTarget = new THREE.Vector3(p.x, p.y, p.z);
  }

  function updateStatsBar(n, c, lev){
    const el = root && root.querySelector("[data-u-stats]");
    if(!el) return;
    el.textContent = `${n} concepts • ${c} connections • leverage ${typeof lev==="number"?lev.toFixed(1):"—"}×`;
  }

  function updateInspector(node, totalC = 0){
    const ins=root&&root.querySelector("[data-u-inspector]"); if(!ins)return;
    const visN = (nodes && nodes.length) || 0;
    const visL = (links && links.length) || 0;
    if(!node){
      ins.innerHTML='<h3>'+(visN||0)+' nodes · '+(visL||0)+' links</h3><p>Visible spend: '+(totalC!=null?fmt$(totalC):"—")+' · Click nodes to orbit their constellation. Search or legend to narrow.</p>';
      return;
    }
    const pct = totalC>0 ? node.cost/totalC : 0;
    const conn = (graph && graph[node.id]) || [];
    let html='<h3>'+escapeHtml(node.name)+' <span class="pill">'+node.type+'</span></h3>';
    html+='<p><strong>'+fmt$(node.cost||0)+'</strong> · '+(node.tok?fmtTok(node.tok)+" tok":"")+(node.calls?" · "+fmtInt(node.calls)+" calls":"")+' · '+fmtPct(pct)+' of visible spend</p>';
    html+='<div class="universe-stats">Connected: '+(conn.length)+' concepts · sessions: '+(node.sess?node.sess.size:node.msgs||"?")+'</div>';
    if(conn.length){ html+='<p style="margin-top:4px">Linked: '+conn.slice(0,5).map(id=>escapeHtml( nodes.find(n=>n.id===id)?.name||id )).join(" · ")+(conn.length>5?" …":"")+'</p>'; }
    // persona insights + auto hubs + filter button for bidir
    let badge='';
    const avg = totalC / Math.max(1,visN||1);
    if(node.cost > avg*2.2) badge+='<span class="universe-badge">OUTLIER</span>';
    if(node.type==='cache' || (node.name&&/cache/i.test(node.name))) badge+='<span class="universe-badge" style="background:#16653433">X3 CACHE</span>';
    const highLink = links.filter(l=>l.a===node.id||l.b===node.id).some(l=>l.w>4);
    if(highLink) badge+='<span class="universe-badge" style="background:#1e3a8a33">HUB</span>';
    if(badge) html+='<div style="margin-top:2px">'+badge+'</div>';
    if((node.type==='project'&&node.raw) || node.type==='model'){
      html += '<button class="btn sm" style="margin-top:4px" data-apply-filter>Apply global filter to this '+node.type+' (other panels update)</button>';
    }
    ins.innerHTML=html;
    const af=ins.querySelector('[data-apply-filter]');
    if(af) af.onclick=()=>{ 
      if(node.type==='project'&&node.raw && window.ClaudeMeter.filterBar&&window.ClaudeMeter.filterBar.setProjects) window.ClaudeMeter.filterBar.setProjects([node.raw]);
      else if(node.type==='model' && window.ClaudeMeter.filterBar&&window.ClaudeMeter.filterBar.setModels) window.ClaudeMeter.filterBar.setModels([node.name]);
      legend[node.type]=true; rebuild();
    };
  }

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

  function fitCamera(nodes){
    if(!camera || !controls || !nodes.length) return;
    let cx=0,cy=0,cz=0; nodes.forEach(n=>{cx+=n.x||0; cy+=n.y||0; cz+=n.z||0;});
    cx/=nodes.length; cy/=nodes.length; cz/=nodes.length;
    camera.position.set(cx+22, cy+11, cz+28);
    controls.target.set(cx, cy+1, cz);
    controls.update();
  }

  function resetView(){
    camTarget = null; lookTarget = null; lastInteract=Date.now();
    isolated = null; selected = null; hoverNode = null;
    if(controls){ controls.autoRotate = false; }
    if(uGroup) uGroup.rotation.y = 0;
    nodeMeshes.forEach(m => { m.visible = true; m.scale.setScalar(1); const nd=m.userData.node; if(nd){ const mat=m.material||(m.children&&m.children.find(c=>c&&c.material&&c.material.color)&&c.material); if(mat&&mat.color) mat.color.setHex(COLORS[nd.type]||COLORS.era); } });
    if(edgeGroup) edgeGroup.children.forEach(ch => ch.visible = true);
    if(camera && controls){
      camera.position.set(22,11,28); controls.target.set(0,1,0); controls.update();
    }
    updateInspector(null);
  }

  function startTour(){
    if(!nodes.length||!camera||!controls) return;
    const tourEl = root && root.querySelector('[data-uni-tour]');
    if(tourEl) tourEl.style.display = 'block';
    tourStep=0; lastInteract=Date.now(); controls.autoRotate=false;

    const steps = [
      { msg: "Wide view — your full usage cosmos", persona: "Priya: see all the hidden connections at once" },
      { msg: "Project galaxies", persona: "David: instant attribution clusters (X13)" },
      { msg: "Cache nebula bridge", persona: "Priya: the X3 value that relieves the invisible meter anxiety" },
      { msg: "Expensive / outlier cluster", persona: "Marcus: spot the burns (M8) before they grow" }
    ];

    const doStep = () => {
      if(tourStep < 0 || tourStep >= steps.length){
        if(tourEl) tourEl.style.display = 'none';
        tourStep = -1;
        resetView();
        return;
      }
      const s = steps[tourStep];
      if(tourEl){
        tourEl.querySelector('.tour-text').textContent = s.msg;
        tourEl.querySelector('.tour-persona').textContent = s.persona;
      }
      if(tourStep === 0){ camera.position.set(22,11,26); controls.target.set(0,1,0); }
      else if(tourStep === 1){
        const p = nodes.find(n=>n.type==='project'); if(p) focusNode(p);
      }else if(tourStep === 2){
        const c = nodes.find(n=>n.type==='cache'); if(c) focusNode(c); else camera.position.set(2,9,4);
      }else {
        const big = nodes.slice().sort((a,b)=>(b.cost||0)-(a.cost||0))[0]; if(big) focusNode(big);
      }
      controls.update();
      tourStep++;
      setTimeout(doStep, 1550);
    };
    doStep();
  }

  function highlightSearch(){
    // lightweight search support kept for compatibility
    if(!searchTerm){ nodeMeshes.forEach(m=>{ const nd=m.userData.node; if(nd){ const mat=m.material||(m.children&&m.children.find(c=>c&&c.material&&c.material.color)&&c.material); if(mat&&mat.color) mat.color.setHex(COLORS[nd.type]||COLORS.era); } }); return; }
    nodeMeshes.forEach(m=>{
      const nd = m.userData.node; if(!nd) return;
      const hit = nd.label && nd.label.toLowerCase().includes(searchTerm);
      const mat = m.material || (m.children && m.children.find(c=>c&&c.material&&c.material.color)&&c.material);
      if(mat&&mat.color) mat.color.setHex(hit ? 0xffffff : (COLORS[nd.type]||COLORS.era));
    });
  }

  function toggleTourPause(){ /* stub for iter compatibility */ }
  function addRipple(){ /* stub */ }

  function onPointer(ev){ /* legacy compat for fullscreen etc */ }

  function drawMinimap(){
    const cv=root&&root.querySelector('[data-uni-minimap]'); if(!cv || !nodes.length) return;
    const ctx=cv.getContext('2d'); ctx.clearRect(0,0,82,82);
    ctx.fillStyle='#000000'; ctx.fillRect(0,0,82,82);
    let minx=1e9, maxx=-1e9, minz=1e9,maxz=-1e9;
    nodes.forEach(n=>{ minx=Math.min(minx,n.x); maxx=Math.max(maxx,n.x); minz=Math.min(minz,n.z); maxz=Math.max(maxz,n.z); });
    const rx=maxx-minx||1, rz=maxz-minz||1;
    nodes.forEach(n=>{
      const x = 8 + ((n.x-minx)/rx)*66, z=8 + ((n.z-minz)/rz)*66;
      ctx.fillStyle = '#'+(COLORS[n.type]||COLORS.dim).toString(16).padStart(6,'0');
      ctx.fillRect(x-1.5, z-1.5, 3,3);
    });
  }

  function updateBar(){
    const bar=root&&root.querySelector("[data-uni-bar]"); if(!bar)return;
    const visN=nodes.length; if(!visN){ bar.textContent=''; return; }
    const cR = (links||[]).filter(l=>l.w>2.5).length / Math.max(1,(links||[]).length);
    let txt = 'For Priya: green bridges = X3 cache value visible, easing taxi-meter anxiety. ';
    if(cR>0.3) txt += 'Strong cache flows. ';
    const getCost = n => n.cost || n.val || 0;
    const outliers = nodes.filter(n=> getCost(n) > (nodes.reduce((s,x)=>s+getCost(x),0)/visN)*1.8 ).length;
    if(outliers) txt += 'For Marcus: '+outliers+' outlier nodes (abandoned expts?). ';
    txt += 'David: clusters = instant attribution.';
    bar.textContent = txt;
  }

  function exportPNG(){
    const host=stage(); if(!renderer||!host) return;
    const a=document.createElement('a');
    a.download = 'usage-universe.png';
    a.href = renderer.domElement.toDataURL('image/png');
    a.click();
  }

  function onKey(e){
    if(!nodes.length || (document.activeElement && document.activeElement.tagName==='INPUT')) return;
    if(e.key==='/'){ e.preventDefault(); const s=root&&root.querySelector('[data-uni-search]'); if(s){s.focus(); s.select();} return; }
    if(e.key==='Escape'){ if(selected||hoverNode){ hoverNode=null; selected=null; connected.clear(); updateHighlights(); updateInspector(null); } return; }
    if((!selected && !hoverNode) || !nodes.length) return;
    if(e.key==='ArrowRight'||e.key==='ArrowLeft'){
      const curr = selected || hoverNode; let idx = nodes.findIndex(n=>n.id===curr.id);
      idx = (idx + (e.key==='ArrowRight'?1:-1) + nodes.length) % nodes.length;
      const nxt = nodes[idx]; if(nxt){ hoverNode=null; selectNode(nxt); }
    }
  }

  function resize(){
    const host = stage(); if(!host) return;
    if(!renderer){ if(lastEvents.length) render(lastEvents); return; }
    const w = host.clientWidth, h = host.clientHeight;
    if(w<50||h<50) return;
    camera.aspect = w/h; camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    if(controls) controls.update();
  }

  function animate(){
    raf = requestAnimationFrame(animate);
    if(!renderer || !scene || !camera) return;
    // Skip rendering while tab hidden or scrolled off-screen; keep the loop alive to resume instantly.
    if((typeof document !== "undefined" && document.hidden) || !onScreen) return;
    const t = Date.now() * 0.001;
    if(controls){
      if(camTarget){
        camera.position.lerp(camTarget, 0.085);
        const lt = lookTarget || controls.target; controls.target.lerp(lt, 0.085);
        controls.update();
        if(camera.position.distanceTo(camTarget)<0.25) camTarget = null;
      } else {
        const idle = Date.now()-lastInteract;
        if(idle > 9000) controls.autoRotate = true;
        controls.update();
      }
    }
    if(uGroup) uGroup.rotation.y = (uGroup.rotation.y + 0.00035) % (Math.PI*2);
    dusts.forEach(d => { if(d) d.rotation.y = t * 0.03; });
    nodeMeshes.forEach((m,i) => {
      const nd = m.userData.node; if(!nd) return;
      if(nd.type==="cacheRead" || nd.type==="cacheWrite" || (selected && adj[selected.id] && adj[selected.id].includes(nd.id))){
        const s = Math.max(0.32, Math.min(1.55, Math.log1p((nd.val||1)/80)*0.38));
        m.scale.setScalar(s * (1 + 0.04*Math.sin(t*2.8 + i)));
      }
    });
    // comet particles on leverage
    if(edgeGroup) edgeGroup.children.forEach(ch=>{
      if(ch.userData && ch.userData.curve){
        ch.userData.t = ((ch.userData.t||0) + (ch.userData.spd||0.022)) % 1;
        const pt = ch.userData.curve.getPoint(ch.userData.t);
        if(pt) ch.position.copy(pt);
      }
    });

    // ripples
    for(let i=ripples.length-1; i>=0; i--){
      const r = ripples[i];
      r.life -= 0.045;
      if(r.life <= 0){
        if(r.mesh && r.mesh.parent) r.mesh.parent.remove(r.mesh);
        ripples.splice(i,1);
        continue;
      }
      const sc = 1 + (1 - r.life) * 2.8;
      r.mesh.scale.set(sc, sc, sc);
      if(r.mesh.material && r.mesh.material.opacity != null) r.mesh.material.opacity = Math.max(0.05, r.life * 0.7);
    }

    renderer.render(scene, camera);
  }

  function updateHighlights(){ /* compat */ }

  function focusSearch(){ /* compat with tour/search */ }

  function focusNodeLegacy(nd){ focusNode(nd); }

  function addRipple(pos){
    if(!uGroup || !pos) return;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.9, 0.06, 6, 24),
      new THREE.MeshBasicMaterial({color: COLORS.model, opacity:0.7, side:THREE.DoubleSide})
    );
    ring.material.transparent = true;
    ring.position.copy(pos);
    ring.rotation.x = Math.PI * 0.5;
    uGroup.add(ring);
    ripples.push({mesh: ring, life: 1});
  }

  function showTipOnce(){
    if(!root || root.querySelector('.universe-tip')) return;
    const tip = document.createElement('div');
    tip.className = 'universe-tip';
    tip.innerHTML = 'Drag to orbit • click stars for details • dbl-click to isolate (Priya: see the cache value connections). <button>Got it</button>';
    const stg = stage(); if(stg) stg.appendChild(tip);
    tip.querySelector('button').onclick = () => tip.remove();
  }

  function focusCluster(kind){ /* kept for buttons that may call old names */
    if(kind==="cache"){
      const c = nodeById["cr"] || nodeById["cw"];
      if(c) focusNode(c.userData ? c.userData.node : c);
    }
  }

  function labelSprite(text, x, y, z, w=1.8){
    const c = document.createElement("canvas"); c.width=256; c.height=40;
    const ctx = c.getContext("2d");
    ctx.clearRect(0,0,c.width,c.height);
    ctx.fillStyle = "rgba(10,12,20,.78)";
    ctx.beginPath(); ctx.roundRect(4,3,248,34,6); ctx.fill();
    ctx.font = "600 12px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillStyle = "#e6e8ee"; ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillText(text, 128, 20);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({map:tex, depthWrite:false});
    mat.transparent = true;
    const sp = new THREE.Sprite(mat);
    sp.position.set(x,y,z); sp.scale.set(w, 0.42, 1);
    return sp;
  }

  function makeEdgesLegacy(){ /* compat stub */ }

  // expose
  window.ClaudeMeter.threeUniverse = { mount, render, resize, destroy: function(){ if(raf)cancelAnimationFrame(raf); if(resizeObserver)resizeObserver.disconnect(); clearScene(); if(renderer)renderer.dispose(); } };

  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded", ()=>{ /* mount called from index */ });
  }
})();