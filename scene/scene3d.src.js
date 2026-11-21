/* Lifeline Home Watch: a low-poly 3D diorama of a house in a flood.
   Source for vendor/scene3d.js (see README for the build command).
   Units are feet. The ground floor is y = 0.2, the upper floor y = 10.2. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const GROUND = 0.2, UPPER = 10.2, TANK_BOTTOM = -16;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export function create(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const DAY = new THREE.Color(0xe6edf4), NIGHT = new THREE.Color(0x1a2742), FLASH = new THREE.Color(0xdfe9ff);
  const bg = new THREE.Color(DAY);
  scene.background = bg.clone();
  scene.fog = new THREE.Fog(DAY.clone(), 140, 300);
  const camera = new THREE.PerspectiveCamera(34, 1, 1, 700);

  const hemi = new THREE.HemisphereLight(0xffffff, 0xa9b8c8, 1.15);
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.4);
  sun.position.set(34, 64, 46);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -36, right: 36, top: 36, bottom: -36, near: 20, far: 170 });
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.05;
  scene.add(hemi, sun);

  const mat = (color, o) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.82, metalness: 0, flatShading: true }, o));
  const M = {
    wall: mat(0xffffff), trim: mat(0x2b3240), floor: mat(0xead9bd), slab: mat(0xf2f3f5), roof: mat(0x2b3240),
    grass: mat(0xb7d8a4), soil: mat(0xa88b6d), path: mat(0xe9e2d2), road: mat(0x5b6370), dash: mat(0xf4f4f4),
    sofa: mat(0x6b7a99), wood: mat(0xb88c5c), bed: mat(0xffffff), blanket: mat(0xd7261e), pillow: mat(0xf4f1ea),
    leaf: mat(0x7fb77e), leaf2: mat(0x5fa06a), trunk: mat(0x8a6a4a), car: mat(0xf4f6f8), tire: mat(0x20242c),
    figure: mat(0xd7261e, { roughness: 0.55 }), step: mat(0xdadde2),
  };
  // Window glass and lamp bulbs share these so the power cut can switch them off together.
  const glass = new THREE.MeshStandardMaterial({ color: 0x27303f, emissive: 0xffd58a, emissiveIntensity: 1, roughness: 0.3, flatShading: true });
  const bulb = new THREE.MeshStandardMaterial({ color: 0xfff3d6, emissive: 0xffd58a, emissiveIntensity: 1.4, flatShading: true });

  const root = new THREE.Group();
  scene.add(root);
  const shadowed = (m, cast = true, recv = true) => { m.castShadow = cast; m.receiveShadow = recv; return m; };
  // A box from coordinate ranges, so walls read like a floor plan.
  function slab(parent, x0, x1, y0, y1, z0, z1, material, cast = true) {
    const m = shadowed(new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), material), cast, true);
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    parent.add(m);
    return m;
  }

  // ---- The island and the tank of water around it ----------------------------------
  slab(root, -22, 22, TANK_BOTTOM, -0.5, -22, 22, M.soil, false);
  slab(root, -22, 22, -0.5, 0, -22, 22, M.grass, false);
  slab(root, -3, 3, 0, 0.06, 6, 22, M.path, false);           // path to the house
  slab(root, -22, 22, 0, 0.08, 12, 19, M.road, false);        // road along the front
  for (let x = -19; x <= 19; x += 8) slab(root, x - 1.8, x + 1.8, 0.08, 0.13, 15.3, 15.7, M.dash, false);

  const tankEdges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(58, 46, 58)),
    new THREE.LineBasicMaterial({ color: 0xaeb9c6, transparent: true, opacity: 0.8 }),
  );
  tankEdges.position.y = (TANK_BOTTOM + 30) / 2;
  root.add(tankEdges);

  const waterBody = new THREE.Mesh(
    new THREE.BoxGeometry(58, 1, 58),
    new THREE.MeshStandardMaterial({ color: 0x2f86c8, transparent: true, opacity: 0.4, roughness: 0.25, depthWrite: false }),
  );
  waterBody.renderOrder = 1;
  root.add(waterBody);
  const waveGeo = new THREE.PlaneGeometry(58, 58, 40, 40);
  waveGeo.rotateX(-Math.PI / 2);
  const waveBase = Float32Array.from(waveGeo.attributes.position.array);
  const waterTop = new THREE.Mesh(waveGeo, new THREE.MeshStandardMaterial({
    color: 0x58a9e6, transparent: true, opacity: 0.72, roughness: 0.2, flatShading: true, depthWrite: false,
  }));
  waterTop.renderOrder = 2;
  root.add(waterTop);

  // ---- The house, cut away at the front like a dollhouse ---------------------------
  const house = new THREE.Group();
  root.add(house);
  slab(house, -11, 11, 0, GROUND, -8, 8, M.floor, false);
  // Walls (back, left, right), ground floor then upper floor.
  for (const [y0, y1] of [[GROUND, 9.6], [UPPER, 19.2]]) {
    slab(house, -11, 11, y0, y1, -8, -7.4, M.wall);
    slab(house, -11, -10.4, y0, y1, -8, 8, M.wall);
    slab(house, 10.4, 11, y0, y1, -8, 8, M.wall);
  }
  // Upper floor deck with a hole for the stairs.
  slab(house, -11, 11, 9.6, UPPER, -5, 8, M.slab);
  slab(house, -11, -1, 9.6, UPPER, -8, -5, M.slab);
  slab(house, 9, 11, 9.6, UPPER, -8, -5, M.slab);
  slab(house, -11, 11, 9.6, 9.75, 8, 8.4, M.trim, false);     // dark edge along the front of the deck
  // Stairs along the back wall, climbing to the left.
  for (let i = 0; i < 10; i++) slab(house, 8 - i, 9 - i, GROUND, GROUND + i + 1, -7.4, -5, M.step);
  // Gable roof with the front end open.
  const roofAngle = Math.atan2(6, 12.5), roofLen = Math.hypot(12.5, 6) + 0.6;
  for (const s of [-1, 1]) {
    const r = shadowed(new THREE.Mesh(new THREE.BoxGeometry(roofLen, 0.6, 18.4), M.roof), false, true);
    r.position.set(s * 6.3, 22.4, 0);
    r.rotation.z = -s * roofAngle;
    house.add(r);
  }
  const gable = new THREE.Shape();
  gable.moveTo(-11, 0); gable.lineTo(11, 0); gable.lineTo(0, 6); gable.closePath();
  const gableMesh = shadowed(new THREE.Mesh(new THREE.ShapeGeometry(gable), M.wall), false, true);
  gableMesh.position.set(0, 19.2, -7.4);
  house.add(gableMesh);
  // Windows on the back and side walls, with a dark frame.
  function windowAt(x, y, z, axis) {
    const w = 4, h = 3.6;
    const g = new THREE.Group();
    const frameMesh = new THREE.Mesh(new THREE.BoxGeometry(w + 0.7, h + 0.7, 0.12), M.trim);
    const pane = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.14), glass);
    pane.position.z = 0.06;
    g.add(frameMesh, pane);
    g.position.set(x, y, z);
    if (axis === 'x') g.rotation.y = Math.PI / 2;
    house.add(g);
  }
  for (const y of [6.8, 16.4]) { windowAt(-6, y, -7.35, 'z'); windowAt(4.5, y, -7.35, 'z'); }
  windowAt(-10.35, 6.8, 1, 'x'); windowAt(-10.35, 16.4, 1, 'x');
  windowAt(10.35, 16.4, 1, 'x');
  // Furniture.
  slab(house, -9.6, -4, GROUND, 1.6, -7, -4.6, M.sofa);            // sofa
  slab(house, -9.6, -9, GROUND, 3.4, -7, -4.6, M.sofa);
  slab(house, -5, -1.6, GROUND, 2.6, 2, 5, M.wood);                // table
  slab(house, -9.4, -2.6, UPPER, UPPER + 1.8, -7, -1, M.bed);       // bed
  slab(house, -9.4, -2.6, UPPER + 1.8, UPPER + 2.1, -4.6, -1, M.blanket);
  slab(house, -9.2, -7.4, UPPER + 1.8, UPPER + 2.5, -6.8, -5.2, M.pillow);
  slab(house, -2.2, -0.2, UPPER, UPPER + 1.8, -7, -5.4, M.wood);   // nightstand
  for (const [x, y, z] of [[-1.2, UPPER + 2.5, -6.2], [-3.2, GROUND + 3.1, 3.5]]) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.62, 10, 8), bulb);
    b.position.set(x, y, z);
    house.add(b);
  }
  const lamps = [
    new THREE.PointLight(0xffd9a0, 90, 34, 1.6), new THREE.PointLight(0xffd9a0, 90, 34, 1.6),
  ];
  lamps[0].position.set(0, 7, 2); lamps[1].position.set(0, 17, 2);
  house.add(...lamps);

  // ---- Neighbourhood: trees, a neighbour, a car, a mailbox ---------------------------
  function tree(x, z, s) {
    const g = new THREE.Group();
    const t = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 3.2, 6), M.trunk));
    t.position.y = 1.6; g.add(t);
    const c1 = shadowed(new THREE.Mesh(new THREE.ConeGeometry(3.2, 6, 7), M.leaf2)); c1.position.y = 6; g.add(c1);
    const c2 = shadowed(new THREE.Mesh(new THREE.ConeGeometry(2.4, 5, 7), M.leaf)); c2.position.y = 9.2; g.add(c2);
    g.position.set(x, 0, z); g.scale.setScalar(s);
    root.add(g);
  }
  tree(-17, 6, 1.1); tree(17, 4, 1.25); tree(-18, -8, 0.95); tree(18, -12, 1);
  function bush(x, z, s) {
    const b = shadowed(new THREE.Mesh(new THREE.IcosahedronGeometry(1.7 * s, 0), M.leaf));
    b.position.set(x, 1.1 * s, z); root.add(b);
  }
  bush(-12.4, 8.6, 1); bush(-14.2, 7.6, 0.7); bush(12.6, 8.8, 1.1);
  // Neighbour house, small and further back.
  {
    const n = new THREE.Group();
    slab(n, -6, 6, 0, 8, -5, 5, M.wall);
    const rg = new THREE.Shape(); rg.moveTo(-7, 0); rg.lineTo(7, 0); rg.lineTo(0, 4.5); rg.closePath();
    const rm = shadowed(new THREE.Mesh(new THREE.ExtrudeGeometry(rg, { depth: 11, bevelEnabled: false }), M.roof));
    rm.position.set(0, 8, -5.5); n.add(rm);
    slab(n, -1, 1.4, 0, 4, 4.9, 5.1, M.trim);
    n.position.set(-1, 0, -15.5); n.scale.setScalar(0.9);
    root.add(n);
  }
  // Car on the road.
  {
    const c = new THREE.Group();
    slab(c, -3.6, 3.6, 0.9, 2.5, -1.7, 1.7, M.car);
    slab(c, -1.9, 1.7, 2.5, 4, -1.5, 1.5, M.car);
    slab(c, -1.7, 1.5, 2.6, 3.9, -1.55, 1.55, glass, false);
    for (const [x, z] of [[-2.2, -1.7], [2.2, -1.7], [-2.2, 1.7], [2.2, 1.7]]) {
      const w = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.5, 10), M.tire));
      w.rotation.x = Math.PI / 2; w.position.set(x, 0.85, z); c.add(w);
    }
    c.position.set(9, 0.08, 15.6);
    root.add(c);
  }
  // Mailbox.
  slab(root, -13.2, -12.8, 0, 3, 11, 11.4, M.trunk);
  slab(root, -13.9, -12.1, 3, 4.2, 10.6, 12, M.trim);

  // Every still object is merged into one mesh per material. That takes the scene from
  // hundreds of draw calls to a few dozen, which keeps the phone free to listen.
  {
    root.updateMatrixWorld(true);
    const skip = new Set([waterBody, waterTop]);
    const groups = new Map(), merged = [];
    root.traverse((o) => {
      if (!o.isMesh || skip.has(o)) return;
      const key = `${o.material.uuid}${o.castShadow ? 'c' : '-'}${o.receiveShadow ? 'r' : '-'}`;
      let g = groups.get(key);
      if (!g) { g = { material: o.material, cast: o.castShadow, recv: o.receiveShadow, geos: [] }; groups.set(key, g); }
      const geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      geo.applyMatrix4(o.matrixWorld);
      for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
      g.geos.push(geo);
      merged.push(o);
    });
    for (const o of merged) { o.parent.remove(o); o.geometry.dispose(); }
    for (const g of groups.values()) {
      const m = new THREE.Mesh(mergeGeometries(g.geos), g.material);
      m.castShadow = g.cast; m.receiveShadow = g.recv;
      root.add(m);
    }
  }

  // ---- The person ----------------------------------------------------------------
  function limb(radius, length) {
    const g = new THREE.Group();
    const m = shadowed(new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 4, 8), M.figure));
    m.position.y = -length / 2 - radius * 0.2;
    g.add(m);
    return g;
  }
  const figure = new THREE.Group();
  const body = new THREE.Group();
  figure.add(body);
  const torso = shadowed(new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 1.7, 4, 10), M.figure));
  torso.position.y = 3.65; body.add(torso);
  const head = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.78, 14, 12), M.figure));
  head.position.y = 5.5; body.add(head);
  const legL = limb(0.26, 2.2), legR = limb(0.26, 2.2);
  legL.position.set(-0.28, 2.75, 0); legR.position.set(0.28, 2.75, 0);
  const armL = limb(0.2, 1.7), armR = limb(0.2, 1.7);
  armL.position.set(-0.62, 4.45, 0); armR.position.set(0.62, 4.45, 0);
  body.add(legL, legR, armL, armR);
  const marker = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.1, 4), new THREE.MeshBasicMaterial({ color: 0xd7261e }));
  marker.rotation.x = Math.PI; marker.position.y = 8.2;
  figure.add(marker);
  const phoneLight = new THREE.PointLight(0xfff0d0, 0, 22, 1.7);
  phoneLight.position.set(0.5, 4.4, 1.2);
  figure.add(phoneLight);
  root.add(figure);

  const GROUND_SPOT = new THREE.Vector3(3, GROUND, 3.5), UPPER_SPOT = new THREE.Vector3(2.5, UPPER, 3.5);
  const STAIR_PATH_UP = [new THREE.Vector3(9.6, GROUND, -6.2)];
  for (let i = 0; i < 10; i++) STAIR_PATH_UP.push(new THREE.Vector3(8.5 - i, GROUND + i + 1, -6.2));
  STAIR_PATH_UP.push(new THREE.Vector3(1, UPPER, -4.6), UPPER_SPOT.clone());
  const STAIR_PATH_DOWN = STAIR_PATH_UP.slice(0, -1).reverse().concat([GROUND_SPOT.clone()]);
  figure.position.copy(UPPER_SPOT);
  let path = [], onUpper = true, fallen = false, fallAmt = 0, waving = false, phase = 0, faceY = 0;

  // ---- Rain, lightning, signal rings, message packets, the boat -----------------------
  const RAIN_N = 900, rain = new Float32Array(RAIN_N * 6), rainSpeed = new Float32Array(RAIN_N);
  for (let i = 0; i < RAIN_N; i++) {
    const x = (Math.random() - 0.5) * 110, y = Math.random() * 64, z = (Math.random() - 0.5) * 110;
    rain.set([x, y, z, x + 0.3, y + 2, z], i * 6);
    rainSpeed[i] = 60 + Math.random() * 30;
  }
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rain, 3));
  const rainMat = new THREE.LineBasicMaterial({ color: 0xcfe4ff, transparent: true, opacity: 0 });
  const rainLines = new THREE.LineSegments(rainGeo, rainMat);
  rainLines.frustumCulled = false;
  scene.add(rainLines);

  const rings = [];
  const ringGeo = new THREE.RingGeometry(1, 1.14, 64);
  function spawnRing(color, y) {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(0, y, 0);
    m.userData.age = 0;
    scene.add(m);
    rings.push(m);
  }
  let beacon = false, beaconClock = 0;

  const packets = [];
  const packetGeo = new THREE.SphereGeometry(0.9, 12, 10);
  const HOUSE_TOP = new THREE.Vector3(0, 27.5, 0), FAR = new THREE.Vector3(86, 34, -16);
  function packet(dir) {
    const color = dir === 'out' ? 0xd7261e : 0x1a1f29;
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(packetGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1 - i * 0.16 }));
      m.scale.setScalar(1 - i * 0.12);
      m.visible = false;
      scene.add(m);
      packets.push({ m, t: -i * 0.07, from: dir === 'out' ? HOUSE_TOP : FAR, to: dir === 'out' ? FAR : HOUSE_TOP, dur: 1.9, head: i === 0, dir });
    }
  }

  const boat = new THREE.Group();
  {
    const hs = new THREE.Shape();
    hs.moveTo(-5, -2); hs.lineTo(3.6, -2); hs.lineTo(6.2, 0); hs.lineTo(3.6, 2); hs.lineTo(-5, 2); hs.closePath();
    const hull = shadowed(new THREE.Mesh(new THREE.ExtrudeGeometry(hs, { depth: 1.5, bevelEnabled: false }), mat(0xffffff)));
    hull.rotation.x = -Math.PI / 2; hull.position.y = -0.4;
    const stripe = new THREE.Mesh(new THREE.ExtrudeGeometry(hs, { depth: 0.25, bevelEnabled: false }), mat(0xd7261e));
    stripe.rotation.x = -Math.PI / 2; stripe.position.y = 1.1; stripe.scale.set(1.02, 1.02, 1);
    const cabin = shadowed(new THREE.Mesh(new THREE.BoxGeometry(3, 2.2, 2.6), mat(0xffffff)));
    cabin.position.set(-0.8, 2.2, 0);
    const win = new THREE.Mesh(new THREE.BoxGeometry(3.05, 0.9, 2.1), mat(0x2f86c8));
    win.position.set(-0.8, 2.5, 0);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 1.6), new THREE.MeshBasicMaterial({ color: 0xffb020 }));
    bar.position.set(-0.8, 3.5, 0);
    boat.add(hull, stripe, cabin, win, bar);
    boat.userData.bar = bar;
    const spot = new THREE.PointLight(0xfff0d0, 0, 40, 1.5);
    spot.position.set(0, 4, 0);
    boat.add(spot);
    boat.userData.spot = spot;
  }
  boat.visible = false;
  boat.scale.setScalar(1.35);
  scene.add(boat);
  let boatT = -1;

  // ---- State and the render loop -------------------------------------------------
  const S = {
    storm: 0, night: 0, power: 1, powerTarget: 1, flicker: 0, rainAmt: 0, rainTarget: 0,
    water: 4 / 12 + GROUND, waterTarget: 4 / 12 + GROUND, flash: 0, flashClock: 0, focus: 0, focusTarget: 0,
    az: 0.16, el: 0.27, dragAz: 0, dragEl: 0, running: false, last: 0, time: 0, w: 1, h: 1, minFrame: 30, lowPower: false,
  };

  function layout() {
    const w = canvas.clientWidth || canvas.parentElement.clientWidth || 390, h = canvas.clientHeight || canvas.parentElement.clientHeight || 700;
    S.w = w; S.h = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function place() {
    const aspect = S.w / S.h;
    const fit = clamp(aspect * 1.55, 0.5, 1.5);
    const radius = (122 / fit) * (1 - 0.14 * S.focus);
    const az = S.az + Math.sin(S.time * 0.11) * 0.12 + S.dragAz;
    const el = clamp(S.el + S.dragEl, 0.12, 0.95);
    const target = new THREE.Vector3(0, lerp(8, 12, S.focus), 0);
    camera.position.set(
      target.x + radius * Math.cos(el) * Math.sin(az),
      target.y + radius * Math.sin(el),
      target.z + radius * Math.cos(el) * Math.cos(az),
    );
    camera.lookAt(target);
    camera.setViewOffset(S.w, S.h, 0, S.h * 0.1, S.w, S.h);
  }

  function updateFigure(dt) {
    phase += dt;
    let moving = false;
    if (path.length) {
      const target = path[0];
      const d = target.clone().sub(figure.position);
      const step = 8.5 * dt;
      if (d.length() <= step) { figure.position.copy(target); path.shift(); }
      else {
        d.setLength(step);
        figure.position.add(d);
        const flat = Math.hypot(d.x, d.z);
        if (flat > 0.001) faceY = Math.atan2(d.x, d.z);
      }
      moving = true;
    } else {
      faceY = lerp(faceY, 0, Math.min(1, dt * 3));
    }
    figure.rotation.y = lerp(figure.rotation.y, faceY, Math.min(1, dt * 10));
    const swing = moving ? Math.sin(phase * 14) * 0.7 : 0;
    legL.rotation.x = swing; legR.rotation.x = -swing;
    armL.rotation.x = -swing * 0.8; armR.rotation.x = swing * 0.8;
    armL.rotation.z = 0.1; armR.rotation.z = -0.1;
    if (waving && !fallen) {
      armR.rotation.x = 0;
      armR.rotation.z = -(2.5 + Math.sin(phase * 7) * 0.35);
      armL.rotation.z = 2.2 + Math.sin(phase * 7 + 1) * 0.3;
    }
    const breath = moving ? 0 : Math.sin(phase * 2) * 0.02;
    body.scale.y = 1 + breath;
    fallAmt = lerp(fallAmt, fallen ? 1 : 0, Math.min(1, dt * 7));
    body.rotation.z = -fallAmt * (Math.PI / 2);
    body.position.y = fallAmt * 0.78;
    body.position.x = fallAmt * 0.2;
    marker.position.y = 8.2 + Math.sin(phase * 3) * 0.35 - fallAmt * 5;
    marker.rotation.y += dt * 1.8;
  }

  function updateWater(dt) {
    S.water = S.waterTarget;   // dt here is real elapsed time
    const y = S.water;
    const height = Math.max(y - TANK_BOTTOM, 0.01);
    waterBody.scale.y = height;
    waterBody.position.y = TANK_BOTTOM + height / 2;
    waterTop.position.y = y;
    const p = waveGeo.attributes.position, t = S.time;
    for (let i = 0; i < p.count; i++) {
      const x = waveBase[i * 3], z = waveBase[i * 3 + 2];
      p.setY(i, Math.sin(x * 0.33 + t * 1.5) * 0.26 + Math.cos(z * 0.41 + t * 1.2) * 0.22 + Math.sin((x + z) * 0.2 + t * 0.7) * 0.18);
    }
    p.needsUpdate = true;
  }

  function updateSky(dt) {
    S.night = smooth(0.2, 0.85, S.storm);
    S.rainAmt = lerp(S.rainAmt, S.rainTarget, Math.min(1, dt * 1.5));
    // Lightning during heavy rain.
    S.flashClock -= dt;
    if (S.rainAmt > 0.5 && S.flashClock <= 0) { S.flash = 1; S.flashClock = 2.5 + Math.random() * 5; }
    S.flash = Math.max(0, S.flash - dt * 3.2);
    bg.copy(DAY).lerp(NIGHT, S.night * 0.95).lerp(FLASH, S.flash * 0.3);
    scene.background.copy(bg);
    scene.fog.color.copy(bg);
    hemi.intensity = lerp(1.15, 0.55, S.night) + S.flash * 1.2;
    sun.intensity = lerp(2.4, 0.55, S.night) * (1 - S.rainAmt * 0.3);
    sun.color.setHex(S.night > 0.5 ? 0x9db6ff : 0xfff0dc);
    renderer.toneMappingExposure = lerp(1.0, 1.35, S.night);
    // The grid: flickers, then the lights are out for good.
    S.flicker = Math.max(0, S.flicker - dt);
    let power = S.power;
    if (S.flicker > 0) power = Math.random() > 0.45 ? 1 : 0.05;
    glass.emissiveIntensity = 1.1 * power;
    bulb.emissiveIntensity = 1.6 * power;
    for (const l of lamps) l.intensity = 90 * power * (0.35 + 0.65 * S.night);
    phoneLight.intensity = S.night * 80;
    rainMat.opacity = 0.5 * S.rainAmt;
    const pos = rainGeo.attributes.position.array;
    for (let i = 0; i < RAIN_N; i++) {
      const o = i * 6;
      let y = pos[o + 1] - rainSpeed[i] * dt;
      if (y < -3) y += 66;
      pos[o + 1] = y; pos[o + 4] = y + 2;
    }
    rainGeo.attributes.position.needsUpdate = true;
  }

  function updateEffects(dt) {
    if (beacon) {
      beaconClock -= dt;
      if (beaconClock <= 0) { spawnRing(0xd7261e, 25.4); beaconClock = 1.15; }
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.userData.age += dt;
      const k = r.userData.age / 2.6;
      r.scale.setScalar(1 + k * 30);
      r.material.opacity = 0.75 * (1 - k);
      if (k >= 1) { scene.remove(r); r.material.dispose(); rings.splice(i, 1); }
    }
    for (let i = packets.length - 1; i >= 0; i--) {
      const p = packets[i];
      p.t += dt / p.dur;
      if (p.t < 0) continue;
      if (p.t >= 1) {
        scene.remove(p.m); p.m.material.dispose(); packets.splice(i, 1);
        if (p.head && p.dir === 'in') spawnRing(0x1a1f29, 25.4);
        continue;
      }
      p.m.visible = true;
      const e = p.t * p.t * (3 - 2 * p.t);
      p.m.position.lerpVectors(p.from, p.to, e);
      p.m.position.y += Math.sin(e * Math.PI) * 9;
    }
    if (boatT >= 0) {
      boatT += dt;
      const k = smooth(0, 1, clamp(boatT / 8, 0, 1));
      const x = lerp(70, 6, k), z = lerp(10, 21, k);
      boat.position.set(x, S.water + 0.2 + Math.sin(S.time * 2 + 1) * 0.25, z);
      boat.rotation.y = Math.PI * 0.82 + 0.1 * Math.sin(S.time * 0.8);
      boat.rotation.z = Math.sin(S.time * 1.7) * 0.03;
      boat.userData.bar.material.color.setHex(Math.sin(S.time * 10) > 0 ? 0xffb020 : 0xd7261e);
      boat.userData.spot.intensity = 90 * S.night;
    }
  }

  function frame(ts) {
    if (!S.running) return;
    // 30 frames a second is plenty, and it leaves the main thread free for the microphone.
    if (ts - S.last < S.minFrame) { requestAnimationFrame(frame); return; }
    // Effects use real elapsed time so the boat and message packets keep their pace even
    // on a slow phone; the rest is capped so a hiccup cannot make the water jump.
    const real = Math.min(0.3, (ts - S.last) / 1000 || 0.016), dt = Math.min(0.05, real);
    S.last = ts; S.time += dt;
    S.focus = lerp(S.focus, S.focusTarget, Math.min(1, dt * 2));
    updateSky(dt); updateWater(real); updateFigure(dt); updateEffects(real);
    place();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  // Drag to turn the camera around the house.
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, az: S.dragAz, el: S.dragEl }; });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    S.dragAz = clamp(drag.az - (e.clientX - drag.x) * 0.006, -1.1, 1.1);
    S.dragEl = clamp(drag.el + (e.clientY - drag.y) * 0.004, -0.25, 0.4);
  });
  window.addEventListener('pointerup', () => { drag = null; });

  layout();
  return {
    resize: layout,
    start() { if (S.running) return; layout(); S.running = true; S.last = performance.now(); requestAnimationFrame(frame); },
    stop() { S.running = false; },
    isRunning: () => S.running,
    setStorm(t) { S.storm = t; S.rainTarget = t > 0.01 ? Math.min(1, 0.35 + t * 2) : 0; },
    setWaterInches(inches) { S.waterTarget = inches / 12 + GROUND; },
    setFloor(upper, instant) {
      if (upper === onUpper && !path.length) return;
      onUpper = upper;
      if (instant) { path = []; figure.position.copy(upper ? UPPER_SPOT : GROUND_SPOT); return; }
      path = (upper ? STAIR_PATH_UP : STAIR_PATH_DOWN).map((v) => v.clone());
    },
    setFallen(v) { fallen = v; },
    setWaving(v) { waving = v; },
    setPower(on) { if (!on && S.power) S.flicker = 0.9; S.power = on ? 1 : 0; },
    setBeacon(on) { beacon = on; beaconClock = 0; },
    setFocus(v) { S.focusTarget = v; },
    // Once the SOS is out the phone has to listen above all, so draw less.
    setLowPower(on) {
      S.lowPower = on; S.minFrame = on ? 62 : 30;
      renderer.setPixelRatio(on ? 1 : Math.min(window.devicePixelRatio || 1, 1.75));
      layout();
    },
    packet,
    rescue() { boat.visible = true; boatT = 0; },
    reset() {
      path = []; onUpper = true; fallen = false; fallAmt = 0; waving = false;
      figure.position.copy(UPPER_SPOT);
      S.storm = 0; S.rainTarget = 0; S.rainAmt = 0; S.water = 4 / 12 + GROUND; S.waterTarget = S.water; S.power = 1; S.flicker = 0; S.focusTarget = 0;
      beacon = false; boat.visible = false; boatT = -1;
      if (S.lowPower) { S.lowPower = false; S.minFrame = 30; renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75)); layout(); }
      for (const r of rings.splice(0)) { scene.remove(r); r.material.dispose(); }
      for (const p of packets.splice(0)) { scene.remove(p.m); p.m.material.dispose(); }
    },
  };
}
