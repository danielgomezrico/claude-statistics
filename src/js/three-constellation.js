import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

(function(){
  "use strict";

  window.ClaudeMeter = window.ClaudeMeter || {};

  const COLORS = { input:0x6ea8ff, output:0xd97757, cacheRead:0x22c55e, cacheWrite:0xeab308, ground:0x1b2230, text:"#e6e8ee" };
  const MODEL_COLORS = [0xd97757,0x6ea8ff,0x22c55e,0xeab308,0xa855f7,0x06b6d4,0xef4444,0xf97316];

  let root = null;
  let mounted = false;
  let renderer = null;
  let scene = null;
  let camera = null;
  let controls = null;
  let raf = 0;
  let lastEvents = [];
  let selected = null;
  let raycaster = new THREE.Raycaster();
  let pointer = new THREE.Vector2();
  let pointsGroup = null;
  let inst = null;
  let resizeObserver = null;
  let reducedMotion = false;
  let starLayers = [];
  let fly = null;
  let tourStep = -1;
  let tourPts = [];
  let lastDown = null;
  let reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function fmt$(n){ return "$"+(n||0).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2}); }
  function fmtInt(n){ return (n||0).toLocaleString(); }
  function fmtTok(n){ if(n>=1e9)return(n/1e9).toFixed(2)+"B"; if(n>=1e6)return(n/1e6).toFixed(2)+"M"; if(n>=1e3)return(n/1e3).toFixed(1)+"k"; return String(n||0); }

  function displayName(raw){
    let name = raw || "unknown";
    try { const s = window.ClaudeMeter && window.ClaudeMeter.surveillance; if (s && typeof s.anonymize === "function") name = s.anonymize(name); } catch(e){}
    try { const r = window.ClaudeMeter && window.ClaudeMeter.redact; if (r && typeof r.apply === "function") name = r.apply(name); } catch(e){}
    return name;
  }

  function visibleEvents(events){
    let out = Array.isArray(events) ? events.slice() : [];
    try { const fb = window.ClaudeMeter && window.ClaudeMeter.filterBar; if (fb && typeof fb.applyFilters === "function") out = fb.applyFilters(out); } catch(e){}
    return out;
  }

  function makeStarLayer(n, rBase, rVar, sz, op, tint){
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n*3), col = new Float32Array(n*3), ph = new Float32Array(n);
    for(let i=0; i<n; i++){
      const th = Math.random()*Math.PI*2, ph0 = Math.acos(2*Math.random()-1);
      let x = Math.sin(ph0)*Math.cos(th), y = Math.sin(ph0)*Math.sin(th), z = Math.cos(ph0);
      const rr = rBase + Math.random()*rVar;
      x*=rr; y*=rr*0.6; z*=rr*0.8;
      pos[i*3]=x; pos[i*3+1]=y; pos[i*3+2]=z;
      const v = 0.7 + Math.random()*0.3; col[i*3]=v*(tint.r||1); col[i*3+1]=v*(tint.g||1); col[i*3+2]=v*(tint.b||1);
      ph[i] = Math.random()*Math.PI*2;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos,3));
    geo.setAttribute('color', new THREE.BufferAttribute(col,3));
    geo.setAttribute('phase', new THREE.BufferAttribute(ph,1));
    const mat = new THREE.PointsMaterial({size:sz, vertexColors:true, transparent:true, opacity:op, depthWrite:false, sizeAttenuation:true, blending:THREE.AdditiveBlending});
    const pts = new THREE.Points(geo, mat);
    pts.userData = {baseOp:op, phases:ph};
    return pts;
  }

  function mount(el){
    if (!el) return;
    root = el;
    root.className = "cstl";
    root.innerHTML =
      '<div class="cstl-head">' +
        '<div class="cstl-title"><h2>3D Session Constellation</h2><p>Clusters for Priya (P3 taxi-meter dread) + Marcus (M8 outlier burns, X3 cache opacity): X=time, Y=log(cost), Z=cache depth. Click spheres to inspect.</p></div>' +
        '<div class="cstl-controls"><button type="button" class="btn" data-cstl-reset>Reset</button><button type="button" class="btn cstl-tour-btn" data-cstl-tour>Tours</button></div>' +
      '</div>' +
      '<div class="cstl-stage" tabindex="0" aria-label="3D session constellation">' +
        '<div class="pcity-empty">Load JSONL or demo data to see sessions.</div>' +
      '</div>' +
      '<div class="cstl-inspector"><div class="pcity-panel" data-cstl-inspector><h3>No selection</h3><p>Click a point for session, project, cost, tokens, cache%.</p></div></div>';

    root.querySelector("[data-cstl-reset]").addEventListener("click", function(){
      if (!camera || !controls) return;
      if (pointsGroup && pointsGroup.userData && pointsGroup.userData.center) {
        const c = pointsGroup.userData.center;
        flyTo({ _x:c.x, _y:c.y, _z:c.z });
      } else {
        camera.position.set(14, 9, 16); controls.target.set(0, 3, 0); controls.update();
      }
    });

    mounted = true;
    reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    resizeObserver = new ResizeObserver(()=>resize());
    resizeObserver.observe(stage());
    render(window.STATE && window.STATE.events ? window.STATE.events : []);
  }

  function stage(){ return root && root.querySelector(".cstl-stage"); }

  function initScene(){
    const host = stage();
    if (!host || renderer) return;
    if (host.clientWidth < 40 || host.clientHeight < 40) return;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.Fog(0x000000, 28, 68);

    camera = new THREE.PerspectiveCamera(48, host.clientWidth / host.clientHeight, 0.1, 120);
    camera.position.set(14, 9, 16);

    renderer = new THREE.WebGLRenderer({ antialias:true, alpha:false, preserveDrawingBuffer:true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.innerHTML = "";
    host.appendChild(renderer.domElement);
    const can=renderer.domElement; can.setAttribute('role','img'); can.setAttribute('aria-label','3D constellation X=time Y=cost Z=cache for Priya X3 cache bridges Marcus M8 burns');

    const mini = document.createElement("canvas");
    mini.className = "cstl-minimap";
    mini.width=68; mini.height=68;
    mini.addEventListener("click", onMinimapClick);
    host.appendChild(mini);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.minDistance = 3;
    controls.maxDistance = 48;
    controls.maxPolarAngle = Math.PI * 0.92;
    controls.addEventListener('change', ()=>{ if(starLayers[2]) starLayers[2].rotation.y = -camera.position.z * 0.0005; if(starLayers[0]) starLayers[0].rotation.x = camera.position.x * -0.0003; });
    host.addEventListener('dblclick', ()=>{ if(!camera||!controls)return; const c=pointsGroup&&pointsGroup.userData&&pointsGroup.userData.center; if(c){camera.position.set(c.x+14,c.y+9,c.z+16);controls.target.set(c.x,c.y,c.z);}else{camera.position.set(14,9,16);controls.target.set(0,3,0);} controls.update(); });

    const p1 = new THREE.PointLight(0x9aa4b8, .7, 120); p1.position.set(18, 22, -14); scene.add(p1);
    const p2 = new THREE.PointLight(0x7f8aa0, .55, 90); p2.position.set(-16, 9, 21); scene.add(p2);
    const p3 = new THREE.PointLight(0xaab8cc, .45, 110); p3.position.set(5, -8, -22); scene.add(p3);

    pointsGroup = new THREE.Group();
    scene.add(pointsGroup);

    if(!starLayers.length){
      starLayers = [
        makeStarLayer(420, 38, 11, .085, .82, {r:1,g:1,b:1.08}),
        makeStarLayer(680, 56, 14, .048, .66, {r:1,g:1,b:1}),
        makeStarLayer(310, 78, 9, .025, .48, {r:0.95,g:0.98,b:1.15})
      ];
      starLayers.forEach(l => scene.add(l));
    }

    host.addEventListener("pointerdown", onPointerDown);
    host.addEventListener("pointerup", onPointerUp);
    const tb = root.querySelector("[data-cstl-tour]");
    if (tb) tb.addEventListener("click", startTour);
    animate();
  }

  function render(events){
    lastEvents = Array.isArray(events) ? events : [];
    if (!mounted && document.getElementById("threeConstellation")) mount(document.getElementById("threeConstellation"));
    if (!root) return;
    const filtered = visibleEvents(lastEvents);

    if (!filtered.length){
      clearScene();
      const host = stage();
      if (host && !renderer) host.innerHTML = '<div class="pcity-empty">Load JSONL or demo data to see sessions.</div>';
      const m = root && root.querySelector(".cstl-minimap"); if(m){ const cx=m.getContext("2d"); cx.fillStyle="#000"; cx.fillRect(0,0,68,68); }
      return;
    }

    initScene();
    if (!renderer) return;
    buildConstellation(filtered);
    // data tie: leverage tint on far star layer for X3 cache bridges (Priya/Marcus)
    const lev = filtered.reduce((s,e)=> s + ((e.crTok||0)/((e.inTok||0)+(e.crTok||0)+(e.cwTok||0)+1)),0) / Math.max(1,filtered.length);
    if(starLayers[2]&&starLayers[2].material) starLayers[2].material.color.set(lev>0.6 ? 0xa8b8ff : 0xcbd5e1);
    resize();
  }

  function clearScene(){
    if (!pointsGroup) return;
    while (pointsGroup.children.length){
      const child = pointsGroup.children.pop();
      disposeObject(child);
    }
    if (inst) { disposeObject(inst); inst = null; }
    pointsGroup.userData = {};
  }

  function buildConstellation(filtered){
    clearScene();
    selected = null;

    const sessSet = new Set(filtered.map(e=>e.session));
    const usePerMsg = sessSet.size < 100;
    let pts = [];

    if (usePerMsg){
      pts = filtered.map(e => ({
        ts: e.tsMs || (e.ts instanceof Date ? +e.ts : +new Date(e.ts||0)),
        cost: e.cost || 0,
        inTok: e.inTok||0, outTok:e.outTok||0, crTok:e.crTok||0, cwTok:e.cwTok||0,
        model: e.model || "unknown",
        project: e.project || "unknown",
        session: e.session || "—",
        msgs: 1,
        tokens: (e.inTok||0)+(e.outTok||0)+(e.crTok||0)+(e.cwTok||0)
      }));
    } else {
      const by = new Map();
      for (const e of filtered){
        if (!by.has(e.session)){
          by.set(e.session, {session:e.session, project:e.project, cost:0, inTok:0, outTok:0, crTok:0, cwTok:0, msgs:0, tsMin:Infinity, tsMax:-Infinity, modelCounts:new Map()});
        }
        const s = by.get(e.session);
        s.cost += e.cost || 0;
        s.inTok += e.inTok||0; s.outTok += e.outTok||0; s.crTok += e.crTok||0; s.cwTok += e.cwTok||0;
        s.msgs++;
        const et = e.tsMs || (e.ts instanceof Date ? +e.ts : +new Date(e.ts||0));
        s.tsMin = Math.min(s.tsMin, et); s.tsMax = Math.max(s.tsMax, et);
        const m = e.model || "unknown";
        s.modelCounts.set(m, (s.modelCounts.get(m)||0) + 1);
      }
      pts = Array.from(by.values()).map(s => {
        let bestM = "unknown", bc = 0;
        s.modelCounts.forEach((c, m)=>{ if (c > bc){ bc = c; bestM = m; } });
        const tokens = s.inTok + s.outTok + s.crTok + s.cwTok;
        const cratio = s.crTok / (s.inTok + s.crTok + s.cwTok + 1);
        return { ts: (s.tsMin + s.tsMax)/2, cost:s.cost, inTok:s.inTok, outTok:s.outTok, crTok:s.crTok, cwTok:s.cwTok, model:bestM, project:s.project, session:s.session, msgs:s.msgs, tokens, cratio };
      });
    }

    if (pts.length > 240){
      const step = Math.ceil(pts.length / 240);
      pts = pts.filter((_,i) => i % step === 0);
    }
    if (!pts.length) return;

    let minT = Infinity, maxT = -Infinity, maxC = 0, sumCr = 0;
    pts.forEach(p => { minT = Math.min(minT, p.ts); maxT = Math.max(maxT, p.ts); maxC = Math.max(maxC, p.cost||0); const cr = (p.cratio != null ? p.cratio : ((p.crTok ||0) / ((p.inTok||0)+(p.crTok||0)+(p.cwTok||0)+1) || 0)); sumCr += cr; });
    const rT = (maxT - minT) || 1;
    const avgCr = (pts.length ? sumCr / pts.length : 0);
    if (starLayers.length){
      const t = Math.max(0.7, Math.min(1.15, 0.85 + avgCr*0.55));
      starLayers[0].material.color.setRGB(t, t, t*1.1);
      starLayers[1].material.color.setRGB(t*0.98, t, t*1.05);
      starLayers[2].material.color.setRGB(t*0.92, t*0.96, t*1.18);
    }

    const geo = new THREE.SphereGeometry(0.1, 9, 9);
    const mat = new THREE.MeshPhongMaterial({ shininess:7, emissive:0x111a22 });
    inst = new THREE.InstancedMesh(geo, mat, pts.length);

    const dummy = new THREE.Object3D();
    const modelToCol = new Map();
    let cidx = 0;
    const getCol = (m) => { if (!modelToCol.has(m)) modelToCol.set(m, MODEL_COLORS[cidx++ % MODEL_COLORS.length]); return modelToCol.get(m); };

    const xs = [], ys = [], zs = [];
    pts.forEach((p, i) => {
      const x = ((p.ts - minT) / rT - 0.5) * 18;
      let y = Math.log1p((p.cost || 0) * 140) * 1.65; if (y > 11) y = 11; if (y < 0.08) y = 0.08;
      const cr = (p.cratio != null ? p.cratio : ((p.crTok) / (p.inTok + p.crTok + p.cwTok + 1) || 0));
      const z = (cr - 0.5) * 13;
      p._x = x; p._y = y; p._z = z;
      xs.push(x); ys.push(y); zs.push(z);
      dummy.position.set(x, y, z);
      const tokC = (p.tokens||1) + (p.cost||0)*120;
      const r = Math.max(0.04, Math.min(0.42, Math.log1p(tokC / 480) * 0.21));
      dummy.scale.set(r, r, r);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
      inst.setColorAt(i, new THREE.Color(getCol(p.model)));
      const rec = (p.ts - minT) / rT;
      p._pulseSpd = 0.9 + cr * 1.8 + (1-rec)*0.6;
      p._pulsePh = i * 0.7;
      p._baseR = r;
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.userData.points = pts;
    pointsGroup.add(inst);

    if (pts.length > 4){
      const ogeo = new THREE.BufferGeometry();
      const oposs = []; const ocols = [];
      for(let i=1; i<pts.length; i+=2){
        const a = pts[i-1], b=pts[i];
        const cr = (a.cratio||0) * 0.6 + 0.2;
        oposs.push(a._x||0, a._y||0, a._z||0, b._x||0, b._y||0, b._z||0);
        ocols.push(0.55,0.6+cr*0.2,0.9, 0.4,0.5+cr*0.3,0.85);
      }
      if (oposs.length){
        ogeo.setAttribute('position', new THREE.Float32BufferAttribute(oposs,3));
        ogeo.setAttribute('color', new THREE.Float32BufferAttribute(ocols,3));
        const ol = new THREE.LineSegments(ogeo, new THREE.LineBasicMaterial({vertexColors:true, transparent:true, opacity:0.28, blending:THREE.AdditiveBlending}));
        pointsGroup.add(ol);
      }
    }

    addGridAndAxes(xs, ys, zs);

    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2 * 0.7;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    pointsGroup.userData.center = {x:cx, y:cy, z:cz};

    autoFit(xs, ys, zs);
    drawMinimap(pts);
    updateInspector(null, pts.length);
  }

  function addGridAndAxes(xs,ys,zs){
    const gmat = new THREE.MeshStandardMaterial({ color:0x1a1f2a, roughness:0.95, transparent:true, opacity:0.22 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 16), gmat);
    floor.rotation.x = -Math.PI * 0.5;
    floor.position.y = 0.01;
    pointsGroup.add(floor);

    const lmat = new THREE.MeshStandardMaterial({ color:0x232a38, roughness:0.9, transparent:true, opacity:0.26 });
    for (let i = -2; i <= 2; i++){
      let lx = new THREE.Mesh(new THREE.BoxGeometry(18, 0.015, 0.015), lmat);
      lx.position.set(0, 0.02, i * 3.2);
      pointsGroup.add(lx);
      let lz = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.015, 16), lmat);
      lz.position.set(i * 3.2, 0.02, 0);
      pointsGroup.add(lz);
    }

    const amat = new THREE.MeshStandardMaterial({ color:0x3a4354, roughness:0.7 });
    const axx = new THREE.Mesh(new THREE.BoxGeometry(18, 0.05, 0.05), amat); axx.position.set(0, 0.04, -8.8); pointsGroup.add(axx);
    const axy = new THREE.Mesh(new THREE.BoxGeometry(0.05, 11, 0.05), amat); axy.position.set(-9.2, 5.5, -8.8); pointsGroup.add(axy);
    const axz = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 13), amat); axz.position.set(-9.2, 0.04, 0); pointsGroup.add(axz);
  }

  function autoFit(xs, ys, zs){
    if (!camera || !controls || !xs.length || fly) return;
    const minx = Math.min(...xs), maxx = Math.max(...xs);
    const miny = Math.min(...ys), maxy = Math.max(...ys);
    const minz = Math.min(...zs), maxz = Math.max(...zs);
    const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2 * 0.65, cz = (minz + maxz) / 2;
    const dx = Math.max(0.1, maxx - minx), dy = Math.max(2, maxy - miny), dz = Math.max(1, maxz - minz);
    const size = Math.max(dx, dy, dz);
    const dist = size * 2.1 / Math.tan((camera.fov * 0.5 * Math.PI) / 180);
    camera.position.set(cx + dist * 0.55, cy + dist * 0.38, cz + dist * 0.95);
    controls.target.set(cx, cy, cz);
    controls.update();
  }

  function updateInspector(pt, total){
    const ins = root && root.querySelector("[data-cstl-inspector]");
    if (!ins) return;
    if (!pt){
      ins.innerHTML = '<h3>'+ (total||0) +' sessions</h3><p>Click point: session id, project, cost, tokens, cache leverage.</p>';
      return;
    }
    const cr = (pt.cratio != null ? pt.cratio : (pt.crTok / (pt.inTok + pt.crTok + pt.cwTok + 1) || 0));
    ins.innerHTML =
      '<h3>' + escapeHtml(pt.session) + '</h3>' +
      '<p><strong>' + fmt$(pt.cost) + '</strong> · ' + fmtTok(pt.tokens) + ' tok · ' + (pt.msgs||1) + ' msgs · cache ' + (cr*100).toFixed(0) + '%<br>' +
      'project: ' + escapeHtml(displayName(pt.project)) + ' · ' + escapeHtml(pt.model) + '</p>';
  }

  function flyTo(pt){
    if (!camera || !controls || !pt) return;
    const cx = pt._x || 0, cy=(pt._y||0)*0.7, cz = pt._z || 0;
    const dist = 7.5;
    fly = { tx: cx, ty: cy, tz: cz, px: cx+dist*0.6, py:cy+dist*0.5, pz:cz+dist*0.9, pr:0, dur:920, onDone: null };
    controls.enabled = false;
  }
  function startTour(){
    if (!inst || !inst.userData.points) return;
    const pts = inst.userData.points.slice();
    pts.sort((a,b)=> (b.cost||0)-(a.cost||0));
    tourPts = pts.slice(0, Math.min(5,pts.length));
    tourStep = 0;
    if (tourPts.length) flyTo(tourPts[0]);
  }

  function drawMinimap(pts){
    const c = root && root.querySelector(".cstl-minimap");
    if (!c || !pts || !pts.length) return;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#000"; ctx.fillRect(0,0,68,68);
    let minx=99,maxx=-99,miny=99,maxy=-99;
    pts.forEach(p=>{ if(p._x!=null){ minx=Math.min(minx,p._x); maxx=Math.max(maxx,p._x); miny=Math.min(miny,p._y); maxy=Math.max(maxy,p._y); }});
    const rw = (maxx-minx)||1, rh=(maxy-miny)||1;
    ctx.fillStyle = "#6b7a94";
    pts.forEach((p,i)=>{
      if(p._x==null) return;
      const nx = (p._x - minx)/rw * 62 + 3;
      const ny = 65 - ((p._y - miny)/rh * 62 + 3);
      ctx.fillRect(nx,ny,1.6,1.6);
    });
  }
  function onMinimapClick(ev){
    const c = ev.currentTarget;
    if (!c || !inst || !inst.userData.points) return;
    const pts = inst.userData.points;
    const r = c.getBoundingClientRect();
    const mx = ((ev.clientX - r.left)/r.width - 0.5) * 2;
    const my = ((ev.clientY - r.top)/r.height - 0.5) * 2;
    let best=null, bd=99;
    let minx=99,maxx=-99,miny=99,maxy=-99;
    pts.forEach(p=>{ if(p._x!=null){ minx=Math.min(minx,p._x); maxx=Math.max(maxx,p._x); miny=Math.min(miny,p._y); maxy=Math.max(maxy,p._y); }});
    const rw = (maxx-minx)||1, rh=(maxy-miny)||1;
    pts.forEach(p=>{
      if(p._x==null) return;
      const nx = (p._x - minx)/rw * 2 -1;
      const ny = 1 - ((p._y - miny)/rh * 2 -1) * (rh>0?1:0);
      const d = Math.hypot(nx-mx, ny-my);
      if(d<bd){ bd=d; best=p; }
    });
    if(best) flyTo(best);
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, ch=>({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
  }

  function onPointerDown(ev){
    lastDown = {x:ev.clientX, y:ev.clientY, t:Date.now()};
  }
  function onPointerUp(ev){
    if (!lastDown || !renderer || !camera || !inst) { lastDown=null; return; }
    const dx = Math.abs(ev.clientX - lastDown.x), dy = Math.abs(ev.clientY - lastDown.y);
    if (dx > 6 || dy > 6 || Date.now()-lastDown.t > 420) { lastDown=null; return; }
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(inst);
    if (hits.length && typeof hits[0].instanceId === "number"){
      const i = hits[0].instanceId;
      const pt = (inst.userData.points || [])[i];
      if (pt){ selected = pt; updateInspector(pt); flyTo(pt); }
    }
    lastDown = null;
  }

  function resize(){
    const host = stage();
    if (!host) return;
    if (!renderer){
      if (lastEvents && lastEvents.length) render(lastEvents);
      return;
    }
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w < 40 || h < 40) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  function animate(){
    raf = requestAnimationFrame(animate);
    if (!renderer || !scene || !camera) return;
    const t = Date.now() * 0.001;
    if (controls) controls.update();
    if (pointsGroup) pointsGroup.rotation.y += reducedMotion ? 0 : 0.00055;
    if (starLayers.length){
      if(!reducedMotion){
        starLayers[0].rotation.y = t * 0.003;
        starLayers[1].rotation.y = -t * 0.0018;
        starLayers[2].rotation.y = t * 0.0009;
      }
      starLayers.forEach((l,i)=>{
        const m = l.material;
        const base = l.userData.baseOp || 0.6;
        m.opacity = base + Math.sin(t * (1.6 + i*0.7) + (l.userData.phases? l.userData.phases[0]:0)) * 0.09;
      });
    }
    if (fly && camera && controls){
      fly.pr = Math.min(1, fly.pr + 0.026);
      camera.position.x += (fly.px - camera.position.x) * 0.11;
      camera.position.y += (fly.py - camera.position.y) * 0.11;
      camera.position.z += (fly.pz - camera.position.z) * 0.11;
      controls.target.x += (fly.tx - controls.target.x)*0.14;
      controls.target.y += (fly.ty - controls.target.y)*0.14;
      controls.target.z += (fly.tz - controls.target.z)*0.14;
      if (fly.pr > 0.999){
        const done = fly.onDone; fly = null; controls.enabled = true; controls.update();
        if (done) done();
        else if (tourStep >=0 && tourPts.length){ tourStep++; if(tourStep < tourPts.length) flyTo(tourPts[tourStep]); else tourStep=-1; }
      }
    }
    if (inst && inst.userData.points && !reducedMotion){
      const dmy = new THREE.Object3D(); const pts = inst.userData.points;
      for(let i=0; i<pts.length; i++){
        const p = pts[i]; if(!p._baseR) continue;
        const s = p._baseR * (1 + Math.sin(t * (p._pulseSpd||1.1) + (p._pulsePh||i)) * 0.085);
        dmy.position.set(p._x||0, p._y||0, p._z||0);
        dmy.scale.set(s,s,s);
        dmy.updateMatrix();
        inst.setMatrixAt(i, dmy.matrix);
      }
      inst.instanceMatrix.needsUpdate = true;
    }
    renderer.render(scene, camera);
  }

  function disposeObject(obj){
    obj.traverse(function(child){
      if (child.geometry) child.geometry.dispose();
      if (child.material){
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(m=>{ if (m.map) m.map.dispose(); m.dispose(); });
      }
    });
  }

  function destroy(){
    if (raf) cancelAnimationFrame(raf);
    if (resizeObserver) resizeObserver.disconnect();
    starLayers.forEach(l => { scene && scene.remove(l); disposeObject(l); });
    starLayers = [];
    clearScene();
    if (renderer) renderer.dispose();
    renderer = scene = camera = controls = root = null;
    mounted = false;
  }

  window.ClaudeMeter.threeConstellation = { mount, render, destroy, resize };

  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", function(){ mount(document.getElementById("threeConstellation")); });
  } else {
    mount(document.getElementById("threeConstellation"));
  }
})();
