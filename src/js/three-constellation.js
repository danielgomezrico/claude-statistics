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
  let visObserver = null;
  // Whether the stage is on (or near) the viewport. When false the RAF loop
  // stays alive but skips all per-frame WebGL/matrix work — off-screen scenes
  // must not burn GPU/CPU (4 of these run on one long-scroll page).
  let onScreen = true;
  let reducedMotion = false;
  let starLayers = [];
  let fly = null;
  let tourStep = -1;
  let tourPts = [];
  let lastDown = null;
  let clock = null;
  let entrance = { t:0, dur:0 };
  let entrancePlayed = false;
  let selT = 0;
  let instDirty = false;
  let glowMat = null;
  let hovered = null;
  let hoverT = 0;
  let sceneHost = null;
  let minimapEl = null;
  let tourBtnEl = null;
  const glowUniforms = { uTime: { value: 0 } };
  const _dmy = new THREE.Object3D(); // reused scratch — no per-frame allocation in the render loop
  reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // Deliberate easing curves (no linear motion). Cubic for camera moves, back for tasteful pop-in.
  const easeOutCubic = x => 1 - Math.pow(1 - x, 3);
  const easeInOutCubic = x => x < 0.5 ? 4*x*x*x : 1 - Math.pow(-2*x + 2, 3) / 2;
  const easeOutBack = x => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3*Math.pow(x-1, 3) + c1*Math.pow(x-1, 2); };

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

  // Soft radial sprite for additive glow halos. Fresh per build so disposeObject can
  // free it on rebuild/destroy without touching a shared texture.
  function makeGlowTexture(){
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32,32,0,32,32,32);
    g.addColorStop(0.0,'rgba(255,255,255,1)');
    g.addColorStop(0.22,'rgba(255,255,255,0.55)');
    g.addColorStop(0.5,'rgba(255,255,255,0.18)');
    g.addColorStop(1.0,'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0,0,64,64);
    const tex = new THREE.CanvasTexture(c);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
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
      tourStep = -1;
      if (pointsGroup && pointsGroup.children.length) {
        frameContent({ fly:true });
      } else {
        fly = null; controls.enabled = true;
        camera.position.set(14, 9, 16); controls.target.set(0, 3, 0); controls.update();
      }
    });

    mounted = true;
    entrancePlayed = false;
    reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    resizeObserver = new ResizeObserver(()=>resize());
    resizeObserver.observe(stage());
    if (typeof IntersectionObserver !== "undefined"){
      visObserver = new IntersectionObserver(function(entries){
        onScreen = entries[entries.length - 1].isIntersecting;
      }, { rootMargin: "200px" });
      visObserver.observe(stage());
    }
    render(window.STATE && window.STATE.events ? window.STATE.events : []);
  }

  function stage(){ return root && root.querySelector(".cstl-stage"); }

  function initScene(){
    const host = stage();
    if (!host || renderer) return;
    if (host.clientWidth < 40 || host.clientHeight < 40) return;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    // Push fog out so points stay crisp (not washed) even at the larger camera
    // distances used when framing a wide constellation in fullscreen.
    scene.fog = new THREE.Fog(0x000000, 46, 120);

    camera = new THREE.PerspectiveCamera(48, host.clientWidth / host.clientHeight, 0.1, 120);
    camera.position.set(14, 9, 16);

    renderer = new THREE.WebGLRenderer({ antialias:true, alpha:false, preserveDrawingBuffer:true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.innerHTML = "";
    host.appendChild(renderer.domElement);
    const can=renderer.domElement; can.setAttribute('role','img'); can.setAttribute('aria-label','3D constellation X=time Y=cost Z=cache for Priya X3 cache bridges Marcus M8 burns');

    const mini = document.createElement("canvas");
    mini.className = "cstl-minimap";
    mini.width=68; mini.height=68;
    mini.addEventListener("click", onMinimapClick);
    host.appendChild(mini);
    sceneHost = host;
    minimapEl = mini;

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.09;
    controls.minDistance = 3;
    controls.maxDistance = 48;
    controls.maxPolarAngle = Math.PI * 0.92;
    controls.addEventListener('change', onControlsChange);
    host.addEventListener('dblclick', onDblClick);

    // Soft cosmic fill so form-shadowed sides keep a touch of body (depth reads better).
    scene.add(new THREE.AmbientLight(0x202a40, 0.6));
    // Key + fill, neutral cool.
    const p1 = new THREE.PointLight(0x9aa4b8, .75, 120); p1.position.set(18, 22, -14); scene.add(p1);
    const p2 = new THREE.PointLight(0x7f8aa0, .5, 90); p2.position.set(-16, 9, 21); scene.add(p2);
    const p3 = new THREE.PointLight(0xaab8cc, .42, 110); p3.position.set(5, -8, -22); scene.add(p3);
    // Colored rim accents sculpt silhouettes and give the cluster a cosmic temperature shift.
    const rimWarm = new THREE.PointLight(0xff9a63, .42, 80); rimWarm.position.set(-24, 5, -12); scene.add(rimWarm);
    const rimCool = new THREE.PointLight(0x4f93ff, .4, 95); rimCool.position.set(22, -3, 18); scene.add(rimCool);

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
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerleave", onPointerLeave);
    const tb = root.querySelector("[data-cstl-tour]");
    if (tb) tb.addEventListener("click", startTour);
    tourBtnEl = tb;
    clock = new THREE.Clock();
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
    glowMat = null;
    pointsGroup.userData = {};
  }

  function buildConstellation(filtered){
    clearScene();
    selected = null;
    hovered = null; hoverT = 0;
    if (renderer) renderer.domElement.style.cursor = "";

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

    // Unit sphere so the per-instance scale IS the world radius (0.13–0.6). The old
    // 0.1 base multiplied that down to ~0.06 world ≈ 2px — the spheres were near-
    // invisible and the soft glow sprites were all you actually saw (the "blur").
    const geo = new THREE.SphereGeometry(1, 16, 16);
    // Self-lit crisp colored dots: each session reads as a bright, sharply-defined
    // point in its model color, independent of the dim scene lighting that used to
    // leave the spheres near-black and let the soft glow halos read as blur.
    const mat = new THREE.MeshBasicMaterial({ toneMapped:false, fog:false });
    inst = new THREE.InstancedMesh(geo, mat, pts.length);

    const dummy = new THREE.Object3D();
    const modelToCol = new Map();
    let cidx = 0;
    const getCol = (m) => { if (!modelToCol.has(m)) modelToCol.set(m, MODEL_COLORS[cidx++ % MODEL_COLORS.length]); return modelToCol.get(m); };

    const playEntrance = !reducedMotion && !entrancePlayed;
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
      // Small, distinct point per session. The unit-sphere geometry means this value IS
      // the world radius; keep it modest so hundreds of clustered sessions read as separate
      // stars instead of merging into one solid blob (a smaller/larger cost still varies it).
      const r = Math.max(0.05, Math.min(0.24, Math.log1p(tokC / 480) * 0.11));
      // Start collapsed so the entrance can pop each star in; static when not animating.
      const startR = playEntrance ? 0.0001 : r;
      dummy.scale.set(startR, startR, startR);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
      const colHex = getCol(p.model);
      inst.setColorAt(i, new THREE.Color(colHex));
      p._colHex = colHex;
      const rec = (p.ts - minT) / rT;
      p._pulseSpd = 0.9 + cr * 1.8 + (1-rec)*0.6;
      p._pulsePh = i * 0.7;
      p._baseR = r;
      // Stagger entrance along the time axis (left-to-right sweep).
      p._entOff = pts.length > 1 ? i / (pts.length - 1) : 0;
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.userData.points = pts;
    pointsGroup.add(inst);

    // NOTE: the additive glow-halo sprite layer that used to live here was the source of
    // the "blurry blobs" — its onBeforeCompile size inject rendered ~15px soft halos over
    // every session regardless of material.size, drowning the crisp spheres. Removed so the
    // constellation reads as sharp, distinct points. glowMat stays null; animate() guards it.
    glowMat = null;

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
        const ol = new THREE.LineSegments(ogeo, new THREE.LineBasicMaterial({vertexColors:true, transparent:true, opacity:0.1, blending:THREE.AdditiveBlending}));
        pointsGroup.add(ol);
      }
    }

    addGridAndAxes(xs, ys, zs);

    // Kick off the entrance: stars stagger in + camera eases from pulled-back. Once only.
    selT = 0; instDirty = true;
    entrance = { t:0, dur: playEntrance ? 0.95 : 0 };
    entrancePlayed = true;
    frameContent({ entrance: playEntrance, preserveDir: !playEntrance });
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

  // Fit the camera to the actual rendered content's bounding sphere so the whole
  // constellation stays centered and framed at any aspect ratio (narrow column or
  // large/fullscreen). opts.fly animates the move; opts.preserveDir keeps the current
  // viewing angle (used on resize so orbit isn't reset).
  function frameContent(opts){
    opts = opts || {};
    if (!camera || !controls || !pointsGroup || !pointsGroup.children.length) return;
    const box = new THREE.Box3().setFromObject(pointsGroup);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius || 8;

    // Fit to the tighter of vertical/horizontal fov so nothing is clipped on a narrow column.
    const vfov = (camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (camera.aspect || 1));
    const fitFov = Math.min(vfov, hfov);
    const dist = (radius * 1.18) / Math.sin(fitFov / 2);

    // Allow the camera far enough out for narrow aspects (overrides the static maxDistance).
    controls.maxDistance = Math.max(48, dist * 1.6);

    let dir;
    if (opts.preserveDir){
      dir = camera.position.clone().sub(controls.target);
      if (dir.lengthSq() < 1e-4) dir.set(0.55, 0.38, 0.95);
      dir.normalize();
    } else {
      dir = new THREE.Vector3(0.55, 0.38, 0.95).normalize();
    }
    const camPos = center.clone().add(dir.clone().multiplyScalar(dist));

    if (opts.entrance){
      // Dramatic ease-in: snap to a pulled-back vantage, then glide to the framed pose.
      const back = center.clone().add(dir.clone().multiplyScalar(dist * 1.85));
      camera.position.copy(back);
      controls.target.copy(center);
      controls.update();
      startFly(camPos, center, 1.1, easeOutCubic);
    } else if (opts.fly){
      startFly(camPos, center, 0.92, easeInOutCubic);
    } else {
      camera.position.copy(camPos);
      controls.target.copy(center);
      controls.update();
    }
  }

  // Delta-time eased camera move; centralizes every fly so easing/timing stay cohesive.
  function startFly(toPos, toTgt, durSec, ease, onDone){
    if (!camera || !controls) return;
    fly = {
      fromPos: camera.position.clone(), toPos: toPos.clone(),
      fromTgt: controls.target.clone(), toTgt: toTgt.clone(),
      t: 0, dur: Math.max(0.001, durSec || 0.9),
      ease: ease || easeInOutCubic, onDone: onDone || null
    };
    controls.enabled = false;
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
    startFly(new THREE.Vector3(cx+dist*0.6, cy+dist*0.5, cz+dist*0.9), new THREE.Vector3(cx, cy, cz), 0.95, easeInOutCubic);
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
      if (pt){ selected = pt; selT = 0; instDirty = true; updateInspector(pt); flyTo(pt); }
    }
    lastDown = null;
  }
  // Hover affordance: reuses the existing pick pipeline (event-driven, not per-frame).
  // Skipped while orbit-dragging so it never fights the camera.
  function onPointerMove(ev){
    if (!renderer || !camera || !inst || lastDown) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(inst);
    let hit = null;
    if (hits.length && typeof hits[0].instanceId === "number") hit = (inst.userData.points || [])[hits[0].instanceId] || null;
    if (hit !== hovered){
      hovered = hit; hoverT = 0; instDirty = true;
      renderer.domElement.style.cursor = hit ? "pointer" : "";
    }
  }
  function onPointerLeave(){
    if (hovered){ hovered = null; instDirty = true; }
    if (renderer) renderer.domElement.style.cursor = "";
  }
  function onControlsChange(){
    if (starLayers[2]) starLayers[2].rotation.y = -camera.position.z * 0.0005;
    if (starLayers[0]) starLayers[0].rotation.x = camera.position.x * -0.0003;
  }
  function onDblClick(){
    if (!camera || !controls) return;
    tourStep = -1; fly = null; controls.enabled = true;
    if (pointsGroup && pointsGroup.children.length) { frameContent({}); }
    else { camera.position.set(14,9,16); controls.target.set(0,3,0); controls.update(); }
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
    // Re-fit so content stays centered/framed at the new aspect (narrow column or fullscreen).
    // Skip while a fly/tour is animating so we don't fight it; keep the user's orbit angle.
    if (!fly) frameContent({ preserveDir:true });
  }

  function animate(){
    raf = requestAnimationFrame(animate);
    if (!renderer || !scene || !camera) return;
    // Skip rendering work while the tab is hidden; drain the clock so the first visible
    // frame doesn't see a huge accumulated delta.
    if (typeof document !== "undefined" && document.hidden){ if (clock) clock.getDelta(); return; }
    // Skip all rendering work when scrolled off-screen; keep the loop alive so it resumes instantly.
    if (!onScreen){ if (clock) clock.getDelta(); return; }
    // Delta-time so all motion is frame-rate independent; clamp to absorb tab-refocus jumps.
    const dt = clock ? Math.min(clock.getDelta(), 0.05) : 0.016;
    const t = clock ? clock.elapsedTime : Date.now() * 0.001;
    if (controls) controls.update();

    // Entrance progress (eased) drives star fade + staggered point pop-in.
    if (entrance.dur > 0 && entrance.t < entrance.dur) entrance.t += dt;
    const ep = entrance.dur > 0 ? Math.min(1, entrance.t / entrance.dur) : 1;
    const entranceActive = entrance.dur > 0 && entrance.t < entrance.dur;

    if (pointsGroup) pointsGroup.rotation.y += reducedMotion ? 0 : 0.04 * dt;
    // Drive the glow-halo shimmer (frozen under reduced motion) and ease its opacity in.
    glowUniforms.uTime.value = reducedMotion ? 0 : t;
    if (glowMat){
      const gbase = glowMat.userData.baseOp != null ? glowMat.userData.baseOp : 0.9;
      const breath = reducedMotion ? 1 : (0.92 + Math.sin(t * 0.9) * 0.08);
      glowMat.opacity = gbase * easeOutCubic(ep) * breath;
    }
    if (starLayers.length){
      const fade = reducedMotion ? 1 : easeOutCubic(ep);
      if(!reducedMotion){
        starLayers[0].rotation.y = t * 0.003;
        starLayers[1].rotation.y = -t * 0.0018;
        starLayers[2].rotation.y = t * 0.0009;
      }
      starLayers.forEach((l,i)=>{
        const m = l.material;
        const base = l.userData.baseOp || 0.6;
        const tw = reducedMotion ? 0 : Math.sin(t * (1.2 + i*0.5) + (l.userData.phases? l.userData.phases[0]:0)) * 0.07;
        m.opacity = (base + tw) * fade;
      });
    }
    if (fly && camera && controls){
      fly.t += dt;
      const u = Math.min(1, fly.t / fly.dur);
      const e = fly.ease(u);
      camera.position.lerpVectors(fly.fromPos, fly.toPos, e);
      controls.target.lerpVectors(fly.fromTgt, fly.toTgt, e);
      if (u >= 1){
        const done = fly.onDone; fly = null; controls.enabled = true; controls.update();
        if (done) done();
        else if (tourStep >=0 && tourPts.length){ tourStep++; if(tourStep < tourPts.length) flyTo(tourPts[tourStep]); else tourStep=-1; }
      }
    }
    if (selected) selT += dt;
    if (hovered) hoverT += dt;
    // Run the per-instance pass when something is actually moving; otherwise a single
    // one-shot write (instDirty) keeps the reduced-motion / settled path cheap and static.
    const selBoost = selected ? (reducedMotion ? 1 : easeOutBack(Math.min(1, selT / 0.45))) : 0;
    const hovBoost = hovered ? (reducedMotion ? 1 : easeOutCubic(Math.min(1, hoverT / 0.22))) : 0;
    const animatingInst = !reducedMotion || entranceActive || instDirty || (selected && selT < 0.6) || (hovered && hoverT < 0.4);
    if (inst && inst.userData.points && animatingInst){
      const dmy = _dmy; const pts = inst.userData.points;
      for(let i=0; i<pts.length; i++){
        const p = pts[i]; if(!p._baseR) continue;
        // Staggered ease-out-back pop-in along the sweep.
        let entS = 1;
        if (ep < 1 && !reducedMotion){
          const local = Math.max(0, Math.min(1, ep * 1.6 - (p._entOff || 0) * 0.6));
          entS = easeOutBack(local);
        }
        const twinkle = reducedMotion ? 1 : (1 + Math.sin(t * (p._pulseSpd||1.1) + (p._pulsePh||i)) * 0.07);
        let s = p._baseR * entS * twinkle;
        if (p === selected){
          const breath = reducedMotion ? 0 : Math.sin(t * 3.0) * 0.06;
          s += p._baseR * (selBoost * 0.28 + breath);
        } else if (p === hovered){
          s += p._baseR * hovBoost * 0.16; // lighter cue than selection
        }
        dmy.position.set(p._x||0, p._y||0, p._z||0);
        dmy.scale.set(s,s,s);
        dmy.updateMatrix();
        inst.setMatrixAt(i, dmy.matrix);
      }
      inst.instanceMatrix.needsUpdate = true;
      instDirty = false;
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
    if (visObserver) visObserver.disconnect();
    if (controls){
      controls.removeEventListener('change', onControlsChange);
      controls.dispose();
    }
    if (sceneHost){
      sceneHost.removeEventListener("pointerdown", onPointerDown);
      sceneHost.removeEventListener("pointerup", onPointerUp);
      sceneHost.removeEventListener("pointermove", onPointerMove);
      sceneHost.removeEventListener("pointerleave", onPointerLeave);
      sceneHost.removeEventListener("dblclick", onDblClick);
    }
    if (minimapEl) minimapEl.removeEventListener("click", onMinimapClick);
    if (tourBtnEl) tourBtnEl.removeEventListener("click", startTour);
    starLayers.forEach(l => { scene && scene.remove(l); disposeObject(l); });
    starLayers = [];
    clearScene();
    if (renderer) renderer.dispose();
    renderer = scene = camera = controls = root = null;
    sceneHost = null; minimapEl = null; tourBtnEl = null;
    clock = null;
    fly = null;
    selected = null;
    hovered = null; hoverT = 0;
    glowMat = null;
    entrance = { t:0, dur:0 };
    entrancePlayed = false;
    mounted = false;
  }

  window.ClaudeMeter.threeConstellation = { mount, render, destroy, resize };

  if (document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", function(){ mount(document.getElementById("threeConstellation")); });
  } else {
    mount(document.getElementById("threeConstellation"));
  }
})();
