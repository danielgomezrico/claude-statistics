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
  let starLayers = [];
  let sceneLights = []; // all lights added to `scene` (ambient + star), for destroy() cleanup
  let nodeGroups = [];   // node THREE.Group()s, for staggered entrance pop + hover ease
  let reducedMotion = false;
  let hostListenersBound = false; // guards against re-adding host listeners across empty<->data render cycles
  let boundHost = null;           // host element the listeners are currently attached to (for destroy())

  // ---- motion state (delta-time driven) ----
  const clock = new THREE.Clock();
  let entrance = null;   // {e, total, camStart} active build-in choreography
  let camEase = null;    // {e, dur, from, fromTarget} eased reframe (reset/dblclick)
  const framedPos = new THREE.Vector3();    // where frameContent() wants the camera
  const framedTarget = new THREE.Vector3(); // where frameContent() wants the orbit target

  // entrance timing tiers (seconds) — deliberate stagger so volume reads as it draws
  const ENTER = { camDur: 1.6, nodeStagger: 0.09, nodeDur: 0.55, tubeStart: 0.35, tubeStagger: 0.18, tubeDur: 0.75 };
  // idle liveliness: bounded sway (not a full spin) so the preserved side-angle/volume read never erodes
  const SWAY_AMPLITUDE = THREE.MathUtils.degToRad(4);
  const SWAY_SPEED = 0.15;

  // shared, mutated-in-place uniform driving every tube's scrolling flow band (no per-frame alloc)
  const flowTime = { value: 0 };
  const _tmpVec = new THREE.Vector3(); // reused particle position target — avoids getPoint() alloc
  const STAR_BASE_OP = [0.34, 0.56, 0.71]; // base opacity per star layer (hoisted out of the frame loop)

  const easeOutCubic   = x => 1 - Math.pow(1 - x, 3);
  const easeInOutCubic = x => x < 0.5 ? 4*x*x*x : 1 - Math.pow(-2*x + 2, 3) / 2;
  const easeOutBack    = x => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3*Math.pow(x-1,3) + c1*Math.pow(x-1,2); };
  const clamp01        = x => x < 0 ? 0 : (x > 1 ? 1 : x);

  // canonical side-angled view direction (matches old camera.position.set(14,3.5,11));
  // tube radii read as volumes left-to-right. We keep this angle and only fit the distance.
  const SIDE_DIR = new THREE.Vector3(14, 3.5, 11).normalize();
  const _frameBox = new THREE.Box3();
  const _frameSphere = new THREE.Sphere();

  // Compute the framed camera pose into framedPos/framedTarget for the current aspect/fov.
  // Pure: never moves the camera (safe to call mid-easing). Uses the flowGroup bounding sphere
  // (nodes + tubes + base; stars live on the scene, not flowGroup, so they are excluded) and
  // backs off along SIDE_DIR to preserve the side angle. Returns true on success.
  function computeFramed(){
    if (!camera || !controls || !flowGroup || !flowGroup.children.length) return false;
    _frameBox.setFromObject(flowGroup);
    if (_frameBox.isEmpty()) return false;
    _frameBox.getBoundingSphere(_frameSphere);
    const center = _frameSphere.center;
    const radius = Math.max(0.001, _frameSphere.radius);
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const aspect = camera.aspect || 1;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const distV = radius / Math.sin(vFov / 2);
    const distH = radius / Math.sin(hFov / 2);
    let dist = Math.max(distV, distH) * 1.12; // margin so content isn't edge-to-edge
    dist = Math.max(controls.minDistance, Math.min(controls.maxDistance, dist));
    framedTarget.copy(center);
    framedPos.copy(center).addScaledVector(SIDE_DIR, dist); // PRESERVE side-angle direction
    camera.updateProjectionMatrix();
    return true;
  }

  function applyFramed(){
    controls.target.copy(framedTarget);
    camera.position.copy(framedPos);
    controls.update();
  }

  // Frame & center the camera on the flow content (preserves the side angle — radii read as
  // volumes). While an entrance or eased reframe is mid-flight, only the target pose is updated;
  // the animation loop drives the camera there so resize() stays correct without snapping.
  function frameContent(){
    if (!computeFramed()) return;
    if (entrance || camEase) return;
    applyFramed();
  }

  // Eased reframe to the framed side-angle pose (Reset view button + dblclick). Ends framed.
  function resetView(){
    if (!camera || !controls) return;
    if (!computeFramed()) return;
    if (reducedMotion || entrance){ applyFramed(); return; }
    camEase = { e: 0, dur: 1.0, from: camera.position.clone(), fromTarget: controls.target.clone() };
    controls.enabled = false;
  }

  // Hide everything, then choreograph a staggered draw-in (nodes pop, tubes extrude, particles
  // begin flowing) while the camera eases from a pulled-back start to the framed side-angle.
  function startEntrance(){
    camEase = null;
    if (reducedMotion){ entrance = null; revealAll(); applyFramed(); return; }
    nodeGroups.forEach(g => g.scale.setScalar(0.001));
    tubeMeshes.forEach(m => {
      if (m && m.geometry && m.geometry.index){
        m.userData._fullCount = m.geometry.index.count;
        m.geometry.setDrawRange(0, 0);
      }
    });
    particles.forEach(p => { p.visible = false; });
    const nodeEnd = nodeGroups.length ? (nodeGroups.length - 1) * ENTER.nodeStagger + ENTER.nodeDur : 0;
    const tubeEnd = tubeMeshes.length ? ENTER.tubeStart + (tubeMeshes.length - 1) * ENTER.tubeStagger + ENTER.tubeDur : 0;
    const camStart = framedTarget.clone().addScaledVector(SIDE_DIR, Math.min(controls.maxDistance, framedPos.distanceTo(framedTarget) * 1.5));
    camera.position.copy(camStart);
    controls.target.copy(framedTarget);
    controls.enabled = false;
    entrance = { e: 0, total: Math.max(ENTER.camDur, nodeEnd, tubeEnd) + 0.1, camStart };
  }

  function revealAll(){
    nodeGroups.forEach(g => g.scale.setScalar(1));
    tubeMeshes.forEach(m => {
      if (m && m.geometry && m.geometry.index){
        m.geometry.setDrawRange(0, m.userData._fullCount != null ? m.userData._fullCount : m.geometry.index.count);
      }
    });
    particles.forEach(p => { p.visible = true; });
  }

  function fmt$(n){ return "$"+(n||0).toLocaleString(undefined,{maximumFractionDigits:2,minimumFractionDigits:2}); }
  function fmtTok(n){ if(n>=1e9)return(n/1e9).toFixed(2)+"B"; if(n>=1e6)return(n/1e6).toFixed(2)+"M"; if(n>=1e3)return(n/1e3).toFixed(1)+"k"; return String(n||0); }

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
      resetView();
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
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.innerHTML = "";
    host.appendChild(renderer.domElement);
    const can=renderer.domElement; can.setAttribute('role','img'); can.setAttribute('aria-label','3D cache flow. Tube radius shows token volume; the cache write-to-read arc shows reuse leverage. Drag to orbit, double-click to reframe.');
    if (!hostListenersBound){
      host.addEventListener("pointerdown", onPointer, { once: false });
      host.addEventListener("pointermove", onHover, { once: false });
      host.addEventListener('dblclick', onDblClick);
      hostListenersBound = true;
      boundHost = host;
    }

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.minDistance = 6;
    controls.maxDistance = 70; // headroom so a narrow/portrait column still fits the wide flow
    controls.maxPolarAngle = Math.PI * 0.82;
    controls.target.set(0, 0, 0);
    controls.addEventListener('change', onControlChange);

    // point star lights (vacuum cosmic, per universe tips + shared P0)
    const p1 = new THREE.PointLight(0xcbd5e1, 0.9, 130); p1.position.set(12,22,-9); scene.add(p1); sceneLights.push(p1);
    const p2 = new THREE.PointLight(0xa5b4fc, 0.65, 95); p2.position.set(-14,8,18); scene.add(p2); sceneLights.push(p2);
    const p3 = new THREE.PointLight(0xfca5a5, 0.5, 80); p3.position.set(4,-7,-16); scene.add(p3); sceneLights.push(p3);

    // balanced ambient so surfaces never go pure-black, without flattening volume
    const hemi = new THREE.HemisphereLight(0x2a3a57, 0x05070d, 0.55); scene.add(hemi); sceneLights.push(hemi);
    // key from upper-front-left gives the tube tops/spheres their form
    const keyLight = new THREE.DirectionalLight(0xeef3ff, 0.45); keyLight.position.set(-7, 13, 15); scene.add(keyLight); sceneLights.push(keyLight);
    // rim grazes the tube radii from behind-side — the curved silhouette lights up so
    // volume (radius) reads at the preserved side angle. Lights live on scene, not flowGroup.
    const rimLight = new THREE.DirectionalLight(0x8fb4ff, 0.7); rimLight.position.set(11, 3, -13); scene.add(rimLight); sceneLights.push(rimLight);

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
    nodeGroups = [];
    entrance = null;
    camEase = null;
    if (controls) controls.enabled = true;
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
      g.userData = { node: n, id: n.id, hoverScale: 1 };
      nodeGroups.push(g);

      const r = n.id === "process" ? 1.1 : 1.35;
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(r, 28, 20),
        new THREE.MeshStandardMaterial({ color: n.color, roughness: 0.42, metalness: 0.22, emissive: n.color, emissiveIntensity: n.id==="read" ? 0.32 : 0.16 })
      );
      mesh.userData = { node: n, id: n.id };
      g.add(mesh);

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
      const tubeColor = pd.leverage ? COLORS.cacheRead : (pd.key==="cwT" ? COLORS.cacheWrite : (pd.key==="inT"? COLORS.input : COLORS.output));
      const tubeMat = new THREE.MeshStandardMaterial({
        color: tubeColor,
        // lower roughness + a little metalness so the rim light reads the curved radius (= volume)
        roughness: pd.leverage ? 0.4 : 0.52,
        metalness: pd.leverage ? 0.22 : 0.16,
        emissive: tubeColor,            // dim base glow; the scrolling band adds on top of this
        emissiveIntensity: 0.14,
        transparent: true,
        opacity: pd.leverage ? 0.92 : 0.85
      });
      // time-driven flow band scrolling along the tube length (vUv.y), injected into the PBR
      // shader so lighting is preserved. Heavier/leverage tubes pulse a touch faster.
      applyFlowShader(tubeMat, tubeColor, pd.leverage ? 3.0 : 2.2);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 42, rad, 9, false), tubeMat);
      tube.userData = { path: pd, vol: v, from:pd.from, to:pd.to, baseEm: 0.14, emTarget: 0.14 };
      flowGroup.add(tube);
      tubeMeshes.push(tube);

      // leverage highlight arc (thinner glowing companion) — shares the path so it brightens together
      if (pd.leverage){
        const glowR = Math.max(0.05, rad * 0.72);
        const glow = new THREE.Mesh(
          new THREE.TubeGeometry(curve, 42, glowR, 7, false),
          new THREE.MeshStandardMaterial({ color: COLORS.glow, emissive:0x052e16, emissiveIntensity:0.8, roughness:0.3, transparent:true, opacity:0.55 })
        );
        glow.userData = { path: pd, baseEm: 0.8, emTarget: 0.8 };
        flowGroup.add(glow);
        tubeMeshes.push(glow);
      }

      // particles for flow (light animation) — speed in units/sec, subtly faster on heavier tubes
      if (v > 0){
        const nParts = pd.leverage ? 5 : 3;
        const volFrac = clamp01(v / Math.max(1, data.totalTok));
        const baseSpeed = (pd.leverage ? 1.15 : 0.85) * (0.7 + 0.6 * volFrac);
        // entrance reveal offset: particles for later-drawn tubes start flowing later
        const revealAt = ENTER.tubeStart + idx * ENTER.tubeStagger + ENTER.tubeDur * 0.25;
        for (let k=0; k<nParts; k++){
          const m = new THREE.Mesh(
            new THREE.SphereGeometry(Math.max(0.07, Math.min(0.18, rad*0.55)), 8, 8),
            new THREE.MeshBasicMaterial({ color: pd.leverage ? 0x86efac : 0x94a3b8, transparent:true, opacity:0.9, blending:THREE.AdditiveBlending, depthWrite:false })
          );
          m.userData = { t: (k / nParts) + (idx*0.13) % 1, speed: baseSpeed, curve, pathId: idx, revealAt };
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

    // content is complete — frame & center it for the current aspect (preserves side angle)
    frameContent();
    // ...then choreograph the staggered draw-in / camera ease (snaps if reduced-motion)
    startEntrance();
  }

  // Inject a scrolling emissive "flow" band into a MeshStandardMaterial via onBeforeCompile.
  // Keeps full PBR lighting; adds one shared uTime uniform + per-tube color/speed (no new GPU
  // resources to dispose, no per-frame allocation). USE_UV forces the uv attribute to exist.
  function applyFlowShader(material, colorHex, speed){
    material.defines = Object.assign({}, material.defines, { USE_UV: "" });
    const flowColor = new THREE.Color(colorHex);
    material.onBeforeCompile = function(shader){
      shader.uniforms.uTime = flowTime;                    // shared, mutated each frame
      shader.uniforms.uFlowColor = { value: flowColor };
      shader.uniforms.uFlowSpeed = { value: speed };
      shader.vertexShader = "varying vec2 vFlowUv;\n" + shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n  vFlowUv = uv;"
      );
      if (shader.fragmentShader.indexOf("#include <emissivemap_fragment>") !== -1){
        shader.fragmentShader = "uniform float uTime;\nuniform vec3 uFlowColor;\nuniform float uFlowSpeed;\nvarying vec2 vFlowUv;\n" + shader.fragmentShader.replace(
          "#include <emissivemap_fragment>",
          "#include <emissivemap_fragment>\n  float flowBand = sin(vFlowUv.y * 18.8495559 - uTime * uFlowSpeed) * 0.5 + 0.5;\n  flowBand = pow(flowBand, 3.0);\n  totalEmissiveRadiance += uFlowColor * flowBand * 0.85;"
        );
      }
    };
    material.needsUpdate = true;
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
    // set eased targets only; the loop lerps scale + emissiveIntensity toward them each frame.
    // Drives intensity (not emissive color) so the Iter-2 flow-band color stays intact.
    tubeMeshes.forEach(m=>{
      if (!m || !m.material) return;
      const pd = m.userData && m.userData.path;
      const hit = nodeId && pd && (pd.from===nodeId || pd.to===nodeId);
      const base = m.userData.baseEm != null ? m.userData.baseEm : (m.material.emissiveIntensity || 0);
      m.userData.targetScale = hit ? 1.18 : 1;
      m.userData.emTarget = hit ? Math.min(2.2, base + 0.7) : base;
    });
  }

  function pickId(ev){
    if (!renderer || !camera || !flowGroup) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(flowGroup.children, true);
    const hit = hits.find(h => h.object && h.object.userData && (h.object.userData.id || h.object.userData.node));
    if (!hit) return null;
    return hit.object.userData.id || (hit.object.userData.node && hit.object.userData.node.id) || null;
  }

  function onDblClick(){ resetView(); }

  function onPointer(ev){
    const id = pickId(ev);
    if (id){ renderSelection(id, aggregate(lastEvents)); return; }
    // click on empty space clears the selection (eases highlights back to rest)
    if (selected){ selected = null; highlightTubesFor(null); renderPanels(aggregate(lastEvents)); }
  }

  // subtle hover ease — reuses the pick raycast; nudges the hovered node's scale target
  function onHover(ev){
    if (entrance || !nodeGroups.length) return;
    const id = pickId(ev);
    nodeGroups.forEach(g => { g.userData.hoverScale = 1; });
    if (id){
      const g = nodeGroups.find(x => x.userData.id === id);
      if (g) g.userData.hoverScale = 1.08;
    }
    if (renderer) renderer.domElement.style.cursor = id ? "pointer" : "";
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
    // re-fit so the flow stays centered/framed after aspect changes (incl. fullscreen).
    // Skipped mid-entrance: nodeGroups are still scaled ~0.001 during the build-in choreography,
    // so setFromObject(flowGroup) there would compute a bogus (shrunk) framing target and
    // corrupt the entrance's camera destination. The entrance's own frameContent() call
    // (before nodes shrink, in buildFlow()) already set the correct framed pose.
    if (!entrance) frameContent();
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
      const a=starLayers[0].geometry.attributes.position.array; [0,2].forEach(k=>{const ii=(k*29)%(a.length/3)*3; const pl=new THREE.PointLight(0xcbd5e1,0.5,130); pl.position.set(a[ii]||-6,a[ii+1]||8,a[ii+2]||10); scene.add(pl); sceneLights.push(pl);});
    }
  }
  function onControlChange(){
    if(!camera||!starLayers.length)return; const fx=camera.position.x*-0.0004; starLayers[0].rotation.y=fx; if(starLayers[2])starLayers[2].rotation.y=fx*0.6;
  }
  function animate(){
    raf = requestAnimationFrame(animate);
    if (!renderer || !scene || !camera) return;
    const dt = Math.min(0.05, clock.getDelta()); // clamp so a backgrounded tab can't jump motion

    // --- entrance choreography: camera ease + staggered node pop + tube draw-in ---
    if (entrance){
      entrance.e += dt;
      const e = entrance.e;
      // camera eases from pulled-back start to the framed side-angle
      const camK = easeOutCubic(clamp01(e / ENTER.camDur));
      camera.position.lerpVectors(entrance.camStart, framedPos, camK);
      controls.target.copy(framedTarget);
      controls.update(); // re-orient toward target (keeps our lerped position)
      // nodes pop in with a slight overshoot, staggered left-to-right
      nodeGroups.forEach((g, i)=>{
        const k = easeOutBack(clamp01((e - i * ENTER.nodeStagger) / ENTER.nodeDur));
        g.scale.setScalar(Math.max(0.001, k));
      });
      // tubes extrude along their length via drawRange, staggered after the nodes
      tubeMeshes.forEach((m, i)=>{
        if (!m || !m.geometry || !m.geometry.index) return;
        const full = m.userData._fullCount != null ? m.userData._fullCount : m.geometry.index.count;
        const k = easeInOutCubic(clamp01((e - (ENTER.tubeStart + i * ENTER.tubeStagger)) / ENTER.tubeDur));
        m.geometry.setDrawRange(0, Math.max(0, Math.floor(full * k)));
      });
      if (e >= entrance.total){
        revealAll();
        entrance = null;
        controls.enabled = true;
        applyFramed();
      }
    } else if (camEase){
      camEase.e += dt;
      const k = easeInOutCubic(clamp01(camEase.e / camEase.dur));
      camera.position.lerpVectors(camEase.from, framedPos, k);
      controls.target.lerpVectors(camEase.fromTarget, framedTarget, k);
      controls.update();
      if (camEase.e >= camEase.dur){ camEase = null; controls.enabled = true; applyFramed(); }
    } else if (controls){
      controls.update();
      // hover ease on nodes (only when not mid-entrance/reframe)
      if (!reducedMotion){
        const hk = Math.min(1, dt * 10);
        nodeGroups.forEach(g=>{
          const ts = g.userData.hoverScale != null ? g.userData.hoverScale : 1;
          const c = g.scale.x;
          if (Math.abs(ts - c) > 0.0005) g.scale.setScalar(c + (ts - c) * hk);
        });
      }
    }

    // selection highlight ease — lerp tube scale + emissiveIntensity toward targets.
    // Reduced motion snaps (sk=1) so feedback is instant and calm, not animated.
    const sk = reducedMotion ? 1 : Math.min(1, dt * 8);
    tubeMeshes.forEach(m=>{
      if (!m) return;
      const ts = m.userData.targetScale != null ? m.userData.targetScale : 1;
      const c = m.scale.x;
      if (Math.abs(ts - c) > 0.0005) m.scale.setScalar(c + (ts - c) * sk);
      if (m.material && m.userData.emTarget != null){
        const et = m.userData.emTarget, ec = m.material.emissiveIntensity;
        if (Math.abs(et - ec) > 0.0005) m.material.emissiveIntensity = ec + (et - ec) * sk;
      }
    });

    // idle flow along curves (the core metaphor) — frame-rate independent, static if reduced
    particles.forEach(p=>{
      if (!p.userData.curve) return;
      if (entrance && p.userData.revealAt != null) p.visible = entrance.e >= p.userData.revealAt;
      if (!p.visible) return;
      if (!reducedMotion) p.userData.t = (p.userData.t + p.userData.speed * dt) % 1;
      p.position.copy(p.userData.curve.getPoint(p.userData.t, _tmpVec));
      if (p.material && p.material.opacity != null){
        const pulse = 0.65 + Math.sin(p.userData.t * Math.PI * 4) * 0.3;
        p.material.opacity = Math.max(0.35, pulse);
      }
    });

    // advance the shared flow-band clock (static when reduced motion — band stays as soft stripes)
    if (!reducedMotion) flowTime.value += dt;

    // gentle ambient sway on the group — bounded oscillation (not a continuous spin) so the
    // preserved side-angle (SIDE_DIR) volume-read never erodes away from the framed pose
    if (flowGroup && !reducedMotion) flowGroup.rotation.y = Math.sin(clock.elapsedTime * SWAY_SPEED) * SWAY_AMPLITUDE;
    if(!reducedMotion && starLayers.length){
      const t=Date.now()*0.001; starLayers.forEach((l,i)=>{ if(l.material){l.material.opacity=(STAR_BASE_OP[i]||0.5)+Math.sin(t*(l.userData.f||2)+(l.userData.ph||0))*0.08;l.material.needsUpdate=true;} if(l.userData.rot)l.rotation.y+=l.userData.rot*dt*60; });
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
    // stars live on `scene` (not flowGroup), so clearScene() above never touches them —
    // dispose their geometries/materials and drop the star point lights here
    starLayers.forEach(l=>{ if (scene) scene.remove(l); disposeObject(l); });
    starLayers = [];
    sceneLights.forEach(l=>{ if (scene) scene.remove(l); });
    sceneLights = [];
    if (boundHost){
      boundHost.removeEventListener("pointerdown", onPointer);
      boundHost.removeEventListener("pointermove", onHover);
      boundHost.removeEventListener("dblclick", onDblClick);
      boundHost = null;
    }
    hostListenersBound = false;
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
