import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

(function(){
  "use strict";

  window.ClaudeMeter = window.ClaudeMeter || {};

  const COLORS = { input:0x6ea8ff, output:0xd97757, cacheRead:0x22c55e, cacheWrite:0xeab308 };
  const TOKEN_KEYS = [["input","Input"],["output","Output"],["cacheRead","Cache read"],["cacheWrite","Cache write"]];

  let root = null;
  let mounted = false;
  let renderer = null;
  let scene = null;
  let camera = null;
  let controls = null;
  let raf = 0;
  let lastEvents = [];
  let helixGroup = null;
  let resizeObserver = null;
  let raycaster = new THREE.Raycaster();
  let pointer = new THREE.Vector2();
  let tooltip = null;
  let bucketsCache = [];
  let starLayers = [];
  let spokes = [];
  let animState = {active:false, start:0, dur:1600, buckets:null};
  let selectedBucket = null;
  let lastSig = '';
  let reducedMotion = false;

  function fmt$(n){ return "$"+(n||0).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2}); }
  function fmtInt(n){ return (n||0).toLocaleString(); }
  function fmtTok(n){ if(n>=1e9)return(n/1e9).toFixed(2)+"B"; if(n>=1e6)return(n/1e6).toFixed(2)+"M"; if(n>=1e3)return(n/1e3).toFixed(1)+"k"; return String(n||0); }

  function visibleEvents(events){
    let out = Array.isArray(events) ? events.slice() : [];
    try {
      const fb = window.ClaudeMeter && window.ClaudeMeter.filterBar;
      if (fb && typeof fb.applyFilters === "function") out = fb.applyFilters(out);
    } catch(e){}
    return out;
  }

  function priceFor(model){
    const pricing = window.PRICING || [];
    const m = (model||"").toLowerCase();
    return pricing.find(p=>p.match && m.includes(p.match)) || pricing[pricing.length-1] || { in:3, out:15, cacheRead:.3, cacheWrite:3.75 };
  }

  function costParts(e){
    const p = priceFor(e.model);
    return {
      input: ((e.inTok||0)*p.in)/1e6,
      output: ((e.outTok||0)*p.out)/1e6,
      cacheRead: ((e.crTok||0)*p.cacheRead)/1e6,
      cacheWrite: ((e.cwTok||0)*p.cacheWrite)/1e6
    };
  }

  function getTs(e){
    if (e.tsMs != null) return e.tsMs;
    if (e.ts) return +new Date(e.ts);
    return 0;
  }

  function aggregateBuckets(events){
    if (!events.length) return [];
    const sorted = events.slice().sort((a,b)=>getTs(a)-getTs(b));
    const t0 = getTs(sorted[0]);
    const t1 = getTs(sorted[sorted.length-1]);
    const span = Math.max(3600000, t1 - t0);
    const hours = span / 3600000;
    let bucketMs = (hours < 96) ? 3600000 : 86400000;
    const target = Math.min(180, Math.max(40, Math.floor(hours / 1.2) || 60));
    bucketMs = Math.max(bucketMs, Math.floor(span / target));
    const map = new Map();
    for (const e of sorted){
      const ts = getTs(e);
      const idx = Math.floor( (ts - t0) / bucketMs );
      let b = map.get(idx);
      if (!b){
        const start = t0 + idx * bucketMs;
        b = { idx, start, end: start + bucketMs, cost:0, msgs:0, inTok:0, outTok:0, crTok:0, cwTok:0, parts:{input:0,output:0,cacheRead:0,cacheWrite:0} };
        map.set(idx, b);
      }
      b.cost += e.cost || 0;
      b.msgs += 1;
      b.inTok += e.inTok||0; b.outTok += e.outTok||0; b.crTok += e.crTok||0; b.cwTok += e.cwTok||0;
      const cp = costParts(e);
      b.parts.input += cp.input; b.parts.output += cp.output; b.parts.cacheRead += cp.cacheRead; b.parts.cacheWrite += cp.cacheWrite;
    }
    return [...map.values()].sort((a,b)=>a.idx-b.idx);
  }

  function dominant(b){
    let maxK = "input", maxV = b.parts.input;
    TOKEN_KEYS.forEach(([k])=>{ const v = b.parts[k]; if (v > maxV){ maxV = v; maxK = k; } });
    return maxK;
  }

  function mount(el){
    if (!el) return;
    root = el;
    root.className = "helix";
    root.innerHTML =
      '<div class="helix-head">' +
        '<div class="helix-title"><h2>3D Activity Helix</h2><p>Time spirals along Z. Spoke len=cost, thick=msgs. Reveals 5h clusters for Priya (P1/P2), burns for Marcus (M8), rhythm for Jake (J4), attr for David.</p></div>' +
        '<div class="helix-controls"><button type="button" class="btn" data-helix-reset>Reset view</button><button type="button" class="btn" data-helix-replay>Replay timeline</button></div>' +
      '</div>' +
      '<div class="helix-stage" tabindex="0" aria-label="3D activity helix">' +
        '<div class="helix-empty">Load JSONL or demo data to see the helix.</div>' +
      '</div>' +
      '<div class="helix-legend"></div>';

    root.querySelector("[data-helix-reset]").addEventListener("click", function(){
      if (!camera || !controls) return;
      const L = 28;
      camera.position.set(16, 7, L * 0.7);
      controls.target.set(0, 0, L * 0.55);
      controls.update();
    });
    const rp = root.querySelector("[data-helix-replay]");
    if (rp) rp.addEventListener("click", triggerUnwind);

    tooltip = document.createElement("div");
    tooltip.style.cssText = "position:absolute;pointer-events:none;display:none;background:#0b0d12ee;border:1px solid #ffffff22;border-radius:6px;padding:6px 8px;font-size:11px;color:#e6e8ee;z-index:10;max-width:240px";
    const st = root.querySelector(".helix-stage");
    if (st) { st.style.position = "relative"; st.appendChild(tooltip); }

    const leg = root.querySelector(".helix-legend");
    if (leg) leg.innerHTML = TOKEN_KEYS.map(([k,l]) => '<span class="helix-chip"><span class="helix-swatch" style="background:#'+COLORS[k].toString(16).padStart(6,"0")+'"></span>'+l+'</span>').join("");

    mounted = true;
    reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    resizeObserver = new ResizeObserver(()=>resize());
    resizeObserver.observe(st || root);
    render(window.STATE && window.STATE.events ? window.STATE.events : []);
  }

  function stageEl(){ return root && root.querySelector(".helix-stage"); }

  function initScene(){
    const host = stageEl();
    if (!host || renderer) return;
    if (host.clientWidth < 40 || host.clientHeight < 40) return;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.Fog(0x000000, 24, 68);

    camera = new THREE.PerspectiveCamera(48, host.clientWidth / host.clientHeight, 0.1, 120);
    const L = 28;
    camera.position.set(16, 7, L * 0.65);

    renderer = new THREE.WebGLRenderer({ antialias:true, alpha:false, preserveDrawingBuffer:true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.innerHTML = "";
    host.appendChild(renderer.domElement);
    if (tooltip) { tooltip.style.display="none"; host.appendChild(tooltip); }
    const can=renderer.domElement; can.setAttribute('role','img'); can.setAttribute('aria-label','3D activity helix showing time rhythm and cache flows for Priya X3 flow loss and Jake J4');

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.minDistance = 5;
    controls.maxDistance = 48;
    controls.maxPolarAngle = Math.PI * 0.82;
    controls.minPolarAngle = Math.PI * 0.12;
    controls.target.set(0, 0, L * 0.52);
    controls.addEventListener('change', onControlChange);
    host.addEventListener('dblclick',()=>{if(!camera||!controls)return; camera.position.set(16,7,19);controls.target.set(0,0,19);controls.update();});

    scene.add(new THREE.HemisphereLight(0x10131a, 0x000000, 0.6));
    const pl = new THREE.PointLight(0xa5b4fc, 1.1, 90); pl.position.set(12,14,-6); scene.add(pl);
    const pl2 = new THREE.PointLight(0xfca5a5, 0.7, 70); pl2.position.set(-14,8,22); scene.add(pl2);

    helixGroup = new THREE.Group();
    scene.add(helixGroup);

    makeStarLayers();

    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointerleave", ()=>{ if(tooltip) tooltip.style.display="none"; });
    controls.addEventListener('change', onControlChange);
    animate();
  }

  function render(events){
    lastEvents = Array.isArray(events) ? events : [];
    if (!mounted && document.getElementById("threeHelix")) mount(document.getElementById("threeHelix"));
    if (!root) return;
    const filtered = visibleEvents(lastEvents);
    bucketsCache = aggregateBuckets(filtered);

    if (!filtered.length){
      clearScene();
      const host = stageEl();
      if (host && !renderer) host.innerHTML = '<div class="helix-empty">Load JSONL or demo data to see the helix.</div>';
      if (tooltip) tooltip.style.display = "none";
      return;
    }

    initScene();
    if (!renderer) return;
    const sig = bucketsCache.length + '|' + (bucketsCache[0]&&bucketsCache[0].start) + '|' + (bucketsCache[bucketsCache.length-1]&&bucketsCache[bucketsCache.length-1].start);
    if (sig !== lastSig) { lastSig = sig; triggerUnwind(true); }
    updateHelixLive(bucketsCache);
    const stg = stageEl(); if(stg) stg.setAttribute('aria-label','3D helix '+bucketsCache.length+' buckets (Priya P1 flow relief, Marcus M8 burns, Jake J4)');
    resize();
  }

  function clearScene(){
    spokes.forEach(s=>{ if(s.spoke) disposeObject(s.spoke); if(s.tip) disposeObject(s.tip); if(s.glow) disposeObject(s.glow); });
    spokes = [];
    if (!helixGroup) return;
    while (helixGroup.children.length){
      const ch = helixGroup.children.pop();
      disposeObject(ch);
    }
  }

  function buildHelix(buckets){
    clearScene();
    if (!buckets.length) return;
    const n = buckets.length;
    const turns = Math.min(10, Math.max(3, Math.round(n / 18)));
    const radius = 5.8;
    const L = 28;

    const t0 = buckets[0].start;
    const tLast = buckets[n-1].end || (buckets[n-1].start + 3600000);
    const span = Math.max(1, tLast - t0);

    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, L, 6),
      new THREE.MeshStandardMaterial({ color:0x334155, roughness:0.75, metalness:0.05 })
    );
    core.rotation.x = Math.PI / 2;
    core.position.z = L / 2;
    helixGroup.add(core);

    const maxC = Math.max(1, ...buckets.map(b=>b.cost));
    const maxM = Math.max(1, ...buckets.map(b=>b.msgs||1));
    const maxSp = 5.2;
    const avgC = buckets.reduce((s,b)=>s+b.cost,0) / n;

    const pts = [];
    for (let i=0; i<n; i++){
      const b = buckets[i];
      const p = (b.start - t0) / span;
      const th = p * turns * Math.PI * 2;
      const hx = radius * Math.cos(th);
      const hy = radius * Math.sin(th);
      const hz = p * L;
      pts.push(new THREE.Vector3(hx, hy, hz));

      const dom = dominant(b);
      let col = COLORS[dom];
      let spLen = 0.35 + (b.cost / maxC) * maxSp;
      const cratio = (b.crTok + b.cwTok) / Math.max(1, b.inTok + b.outTok + b.crTok + b.cwTok);
      spLen = 0.35 + ((b.cost / maxC) + cratio * 0.35) * maxSp;

      const t = Math.max(0.05, (b.msgs||1) / maxM);
      const r0 = 0.07 + t * 0.18;
      const r1 = 0.05 + t * 0.13;

      let spokeMat = new THREE.MeshStandardMaterial({ color: col, roughness:0.55, metalness:0.08 });
      if (b.cost > avgC * 1.7) { col = 0xf59e0b; spokeMat.color.setHex(col); }
      if (b.parts && b.parts.cacheWrite > b.cost * 0.35) {
        spokeMat.emissive = new THREE.Color(0x854d0e); spokeMat.emissiveIntensity = 0.35;
      }

      const spoke = new THREE.Mesh( new THREE.CylinderGeometry(r0, r1, spLen, 5), spokeMat );
      const dirX = Math.cos(th); const dirY = Math.sin(th);
      const mx = hx + dirX * (spLen * 0.5); const my = hy + dirY * (spLen * 0.5);
      spoke.position.set(mx, my, hz);
      const qdir = new THREE.Vector3(dirX, dirY, 0).normalize();
      spoke.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), qdir);
      spoke.userData = { b, dom };

      const tip = new THREE.Mesh( new THREE.SphereGeometry(0.12 + t*0.06, 5, 5), new THREE.MeshStandardMaterial({ color: col, roughness:0.35, metalness:0.15 }) );
      tip.position.set(hx + dirX * spLen, hy + dirY * spLen, hz);
      tip.userData = { b, dom };

      helixGroup.add(spoke); helixGroup.add(tip);
      spokes.push({spoke, tip, b, baseLen:spLen, baseR:r0, idx:i });

      if (b.cost > avgC * 1.7) addBurnParticles(hx, hy, hz, dirX, dirY, spLen);
      if (b.parts && b.parts.cacheWrite > b.cost * 0.35) addWriteGlow(spoke, hx, hy, hz, dirX, dirY, spLen);
    }

    if (pts.length > 1){
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const spine = new THREE.Line(g, new THREE.LineBasicMaterial({ color:0x475569, transparent:true, opacity:0.7 }));
      helixGroup.add(spine);
    }

    const startMark = new THREE.Mesh(new THREE.SphereGeometry(0.18,6,6), new THREE.MeshStandardMaterial({color:0x6b7280}));
    startMark.position.set(pts[0].x, pts[0].y, pts[0].z);
    helixGroup.add(startMark);
    const endMark = new THREE.Mesh(new THREE.SphereGeometry(0.18,6,6), new THREE.MeshStandardMaterial({color:0x9ca3af}));
    endMark.position.set(pts[n-1].x, pts[n-1].y, pts[n-1].z);
    helixGroup.add(endMark);
  }

  function addBurnParticles(hx,hy,hz,dx,dy,len){
    const N=7; const pos=new Float32Array(N*3); const cols=new Float32Array(N*3);
    for(let i=0;i<N;i++){
      const off = (i-N/2)*0.22; pos[i*3]=hx+dx*(len*0.6+off*0.3); pos[i*3+1]=hy+dy*(len*0.6+off*0.3); pos[i*3+2]=hz + (Math.random()-0.5)*0.3;
      cols[i*3]=1; cols[i*3+1]=0.55+Math.random()*0.2; cols[i*3+2]=0.1;
    }
    const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.BufferAttribute(pos,3)); g.setAttribute('color',new THREE.BufferAttribute(cols,3));
    const m=new THREE.PointsMaterial({size:0.09, vertexColors:true, transparent:true, opacity:0.85, depthWrite:false});
    const pts=new THREE.Points(g,m); helixGroup.add(pts); setTimeout(()=>{ if(pts.parent) pts.parent.remove(pts); disposeObject(pts); }, 2100);
  }

  function addWriteGlow(spokeObj, hx,hy,hz,dx,dy,len){
    const r = new THREE.Mesh( new THREE.TorusGeometry(0.38,0.035,4,12), new THREE.MeshBasicMaterial({color:0xfacc15, transparent:true, opacity:0.6, blending:THREE.AdditiveBlending}) );
    r.position.set(hx+dx*(len*0.45), hy+dy*(len*0.45), hz);
    r.quaternion.copy(spokeObj.quaternion);
    helixGroup.add(r);
    setTimeout(()=>{ if(r.parent){ r.parent.remove(r); disposeObject(r); } }, 3200);
  }

  function onPointerMove(ev){
    if (!renderer || !camera || !helixGroup || !tooltip) return;
    const host = stageEl();
    if (!host) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(helixGroup.children, true);
    const hit = hits.find(h => h.object && h.object.userData && h.object.userData.b);
    if (hit){
      const b = hit.object.userData.b;
      const dom = hit.object.userData.dom;
      const d0 = new Date(b.start).toLocaleString(undefined, {month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
      const d1 = new Date(b.end).toLocaleString(undefined, {hour:"2-digit",minute:"2-digit"});
      tooltip.innerHTML =
        '<strong>'+d0+'–'+d1+'</strong><br>'+
        fmt$(b.cost)+' · '+fmtInt(b.msgs)+' msgs<br>'+
        'in '+fmtTok(b.inTok)+' · out '+fmtTok(b.outTok)+'<br>'+
        'cr '+fmtTok(b.crTok)+' · cw '+fmtTok(b.cwTok)+'<br>'+
        '<span style="color:#'+COLORS[dom].toString(16).padStart(6,"0")+'">'+dom+'</span> dominant';
      tooltip.style.left = (ev.clientX - rect.left + 12) + "px";
      tooltip.style.top = (ev.clientY - rect.top - 8) + "px";
      tooltip.style.display = "block";
    } else {
      tooltip.style.display = "none";
    }
  }

  function resize(){
    const host = stageEl();
    if (!host) return;
    if (!renderer){
      if (lastEvents.length) render(lastEvents);
      return;
    }
    const w = host.clientWidth, h = host.clientHeight;
    if (w<40 || h<40) return;
    camera.aspect = w/h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  function makeStarLayers(){
    starLayers.forEach(l=>{scene&&scene.remove(l); disposeObject(l);}); starLayers=[];
    const layers = [
      {n:480,r:82,s:0.026,o:0.36,f:0.6,rot:0.0008},
      {n:720,r:54,s:0.042,o:0.58,f:1.9,rot:0.0014},
      {n:360,r:31,s:0.065,o:0.74,f:3.1,rot:0.0022}
    ];
    layers.forEach((cfg,i)=>{
      const pos=new Float32Array(cfg.n*3);
      for(let j=0;j<cfg.n*3;j+=3){
        const rr=cfg.r+Math.random()*24; const th=Math.random()*Math.PI*2; const ph=Math.acos(2*Math.random()-1);
        pos[j]=rr*Math.sin(ph)*Math.cos(th); pos[j+1]=rr*Math.sin(ph)*Math.sin(th)*0.58; pos[j+2]=rr*Math.cos(ph)*0.7-3;
      }
      const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.BufferAttribute(pos,3));
      const m=new THREE.PointsMaterial({size:cfg.s,color: i===1?0xb8c5d8:0xcbd5e1,opacity:cfg.o,depthWrite:false,sizeAttenuation:true,transparent:true});
      const p=new THREE.Points(g,m); p.userData={f:cfg.f,rot:cfg.rot,ph:i*1.1}; scene.add(p); starLayers.push(p);
    });
    // point lights from far stars
    if(starLayers[0]&&starLayers[0].geometry){
      const pos=starLayers[0].geometry.attributes.position; for(let k=0;k<3;k++){
        const ii=(k*37)%(pos.count||120)*3; const pl=new THREE.PointLight(0xd1d8e8,0.55,140);
        pl.position.set(pos.array[ii]||0,pos.array[ii+1]||12,pos.array[ii+2]||-8); scene.add(pl);
      }
    }
  }
  function onControlChange(){
    if(!camera||!starLayers[0])return;
    const f=camera.position.length()*0.0005;
    starLayers[0].rotation.y = -camera.position.x*f*0.6; starLayers[2].rotation.x = camera.position.z*f*0.4;
  }

  function highlightSpoke(obj){
    if(!obj) return;
    const sc=obj.scale; sc.set(1.35,1,1.35); setTimeout(()=>{ sc.set(1,1,1); }, 820);
  }

  function updateHelixLive(buckets){
    if(!buckets.length || !spokes.length){ buildHelix(buckets); return; }
    const n=buckets.length; const maxC=Math.max(1,...buckets.map(b=>b.cost)); const maxM=Math.max(1,...buckets.map(b=>b.msgs||1));
    const avgC = buckets.reduce((s,b)=>s+b.cost,0)/n;
    buckets.forEach((b,i)=>{
      const s = spokes.find(x=>x.b && Math.abs(x.b.start-b.start)<1000);
      if(!s || !s.spoke) return;
      const p = i / Math.max(1,n-1); const th = p * (Math.min(10,Math.max(3,Math.round(n/18)))) * Math.PI*2;
      const radius=5.8; const L=28; const hz = p*L; const hx=radius*Math.cos(th); const hy=radius*Math.sin(th);
      const cratio=(b.crTok+b.cwTok)/Math.max(1,b.inTok+b.outTok+b.crTok+b.cwTok);
      let spLen=0.35 + ((b.cost/maxC)+cratio*0.35)*5.2;
      const t=Math.max(0.05,(b.msgs||1)/maxM); const r0=0.07+t*0.18;
      s.spoke.scale.set(1, spLen / (s.baseLen||spLen), 1);
      s.spoke.position.set( hx + Math.cos(th)*(spLen*0.5), hy + Math.sin(th)*(spLen*0.5), hz );
      if (b.cost > avgC*1.7) s.spoke.material.color.setHex(0xf59e0b);
      if(s.tip) s.tip.position.set( hx + Math.cos(th)*spLen, hy + Math.sin(th)*spLen , hz );
      s.b = b;
    });
  }

  function triggerUnwind(forceBuild){
    if(!bucketsCache.length) return;
    if(forceBuild || !spokes.length) buildHelix(bucketsCache);
    if(reducedMotion){ return; }
    animState.active=true; animState.start=performance.now(); animState.buckets=bucketsCache;
    const L=28;
    spokes.forEach((s,i)=>{ if(s.spoke){ s.spoke.scale.y=0.02; s.spoke.position.z = (i/spokes.length)*L*0.1; } });
  }

  function applyAnim(){
    if(!animState.active || reducedMotion) return;
    const now=performance.now(); const p=Math.min(1, (now - animState.start)/animState.dur);
    const n = spokes.length; const L=28;
    spokes.forEach((s,i)=>{
      if(!s.spoke) return;
      const ip = Math.max(0, Math.min(1, (p * n - i) / Math.max(1,n*0.7) ));
      s.spoke.scale.y = 0.02 + ip * 0.98;
      const pp = (s.idx||i) / Math.max(1,n-1);
      s.spoke.position.z = pp * L * ip * 0.6 + 0.1;
    });
    if(p>=1){ animState.active=false; spokes.forEach(s=>{ if(s.spoke) s.spoke.scale.y=1; }); }
  }
  function onPointerDown(ev){
    if(!renderer||!camera||!helixGroup)return;
    const rect=renderer.domElement.getBoundingClientRect();
    pointer.x=((ev.clientX-rect.left)/rect.width)*2-1; pointer.y=-((ev.clientY-rect.top)/rect.height)*2+1;
    raycaster.setFromCamera(pointer,camera);
    const hits=raycaster.intersectObjects(helixGroup.children,true);
    const hit=hits.find(h=>h.object&&h.object.userData&&h.object.userData.b);
    if(hit){
      selectedBucket = hit.object.userData.b;
      highlightSpoke(hit.object);
      const b=selectedBucket;
      try{
        const fb = window.ClaudeMeter && window.ClaudeMeter.filterBar;
        if(fb && typeof fb.setRange==='function') fb.setRange(b.start, b.end);
      }catch(e){}
    }
  }
  function animate(){
    raf = requestAnimationFrame(animate);
    if (!renderer || !scene || !camera) return;
    if (controls) controls.update();
    if(!reducedMotion && starLayers.length){
      const t=Date.now()*0.001;
      starLayers.forEach((l,i)=>{
        if(l.material){ l.material.opacity = [0.36,0.58,0.74][i] + Math.sin(t*(l.userData.f||1.8)+(l.userData.ph||0))*0.09; l.material.needsUpdate=true; }
        if(l.userData.rot) l.rotation.y += l.userData.rot * (i?0.6:1);
      });
    }
    applyAnim();
    if(!reducedMotion && helixGroup) helixGroup.rotation.y += 0.00018;
    renderer.render(scene, camera);
  }

  function disposeObject(obj){
    obj.traverse(function(child){
      if (child.geometry) child.geometry.dispose();
      if (child.material){
        const ms = Array.isArray(child.material) ? child.material : [child.material];
        ms.forEach(m=>{ if(m.map) m.map.dispose(); m.dispose(); });
      }
    });
  }

  function destroy(){
    if (raf) cancelAnimationFrame(raf);
    if (resizeObserver) resizeObserver.disconnect();
    clearScene();
    if (renderer) renderer.dispose();
    renderer = scene = camera = controls = root = tooltip = null;
    mounted = false;
  }

  window.ClaudeMeter.threeHelix = { mount, render, destroy, resize };

  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", function(){ mount(document.getElementById("threeHelix")); });
  } else {
    mount(document.getElementById("threeHelix"));
  }
})();
