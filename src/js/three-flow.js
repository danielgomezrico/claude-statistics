import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

(function(){
  "use strict";

  window.ClaudeMeter = window.ClaudeMeter || {};

  const COLORS = {
    input: 0x6ea8ff,
    output: 0xd97757,
    cacheRead: 0x22c55e,
    cacheWrite: 0xeab308,
    process: 0x6b7280,
    tube: 0x475569,
    glow: 0x22c55e
  };

  const NODES = [
    { id: "fresh", label: "Fresh Input", pos: [-8, 3.2, 0], color: COLORS.input, desc: "new tokens paid full price" },
    { id: "write", label: "Cache Write", pos: [-8, -3.2, 0], color: COLORS.cacheWrite, desc: "paid 1.25x premium to store" },
    { id: "process", label: "Processing", pos: [0, 0, 0], color: COLORS.process, desc: "model inference" },
    { id: "output", label: "Output", pos: [8, 3.2, 0], color: COLORS.output, desc: "generated tokens" },
    { id: "read", label: "Cache Read", pos: [8, -3.2, 0], color: COLORS.cacheRead, desc: "savings at 0.1x price" }
  ];

  const PATH_DEFS = [
    { from: "fresh", to: "process", key: "inT", label: "fresh → process" },
    { from: "write", to: "process", key: "cwT", label: "write → process" },
    { from: "process", to: "output", key: "outT", label: "process → output" },
    { from: "write", to: "read", key: "crT", label: "cache leverage", leverage: true }
  ];

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
  let flowGroup = null;
  let resizeObserver = null;
  let particles = []; // {mesh, curve, speed, phase}
  let tubeMeshes = [];
  let nodeMeshes = [];
  let starLayers = [];
  let reducedMotion = false;

  function fmt$(n){ return "$"+(n||0).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2}); }
  function fmtTok(n){ if(n>=1e9)return(n/1e9).toFixed(2)+"B"; if(n>=1e6)return(n/1e6).toFixed(2)+"M"; if(n>=1e3)return(n/1e3).toFixed(1)+"k"; return String(n||0); }
  function fmtInt(n){ return (n||0).toLocaleString(); }

  function priceFor(model){
    const pricing = window.PRICING || [];
    const m = (model||"").toLowerCase();
    return pricing.find(p=>p.match && m.includes(p.match)) || pricing[pricing.length-1] || { in:3, out:15, cacheRead:.3, cacheWrite:3.75 };
  }

  function visibleEvents(events){
    let out = Array.isArray(events) ? events.slice() : [];
    try {
      const fb = window.ClaudeMeter && window.ClaudeMeter.filterBar;
      if (fb && typeof fb.applyFilters === "function") out = fb.applyFilters(out);
    } catch(e){}
    return out;
  }

  function aggregate(events){
    const filtered = visibleEvents(events || []);
    const isInt = (window.ClaudeMeter && window.ClaudeMeter.parserCore && window.ClaudeMeter.parserCore.isInternalAgentProject) ||
      (p => ["subagents",".worktree",".agents","worktree","agents"].indexOf(String(p)) >= 0);

    let inT = 0, outT = 0, crT = 0, cwT = 0;
    let costIn = 0, costOut = 0, costCR = 0, costCW = 0;
    let msgs = 0;
    for (const e of filtered){
      const proj = e.project || e.attribution || "unknown";
      if (isInt(proj)) continue;
      inT += e.inTok || 0;
      outT += e.outTok || 0;
      crT += e.crTok || 0;
      cwT += e.cwTok || 0;
      const p = priceFor(e.model);
      costIn += ((e.inTok||0) * p.in) / 1e6;
      costOut += ((e.outTok||0) * p.out) / 1e6;
      costCR += ((e.crTok||0) * p.cacheRead) / 1e6;
      costCW += ((e.cwTok||0) * p.cacheWrite) / 1e6;
      msgs += 1;
    }
    const totalTok = inT + outT + crT + cwT;
    const totalCost = costIn + costOut + costCR + costCW;
    const leverage = cwT > 0 ? (crT / cwT) : 0;
    const cacheSavings = costCR; // at low price
    const writePremiumPaid = costCW;
    return { inT, outT, crT, cwT, costIn, costOut, costCR, costCW, totalTok, totalCost, leverage, cacheSavings, writePremiumPaid, msgs };
  }

  function mount(el){
    if (!el) return;
    root = el;
    root.className = "tflow";
    root.innerHTML =
      '<div class="tflow-head">' +
        '<div class="tflow-title"><h2>3D Cache Flow</h2><p>Flows show token volume (tube radius). Cache write → read arc reveals leverage (reads per write). Attacks cache opacity (Priya: "could not tell cache read vs write"; Marcus: "criminal"; Sofia: waste; Jake: amortization).</p></div>' +
        '<div class="tflow-controls"><button type="button" class="btn" data-tflow-reset>Reset view</button></div>' +
      '</div>' +
      '<div class="tflow-stage" tabindex="0" aria-label="3D cache flow tubes">' +
        '<div class="tflow-empty">Load JSONL or demo data to see token flows.</div>' +
      '</div>' +
      '<div class="tflow-inspector">' +
        '<div class="tflow-panel" data-tflow-inspector><h3>No selection</h3><p>Click a node to inspect volumes + cache multiplier. Side view makes volume comparison pop.</p></div>' +
        '<div class="tflow-panel"><h3>Totals</h3><div class="tflow-list" data-tflow-totals></div><div class="tflow-legend" data-tflow-legend style="margin-top:8px"></div></div>' +
      '</div>';

    const resetBtn = root.querySelector("[data-tflow-reset]");
    if (resetBtn) resetBtn.addEventListener("click", function(){
      if (!camera || !controls) return;
      camera.position.set(14, 3.5, 11);
      controls.target.set(0, 0, 0);
      controls.update();
    });

    mounted = true;
    reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    resizeObserver = new ResizeObserver(()=>resize());
    resizeObserver.observe(stage());
    render(window.STATE && window.STATE.events ? window.STATE.events : []);
  }

  function stage(){ return root && root.querySelector(".tflow-stage"); }

  function initScene(){
    const host = stage();
    if (!host || renderer) return;
    if (host.clientWidth < 50 || host.clientHeight < 50) return;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.Fog(0x000000, 18, 48);

    camera = new THREE.PerspectiveCamera(48, host.clientWidth / host.clientHeight, 0.1, 100);
    camera.position.set(14, 3.5, 11); // side-angled view so tube radii (volumes) compare easily left-to-right

    renderer = new THREE.WebGLRenderer({ antialias:true, alpha:false, preserveDrawingBuffer:true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.innerHTML = "";
    host.appendChild(renderer.domElement);
    const can=renderer.domElement; can.setAttribute('role','img'); can.setAttribute('aria-label','3D cache flow tubes revealing leverage for Priya X3 and Sofia S3 waste');
    host.addEventListener("pointerdown", onPointer, { once: false });

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.minDistance = 6;
    controls.maxDistance = 36;
    controls.maxPolarAngle = Math.PI * 0.82;
    controls.target.set(0, 0, 0);
    controls.addEventListener('change', onControlChange);
    host.addEventListener('dblclick', ()=>{ if(camera&&controls){camera.position.set(14,3.5,11);controls.target.set(0,0,0);controls.update();} });

    scene.add(new THREE.HemisphereLight(0xe8ecff, 0x1f2937, 1.8));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(6, 14, 8);
    scene.add(sun);

    flowGroup = new THREE.Group();
    scene.add(flowGroup);

    makeStarLayers();
    animate();
  }

  function render(events){
    lastEvents = Array.isArray(events) ? events : [];
    if (!mounted && document.getElementById("threeFlow")) mount(document.getElementById("threeFlow"));
    if (!root) return;
    const data = aggregate(lastEvents);
    renderPanels(data);

    if (!lastEvents.length || data.totalTok < 1){
      clearScene();
      const host = stage();
      if (host){
        host.innerHTML = '<div class="tflow-empty">Load JSONL or demo data to see token flows.</div>';
      }
      if (renderer){ try{ renderer.dispose(); }catch(_){} renderer=null; scene=null; camera=null; controls=null; }
      return;
    }

    initScene();
    if (!renderer) return;
    buildFlow(data);
    resize();
  }

  function clearScene(){
    particles = [];
    tubeMeshes = [];
    nodeMeshes = [];
    if (!flowGroup) return;
    while (flowGroup.children.length){
      const c = flowGroup.children.pop();
      disposeObject(c);
    }
  }

  function buildFlow(data){
    clearScene();
    selected = null;

    // nodes
    const nodeMap = {};
    NODES.forEach((n, i)=>{
      const g = new THREE.Group();
      const [x,y,z] = n.pos;
      g.position.set(x,y,z);
      g.userData = { node: n, id: n.id };

      const r = n.id === "process" ? 1.1 : 1.35;
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(r, 28, 20),
        new THREE.MeshStandardMaterial({ color: n.color, roughness: 0.6, metalness: 0.15, emissive: n.id==="read" ? 0x052e16 : 0x000000, emissiveIntensity: 0.25 })
      );
      mesh.userData = { node: n, id: n.id };
      g.add(mesh);
      nodeMeshes.push(mesh);

      // subtle ring for leverage node
      if (n.id === "read" || n.id === "write"){
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(r + 0.35, 0.04, 10, 28),
          new THREE.MeshStandardMaterial({ color: n.id==="read" ? COLORS.glow : COLORS.cacheWrite, roughness:0.7, transparent:true, opacity:0.6 })
        );
        ring.rotation.x = Math.PI * 0.5;
        g.add(ring);
      }

      // label
      g.add(labelSprite(n.label, 0, r + 1.6, 0, n.id==="process" ? 1.8 : 2.1));
      flowGroup.add(g);
      nodeMap[n.id] = { group:g, mesh, def:n };
    });

    // tubes + paths
    const scaleBase = Math.max(1, Math.sqrt(data.totalTok) * 0.0009);
    PATH_DEFS.forEach((pd, idx)=>{
      const a = nodeMap[pd.from];
      const b = nodeMap[pd.to];
      if (!a || !b) return;
      const v = data[pd.key] || 0;
      const rad = Math.max(0.09, Math.min(1.6, Math.pow(v / Math.max(1, data.totalTok), 0.55) * 4.2 * scaleBase + (pd.leverage ? 0.06 : 0)));
      const p0 = a.def.pos;
      const p1 = b.def.pos;
      const curve = makeCurve(p0, p1, pd.leverage);
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 42, rad, 9, false),
        new THREE.MeshStandardMaterial({
          color: pd.leverage ? COLORS.cacheRead : (pd.key==="cwT" ? COLORS.cacheWrite : (pd.key==="inT"? COLORS.input : COLORS.output)),
          roughness: pd.leverage ? 0.45 : 0.65,
          metalness: pd.leverage ? 0.2 : 0.08,
          transparent: pd.leverage,
          opacity: pd.leverage ? 0.92 : 0.85
        })
      );
      tube.userData = { path: pd, vol: v, from:pd.from, to:pd.to };
      flowGroup.add(tube);
      tubeMeshes.push(tube);

      // leverage highlight arc (thinner glowing companion)
      if (pd.leverage){
        const glowR = Math.max(0.05, rad * 0.72);
        const glow = new THREE.Mesh(
          new THREE.TubeGeometry(curve, 42, glowR, 7, false),
          new THREE.MeshStandardMaterial({ color: COLORS.glow, emissive:0x052e16, emissiveIntensity:0.8, roughness:0.3, transparent:true, opacity:0.55 })
        );
        flowGroup.add(glow);
        tubeMeshes.push(glow);
      }

      // particles for flow (light animation)
      if (v > 0){
        const nParts = pd.leverage ? 5 : 3;
        for (let k=0; k<nParts; k++){
          const m = new THREE.Mesh(
            new THREE.SphereGeometry(Math.max(0.07, Math.min(0.18, rad*0.55)), 8, 8),
            new THREE.MeshBasicMaterial({ color: pd.leverage ? 0x86efac : 0x94a3b8, transparent:true, opacity:0.9, blending:THREE.AdditiveBlending, depthWrite:false })
          );
          m.userData = { t: (k / nParts) + (idx*0.13) % 1, speed: pd.leverage ? 0.019 : 0.014, curve, pathId: idx };
          flowGroup.add(m);
          particles.push(m);
        }
      }
    });

    // base platform for depth
    const base = new THREE.Mesh(
      new THREE.PlaneGeometry(22, 12),
      new THREE.MeshStandardMaterial({ color:0x0f141f, roughness:0.95, metalness:0.02 })
    );
    base.rotation.x = -Math.PI * 0.5;
    base.position.y = -5.2;
    flowGroup.add(base);
  }

  function makeCurve(p0, p1, isLeverage){
    const a = new THREE.Vector3(p0[0],p0[1],p0[2]);
    const b = new THREE.Vector3(p1[0],p1[1],p1[2]);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    // side curve + slight lift for leverage to pop the return flow
    mid.z = isLeverage ? 4.2 : 2.8;
    mid.y += isLeverage ? 1.1 : 0.6;
    return new THREE.QuadraticBezierCurve3(a, mid, b);
  }

  function labelSprite(text, x, y, z, w=2.6){
    const c = document.createElement("canvas");
    c.width = 256; c.height = 48;
    const ctx = c.getContext("2d");
    ctx.clearRect(0,0,c.width,c.height);
    ctx.fillStyle = "rgba(11,13,18,.82)";
    roundRect(ctx, 4, 4, 248, 40, 8);
    ctx.fill();
    ctx.font = "bold 15px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillStyle = "#e6e8ee";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(text, 128, 24);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map:tex, transparent:true, depthWrite:false });
    const sp = new THREE.Sprite(mat);
    sp.position.set(x,y,z);
    sp.scale.set(w, 0.52, 1);
    return sp;
  }
  function roundRect(ctx, x, y, w, h, r){
    ctx.beginPath();
    ctx.moveTo(x+r, y);
    ctx.arcTo(x+w, y, x+w, y+h, r);
    ctx.arcTo(x+w, y+h, x, y+h, r);
    ctx.arcTo(x, y+h, x, y, r);
    ctx.arcTo(x, y, x+w, y, r);
    ctx.closePath();
  }

  function renderPanels(data){
    if (!root) return;
    const list = root.querySelector("[data-tflow-totals]");
    if (list){
      list.innerHTML = "";
      const rows = [
        ["Fresh input", fmtTok(data.inT), fmt$(data.costIn)],
        ["Cache writes", fmtTok(data.cwT), fmt$(data.costCW)],
        ["Output", fmtTok(data.outT), fmt$(data.costOut)],
        ["Cache reads", fmtTok(data.crT), fmt$(data.costCR)],
      ];
      rows.forEach(([lab, tok, cst])=>{
        const d = document.createElement("div");
        d.className = "tflow-row";
        d.innerHTML = '<span>'+lab+'</span><span class="cm-redact-target">'+tok+' · '+cst+'</span>';
        list.appendChild(d);
      });
      const lev = document.createElement("div");
      lev.style.marginTop = "6px";
      lev.style.fontSize = "11px";
      lev.innerHTML = '<span style="color:#22c55e">Leverage: '+ (data.leverage ? data.leverage.toFixed(1) : "0") +'× reads/write</span> · savings ' + fmt$(data.cacheSavings);
      list.appendChild(lev);
    }
    const leg = root.querySelector("[data-tflow-legend]");
    if (leg){
      leg.innerHTML = [
        ["input", "Fresh input"],
        ["cacheWrite", "Cache write"],
        ["output", "Output"],
        ["cacheRead", "Cache read"]
      ].map(([k,l]) => {
        const col = k==="input"?COLORS.input : k==="cacheWrite"?COLORS.cacheWrite : k==="output"?COLORS.output : COLORS.cacheRead;
        return '<span class="tflow-chip"><span class="tflow-swatch" style="background:#'+col.toString(16).padStart(6,"0")+'"></span>'+l+'</span>';
      }).join("");
    }

    const insp = root.querySelector("[data-tflow-inspector]");
    if (insp && !selected){
      insp.innerHTML = '<h3>Cache is the moat</h3><p>Left: paid tokens. Right: results + savings. Big read tubes from write = cheap reuse (Priya/Marcus pain solved visually).</p>';
    }
  }

  function renderSelection(nodeId, data){
    selected = nodeId;
    const insp = root && root.querySelector("[data-tflow-inspector]");
    if (!insp) return;
    const n = NODES.find(x=>x.id===nodeId);
    if (!n) return;
    let html = '<h3>'+n.label+'</h3>';
    if (nodeId==="fresh") html += '<p>'+fmtTok(data.inT)+' tokens · '+fmt$(data.costIn)+'. Full price input that never hit cache.</p>';
    else if (nodeId==="write") html += '<p>'+fmtTok(data.cwT)+' tokens written at premium. '+fmt$(data.costCW)+'. This is the "investment".</p>';
    else if (nodeId==="process") html += '<p>Total processed: '+fmtTok(data.totalTok)+'. All paths converge here.</p>';
    else if (nodeId==="output") html += '<p>'+fmtTok(data.outT)+' output tokens · '+fmt$(data.costOut)+'. What you actually wanted.</p>';
    else if (nodeId==="read") html += '<p>'+fmtTok(data.crT)+' tokens read from cache for ~1/10 price. Leverage '+data.leverage.toFixed(1)+'×. '+fmt$(data.cacheSavings)+' saved.</p>';
    insp.innerHTML = html + '<div style="margin-top:6px;font-size:11px;opacity:.7">Click elsewhere or reset to clear.</div>';
    // highlight related tubes
    highlightTubesFor(nodeId);
  }

  function highlightTubesFor(nodeId){
    tubeMeshes.forEach(m=>{
      if (!m) return;
      m.scale.setScalar(1);
      if (m.material && m.material.emissive) m.material.emissive.setHex(0x000000);
    });
    tubeMeshes.forEach(m=>{
      if (!m || !m.material) return;
      const pd = m.userData && m.userData.path;
      const hit = pd && (pd.from===nodeId || pd.to===nodeId);
      if (hit){
        m.scale.setScalar(1.18);
        if (m.material.emissive) m.material.emissive.setHex(0x334155);
      }
    });
  }

  function onPointer(ev){
    if (!renderer || !camera || !flowGroup) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(flowGroup.children, true);
    const hit = hits.find(h => h.object && h.object.userData && (h.object.userData.id || h.object.userData.node));
    if (hit){
      const id = hit.object.userData.id || (hit.object.userData.node && hit.object.userData.node.id);
      if (id) renderSelection(id, aggregate(lastEvents));
    }
  }

  function resize(){
    const host = stage();
    if (!host) return;
    if (!renderer){
      if (lastEvents && lastEvents.length) render(lastEvents);
      return;
    }
    const w = host.clientWidth, h=host.clientHeight;
    if (w<50 || h<50) return;
    camera.aspect = w/h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  function makeStarLayers(){
    starLayers.forEach(l=>{if(scene)scene.remove(l);disposeObject(l);}); starLayers=[];
    const cfgs=[{n:420,r:76,s:0.03,o:0.34,f:0.55,rot:0.0007},{n:680,r:49,s:0.05,o:0.56,f:1.7,rot:0.0015},{n:320,r:28,s:0.07,o:0.71,f:3.3,rot:0.0024}];
    cfgs.forEach((c,i)=>{
      const p=new Float32Array(c.n*3);
      for(let j=0;j<c.n*3;j+=3){const r=c.r+Math.random()*22;const th=Math.random()*Math.PI*2;const ph=Math.acos(2*Math.random()-1);p[j]=r*Math.sin(ph)*Math.cos(th);p[j+1]=r*Math.sin(ph)*Math.sin(th)*0.6;p[j+2]=r*Math.cos(ph)*0.75-4;}
      const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(p,3));
      const m=new THREE.PointsMaterial({size:c.s,color:0xc8d2e3,opacity:c.o,depthWrite:false,sizeAttenuation:true,transparent:true});
      const pts=new THREE.Points(g,m); pts.userData={f:c.f,rot:c.rot,ph:i}; scene.add(pts); starLayers.push(pts);
    });
    if(starLayers[0]&&starLayers[0].geometry&&starLayers[0].geometry.attributes.position){
      const a=starLayers[0].geometry.attributes.position.array; [0,2].forEach(k=>{const ii=(k*29)%(a.length/3)*3; const pl=new THREE.PointLight(0xcbd5e1,0.5,130); pl.position.set(a[ii]||-6,a[ii+1]||8,a[ii+2]||10); scene.add(pl);});
    }
  }
  function onControlChange(){
    if(!camera||!starLayers.length)return; const fx=camera.position.x*-0.0004; starLayers[0].rotation.y=fx; if(starLayers[2])starLayers[2].rotation.y=fx*0.6;
  }
  function animate(){
    raf = requestAnimationFrame(animate);
    if (!renderer || !scene || !camera) return;
    if (controls) controls.update();

    // animate particles along curves
    particles.forEach(p=>{
      if (!p.userData.curve) return;
      p.userData.t = (p.userData.t + p.userData.speed) % 1;
      const pt = p.userData.curve.getPoint(p.userData.t);
      if (pt) p.position.copy(pt);
      // fade pulse
      if (p.material && p.material.opacity != null){
        const pulse = 0.65 + Math.sin(p.userData.t * 12) * 0.3;
        p.material.opacity = Math.max(0.35, pulse);
      }
    });

    // gentle idle rotate on group when not interacting much
    if (flowGroup) flowGroup.rotation.y = (flowGroup.rotation.y + (reducedMotion?0:0.00055)) % (Math.PI * 2);
    if(!reducedMotion && starLayers.length){
      const t=Date.now()*0.001; starLayers.forEach((l,i)=>{ if(l.material){l.material.opacity=[0.34,0.56,0.71][i]+Math.sin(t*(l.userData.f||2)+(l.userData.ph||0))*0.08;l.material.needsUpdate=true;} if(l.userData.rot)l.rotation.y+=l.userData.rot; });
    }

    renderer.render(scene, camera);
  }

  function disposeObject(obj){
    obj.traverse(function(child){
      if (child.geometry) child.geometry.dispose();
      if (child.material){
        const ms = Array.isArray(child.material) ? child.material : [child.material];
        ms.forEach(m=>{
          if (m.map) m.map.dispose();
          m.dispose();
        });
      }
    });
  }

  function destroy(){
    if (raf) cancelAnimationFrame(raf);
    if (resizeObserver) resizeObserver.disconnect();
    clearScene();
    if (renderer) renderer.dispose();
    renderer = scene = camera = controls = root = null;
    mounted = false;
  }

  window.ClaudeMeter.threeFlow = { mount, render, destroy, resize };

  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", function(){ mount(document.getElementById("threeFlow")); });
  } else {
    // mount is called explicitly from index.html
  }
})();
