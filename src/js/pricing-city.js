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
    road: 0x8a93a6,
    plan: 0x6ea8ff,
    ground: 0x1b2230,
    text: "#e6e8ee"
  };
  const TOKEN_KEYS = [
    ["input", "Input"],
    ["output", "Output"],
    ["cacheRead", "Cache read"],
    ["cacheWrite", "Cache write"]
  ];
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
  let viewMode = "projects";
  let raycaster = new THREE.Raycaster();
  let pointer = new THREE.Vector2();
  let cityGroup = null;
  let resizeObserver = null;

  function fmt$(n){ return "$"+(n||0).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2}); }
  function fmtInt(n){ return (n||0).toLocaleString(); }
  function fmtTok(n){ if(n>=1e9)return(n/1e9).toFixed(2)+"B"; if(n>=1e6)return(n/1e6).toFixed(2)+"M"; if(n>=1e3)return(n/1e3).toFixed(1)+"k"; return String(n||0); }

  function displayName(raw){
    let name = raw || "unknown";
    try {
      const s = window.ClaudeMeter && window.ClaudeMeter.surveillance;
      if (s && typeof s.anonymize === "function") name = s.anonymize(name);
    } catch(e){}
    try {
      const r = window.ClaudeMeter && window.ClaudeMeter.redact;
      if (r && typeof r.apply === "function") name = r.apply(name);
    } catch(e){}
    return name;
  }

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

  function costParts(e){
    const p = priceFor(e.model);
    return {
      input: ((e.inTok||0)*p.in)/1e6,
      output: ((e.outTok||0)*p.out)/1e6,
      cacheRead: ((e.crTok||0)*p.cacheRead)/1e6,
      cacheWrite: ((e.cwTok||0)*p.cacheWrite)/1e6
    };
  }

  function aggregate(events){
    const rows = new Map();
    const modelTotals = new Map();
    const tokenTotals = { input:0, output:0, cacheRead:0, cacheWrite:0 };
    let total = 0;
    let msgs = 0;
    const isInt = (window.ClaudeMeter && window.ClaudeMeter.parserCore && window.ClaudeMeter.parserCore.isInternalAgentProject) || (p => ["subagents",".worktree",".agents"].indexOf(p)>=0);

    for (const e of events){
      const key = viewMode === "models" ? (e.model || "unknown") : (e.attribution || e.project || "unknown");
      if (isInt(key)) continue;
      if (!rows.has(key)) rows.set(key, {
        key, label: key, cost:0, msgs:0, sessions:new Set(), tokens:0,
        parts:{ input:0, output:0, cacheRead:0, cacheWrite:0 },
        models:new Map()
      });
      const row = rows.get(key);
      const parts = costParts(e);
      const cost = parts.input + parts.output + parts.cacheRead + parts.cacheWrite;
      row.cost += cost;
      row.msgs += 1;
      row.sessions.add(e.session);
      row.tokens += (e.inTok||0)+(e.outTok||0)+(e.crTok||0)+(e.cwTok||0);
      row.models.set(e.model || "unknown", (row.models.get(e.model || "unknown") || 0) + cost);
      for (const k in parts){
        row.parts[k] += parts[k];
        tokenTotals[k] += parts[k];
      }
      modelTotals.set(e.model || "unknown", (modelTotals.get(e.model || "unknown") || 0) + cost);
      total += cost;
      msgs += 1;
    }

    const rowsArr = [...rows.values()].sort((a,b)=>b.cost-a.cost).slice(0,16);
    const plan = parseFloat((document.getElementById("plan") || {}).value) || 0;
    return { rows: rowsArr, total, msgs, plan, modelTotals, tokenTotals };
  }

  function mount(el){
    if (!el) return;
    root = el;
    root.className = "pcity";
    root.innerHTML =
      '<div class="pcity-head">' +
        '<div class="pcity-title"><h2>Pricing city</h2><p>Projects become buildings, models become floors, and token categories become colored rooftop blocks. The road compares what you paid for the subscription with API-equivalent token cost.</p></div>' +
        '<div class="pcity-controls">' +
          '<button type="button" class="btn active" data-pcity-view="projects">Projects</button>' +
          '<button type="button" class="btn" data-pcity-view="models">Models</button>' +
          '<button type="button" class="btn" data-pcity-reset>Reset view</button>' +
        '</div>' +
      '</div>' +
      '<div class="pcity-stage" tabindex="0" aria-label="3D pricing city scene">' +
        '<div class="pcity-empty">Load JSONL or demo data to build the city.</div>' +
      '</div>' +
      '<div class="pcity-inspector">' +
        '<div class="pcity-panel" data-pcity-inspector><h3>No building selected</h3><p>Click a tower to see which project or model owns that API-equivalent cost.</p></div>' +
        '<div class="pcity-panel"><h3>Largest blocks</h3><div class="pcity-list" data-pcity-list></div></div>' +
      '</div>';

    root.querySelectorAll("[data-pcity-view]").forEach(btn=>{
      btn.addEventListener("click", function(){
        viewMode = btn.getAttribute("data-pcity-view");
        root.querySelectorAll("[data-pcity-view]").forEach(b=>b.classList.toggle("active", b === btn));
        render(lastEvents);
      });
    });
    root.querySelector("[data-pcity-reset]").addEventListener("click", function(){
      if (!camera || !controls) return;
      camera.position.set(12, 10, 14);
      controls.target.set(0, 0, 0);
      controls.update();
    });

    mounted = true;
    resizeObserver = new ResizeObserver(()=>resize());
    resizeObserver.observe(stage());
    render(window.STATE && window.STATE.events ? window.STATE.events : []);
  }

  function stage(){ return root && root.querySelector(".pcity-stage"); }

  function initScene(){
    const host = stage();
    if (!host || renderer) return;
    if (host.clientWidth < 40 || host.clientHeight < 40) return;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111722);
    scene.fog = new THREE.Fog(0x111722, 24, 56);

    camera = new THREE.PerspectiveCamera(45, host.clientWidth / host.clientHeight, 0.1, 100);
    camera.position.set(12, 10, 14);

    renderer = new THREE.WebGLRenderer({ antialias:true, alpha:false, preserveDrawingBuffer:true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.innerHTML = "";
    host.appendChild(renderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 7;
    controls.maxDistance = 34;
    controls.maxPolarAngle = Math.PI * 0.46;
    controls.target.set(0, 0, 0);

    scene.add(new THREE.HemisphereLight(0xf1f5ff, 0x1f2937, 2.6));
    const sun = new THREE.DirectionalLight(0xffffff, 3.1);
    sun.position.set(8, 16, 6);
    scene.add(sun);

    cityGroup = new THREE.Group();
    scene.add(cityGroup);

    host.addEventListener("pointerdown", onPointer);
    animate();
  }

  function render(events){
    lastEvents = Array.isArray(events) ? events : [];
    if (!mounted && document.getElementById("pricingCity")) mount(document.getElementById("pricingCity"));
    if (!root) return;
    const filtered = visibleEvents(lastEvents);
    const data = aggregate(filtered);
    renderPanels(data);

    if (!filtered.length){
      clearScene();
      const host = stage();
      if (host && !renderer) host.innerHTML = '<div class="pcity-empty">Load JSONL or demo data to build the city.</div>';
      return;
    }

    initScene();
    if (!renderer) return;
    buildCity(data);
    resize();
  }

  function clearScene(){
    if (!cityGroup) return;
    while (cityGroup.children.length){
      const child = cityGroup.children.pop();
      disposeObject(child);
    }
  }

  function buildCity(data){
    clearScene();
    selected = null;

    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(24, 0.12, 18),
      new THREE.MeshStandardMaterial({ color:COLORS.ground, roughness:0.85, metalness:0.05 })
    );
    ground.position.y = -0.08;
    cityGroup.add(ground);
    addGrid();
    addSubscriptionRoad(data);

    const maxCost = Math.max(...data.rows.map(r=>r.cost), 1);
    const cols = Math.min(4, Math.ceil(Math.sqrt(data.rows.length || 1)));
    const gap = 4.6;
    const startX = -((cols-1)*gap)/2;
    const rows = Math.ceil((data.rows.length || 1)/cols);
    const startZ = -((rows-1)*gap)/2;

    data.rows.forEach((row, i)=>{
      const col = i % cols;
      const line = Math.floor(i / cols);
      const x = startX + col * gap;
      const z = startZ + line * gap;
      addBuilding(row, x, z, maxCost, i);
    });
  }

  function addGrid(){
    const mat = new THREE.MeshStandardMaterial({ color:COLORS.road, roughness:0.9, metalness:0, transparent:true, opacity:0.32 });
    for (let i=-2; i<=2; i++){
      const roadA = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.03, 17), mat);
      roadA.position.set(i*4.6, 0.02, 0);
      cityGroup.add(roadA);
      const roadB = new THREE.Mesh(new THREE.BoxGeometry(23, 0.03, 0.08), mat);
      roadB.position.set(0, 0.03, i*4.6);
      cityGroup.add(roadB);
    }
  }

  function addSubscriptionRoad(data){
    const plan = data.plan || 0;
    const actual = data.total || 0;
    const ratio = plan ? Math.min(actual / plan, 8) : 0;
    const paidLen = plan ? 5 : 0.25;
    const tokenLen = plan ? Math.max(0.3, Math.min(15, paidLen * ratio)) : Math.min(15, actual / Math.max(actual, 1) * 8);
    const baseZ = 8.4;
    const paid = new THREE.Mesh(
      new THREE.BoxGeometry(paidLen, 0.12, 0.5),
      new THREE.MeshStandardMaterial({ color:COLORS.plan, roughness:0.55, metalness:0.1 })
    );
    paid.position.set(-4.2 + paidLen/2, 0.15, baseZ);
    paid.userData = { label:"Subscription road", row:{ label:"Subscription paid", cost:plan, tokens:0, msgs:0, sessions:new Set(), parts:{}, models:new Map() } };
    cityGroup.add(paid);

    const token = new THREE.Mesh(
      new THREE.BoxGeometry(tokenLen, 0.16, 0.5),
      new THREE.MeshStandardMaterial({ color:COLORS.output, roughness:0.55, metalness:0.1 })
    );
    token.position.set(-4.2 + tokenLen/2, 0.42, baseZ + 0.7);
    token.userData = { label:"Token-price road", row:{ label:"API-equivalent token cost", cost:actual, tokens:0, msgs:data.msgs, sessions:new Set(), parts:data.tokenTotals, models:data.modelTotals } };
    cityGroup.add(token);

    cityGroup.add(labelSprite("paid plan", -5.1, 0.82, baseZ));
    cityGroup.add(labelSprite("token cost", -5.1, 1.08, baseZ + 0.7));
  }

  function addBuilding(row, x, z, maxCost, index){
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.userData = { row };

    const footprint = Math.min(2.2, 1 + Math.sqrt(row.sessions.size || row.msgs || 1) * 0.08);
    const height = 0.8 + (row.cost / maxCost) * 7.8;
    const models = [...row.models.entries()].sort((a,b)=>b[1]-a[1]);
    let y = 0;
    models.forEach(([model, cost], idx)=>{
      const h = Math.max(0.16, height * (cost / row.cost));
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(footprint, h, footprint),
        new THREE.MeshStandardMaterial({ color:MODEL_COLORS[idx % MODEL_COLORS.length], roughness:0.62, metalness:0.12 })
      );
      mesh.position.y = y + h/2;
      mesh.userData = { row, model };
      group.add(mesh);
      y += h;
    });

    const partsTotal = TOKEN_KEYS.reduce((s,[k])=>s + (row.parts[k] || 0), 0) || 1;
    let offset = -footprint * 0.45;
    TOKEN_KEYS.forEach(([k])=>{
      const width = Math.max(0.08, footprint * ((row.parts[k] || 0) / partsTotal));
      const block = new THREE.Mesh(
        new THREE.BoxGeometry(width, 0.28, 0.28),
        new THREE.MeshStandardMaterial({ color:COLORS[k], roughness:0.5, metalness:0.08 })
      );
      block.position.set(offset + width/2, height + 0.18, -footprint * 0.68);
      block.userData = { row, tokenPart:k };
      group.add(block);
      offset += width;
    });

    const plaza = new THREE.Mesh(
      new THREE.CylinderGeometry(footprint * 0.78, footprint * 0.92, 0.08, 24),
      new THREE.MeshStandardMaterial({ color:0x222a38, roughness:0.9 })
    );
    plaza.position.y = 0.02;
    group.add(plaza);

    group.add(labelSprite(shortLabel(displayName(row.label)), 0, height + 0.82, 0));
    cityGroup.add(group);
  }

  function shortLabel(s){
    if (!s) return "unknown";
    return s.length > 18 ? s.slice(0, 16) + "..." : s;
  }

  function labelSprite(text, x, y, z){
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = "rgba(11,13,18,.78)";
    roundRect(ctx, 6, 10, 244, 42, 10);
    ctx.fill();
    ctx.font = "24px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 128, 32, 220);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map:tex, transparent:true, depthWrite:false });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(x,y,z);
    sprite.scale.set(2.4,0.6,1);
    return sprite;
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
    const host = root.querySelector("[data-pcity-list]");
    if (host){
      host.innerHTML = "";
      const max = Math.max(...data.rows.slice(0,6).map(r=>r.cost), 1);
      data.rows.slice(0,6).forEach(r=>{
        const row = document.createElement("div");
        row.className = "pcity-row";
        row.innerHTML =
          '<div class="pcity-row-name cm-redact-target" title="'+escapeHtml(displayName(r.label))+'">'+escapeHtml(displayName(r.label))+'</div>' +
          '<div class="pcity-row-bar"><div class="pcity-row-fill" style="width:'+((r.cost/max)*100).toFixed(1)+'%"></div></div>' +
          '<div class="pcity-row-val">'+fmt$(r.cost)+'</div>';
        host.appendChild(row);
      });
    }

    const inspector = root.querySelector("[data-pcity-inspector]");
    if (inspector && !selected){
      const planText = data.plan ? fmt$(data.plan) + " paid plan" : "no plan selected";
      const ratio = data.plan ? (data.total / data.plan).toFixed(1) + "x" : "API only";
      inspector.innerHTML =
        '<h3>City total</h3>' +
        '<p><strong>'+fmt$(data.total)+'</strong> token-priced usage across '+fmtInt(data.msgs)+' messages. Road comparison: '+ratio+' vs '+planText+'.</p>' +
        '<div class="pcity-legend" style="margin-top:10px">'+legendHtml()+'</div>';
    }
  }

  function legendHtml(){
    return TOKEN_KEYS.map(([k,label])=>{
      return '<span class="pcity-chip"><span class="pcity-swatch" style="background:#'+COLORS[k].toString(16).padStart(6,"0")+'"></span>'+label+'</span>';
    }).join("");
  }

  function renderSelection(row){
    selected = row;
    const inspector = root && root.querySelector("[data-pcity-inspector]");
    if (!inspector || !row) return;
    const parts = TOKEN_KEYS.map(([k,label])=>[label, row.parts[k] || 0]).sort((a,b)=>b[1]-a[1]);
    const topPart = parts[0] || ["Cost", 0];
    const modelRows = [...(row.models || new Map()).entries()].sort((a,b)=>b[1]-a[1]).slice(0,3);
    inspector.innerHTML =
      '<h3>'+escapeHtml(displayName(row.label))+'</h3>' +
      '<p><strong>'+fmt$(row.cost)+'</strong> API-equivalent · '+fmtInt(row.msgs)+' messages · '+fmtTok(row.tokens)+' tokens. Biggest driver: '+escapeHtml(topPart[0])+' at '+fmt$(topPart[1])+'.</p>' +
      '<div class="pcity-list">' +
        modelRows.map(([m,c])=>'<div class="pcity-row"><div class="pcity-row-name">'+escapeHtml(m)+'</div><div class="pcity-row-bar"><div class="pcity-row-fill" style="width:'+((c/Math.max(row.cost,1))*100).toFixed(1)+'%"></div></div><div class="pcity-row-val">'+fmt$(c)+'</div></div>').join("") +
      '</div>';
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, ch=>({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
  }

  function onPointer(ev){
    if (!renderer || !camera || !cityGroup) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(cityGroup.children, true);
    const hit = hits.find(h=>h.object && h.object.userData && h.object.userData.row);
    if (hit) renderSelection(hit.object.userData.row);
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
    if (controls) controls.update();
    if (cityGroup) cityGroup.rotation.y += 0.0009;
    renderer.render(scene, camera);
  }

  function disposeObject(obj){
    obj.traverse(function(child){
      if (child.geometry) child.geometry.dispose();
      if (child.material){
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(m=>{
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

  window.ClaudeMeter.pricingCity = { mount, render, destroy };

  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", function(){ mount(document.getElementById("pricingCity")); });
  } else {
    mount(document.getElementById("pricingCity"));
  }
})();
