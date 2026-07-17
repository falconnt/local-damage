// Local Damage — walking-viewer (MVP stap 1)
// Data: neutrale GLB met klasse-meshes ("class:grass" enz.); stijl komt uit
// palettes/palettes.json + toon-shading + gradient-sky + fog (zie bouwplan).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VERSION } from './version.js';
import { sfx, ensureAudio } from './game/sfx.js';

const TILE_PATHS = ['tiles/', '../dist/tiles/']; // Pages-layout, daarna lokale dev-layout
const EYE_HEIGHT = 1.7;
const WALK_SPEED = 5.0;
const RUN_SPEED = 11.0;
const FLY_SPEED = 22.0;
const FLY_FAST = 45.0;

const state = {
  paletteName: 'afternoon',
  palettes: {},
  yaw: 0,
  pitch: -0.05,
  velocity: new THREE.Vector3(),
  keys: new Set(),
  joystick: { active: false, x: 0, y: 0 },
  lookTouch: { id: null, x: 0, y: 0 },
  walkables: [],
  surfaces: [],  // alle ondergrond-meshes (voor surfaceAt: weg/water/zand/groen)
  blockers: [],  // muren (botsing voor stickman en auto)
  classMeshes: new Map(),
  started: false,
  fly: false,
  flyVert: 0, // -1/0/+1 via mobiele knoppen
  actionA: false, // 👊 / gas
  actionB: false, // 🦵 / rem
  actionC: false, // 🛡️ blok
  pressed: new Set(), // one-shot keydown-buffer: snelle taps droppen nooit
  waypoint: null, // THREE.Vector3 doel voor de schermrand-pointer
};

const SURFACE_CLASSES = new Set(['grass', 'road', 'water', 'sand', 'green', 'ground']);

// --- renderer / scene ------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
// telefoons met DPR 3 renderen anders 9x zoveel pixels; 1.75 is daar zat
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isTouchDevice() ? 1.75 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = !isTouchDevice();
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 3000);
camera.position.set(0, 30, 0);

const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.castShadow = renderer.shadowMap.enabled;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

const hemi = new THREE.HemisphereLight(0xbcd8ee, 0x8a9a6c, 0.9);
scene.add(hemi);

// gradient-skybox: grote bol met verticaal kleurverloop, horizon = fogkleur
const skyUniforms = {
  topColor: { value: new THREE.Color('#3a3f75') },
  horizonColor: { value: new THREE.Color('#ffb27d') },
};
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(2000, 24, 12),
  new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor; uniform vec3 horizonColor; varying vec3 vDir;
      void main() {
        float t = smoothstep(0.0, 0.5, max(vDir.y, 0.0));
        gl_FragColor = vec4(mix(horizonColor, topColor, t), 1.0);
      }`,
  })
);
sky.name = 'sky';
scene.add(sky);

// 3-staps toon-gradient ("flatter coloring", geen PBR)
const gradientMap = new THREE.DataTexture(new Uint8Array([90, 165, 255]), 3, 1, THREE.RedFormat);
gradientMap.minFilter = gradientMap.magFilter = THREE.NearestFilter;
gradientMap.needsUpdate = true;

// --- wereld laden -----------------------------------------------------------
init().catch((err) => {
  console.error(err);
  document.getElementById('area-name').textContent = 'laden mislukt — zie console';
});

const loader = new GLTFLoader();
const TILE_LOAD_M = 620;   // laden ruim achter de fog-grens: pop-in blijft onzichtbaar
const TILE_UNLOAD_M = 950; // ver weg = geheugen teruggeven

async function init() {
  document.getElementById('version').textContent = VERSION;
  document.getElementById('menu-version').textContent = VERSION;
  state.palettes = await (await fetch('./palettes/palettes.json')).json();
  buildPaletteButtons();

  // schaduwbox volgt de speler (vaste maat), zon-target wordt per frame gezet
  Object.assign(sun.shadow.camera, { left: -380, right: 380, top: 380, bottom: -380, far: 2500 });

  const { base, manifest } = await findManifest();
  if (manifest.regions?.length) {
    await initRegion(base, manifest.regions[manifest.regions.length - 1]);
  } else {
    await initLegacyArea(base, manifest.areas[manifest.areas.length - 1]);
  }

  applyPalette(state.paletteName);
  setupControls();
  renderer.setAnimationLoop(tick);
}

function prepareMesh(node) {
  // klasse uit glTF-extras (userData); naam-fallbacks voor andere bakes
  const cls = node.userData.cls
    ?? node.parent?.userData?.cls
    ?? ((node.material?.name || '').startsWith('class:') ? node.material.name.slice(6) : null)
    ?? ((node.name || '').match(/^class[:_]?(\w+)/)?.[1] ?? 'wall');
  const baked = node.material?.color?.clone() ?? new THREE.Color('#cccccc');
  node.material = new THREE.MeshToonMaterial({
    color: baked,
    gradientMap,
    vertexColors: Boolean(node.geometry.getAttribute('color')),
  });
  node.userData.cls = cls;
  node.castShadow = cls === 'roof' || cls === 'wall' || cls === 'tree' || cls === 'trunk';
  node.receiveShadow = true;
  if (!state.classMeshes.has(cls)) state.classMeshes.set(cls, new Set());
  state.classMeshes.get(cls).add(node);
  if (SURFACE_CLASSES.has(cls)) state.surfaces.push(node);
  if (cls === 'wall') state.blockers.push(node);
  return cls;
}

async function loadGlbWithProgress(url, label) {
  const progressBar = document.querySelector('#progress .bar');
  document.getElementById('area-name').textContent = `${label} — laden…`;
  const gltf = await loader.loadAsync(url, (evt) => {
    if (evt.total > 0) {
      progressBar.style.width = `${Math.round((evt.loaded / evt.total) * 100)}%`;
    } else {
      progressBar.style.width = '100%';
      document.getElementById('area-name').textContent =
        `${label} — ${(evt.loaded / 1e6).toFixed(1)} MB geladen…`;
    }
  });
  document.getElementById('area-name').textContent = label;
  document.getElementById('progress').classList.add('hidden');
  return gltf;
}

function spawnAt(x, z) {
  state.yaw = 0; // -Z = noord
  camera.position.set(x, 500, z);
  const ground = groundHeight(x, z);
  camera.position.y = (ground ?? 0) + EYE_HEIGHT;
}

// --- legacy: één losse wijk (demo / bbox-configs) ----------------------------
async function initLegacyArea(base, area) {
  const gltf = await loadGlbWithProgress(base + area.file, area.name);
  const worldBounds = new THREE.Box3();
  gltf.scene.traverse((node) => {
    if (!node.isMesh) return;
    const cls = prepareMesh(node);
    if (cls === 'grass' || cls === 'road' || cls === 'ground') state.walkables.push(node);
    worldBounds.expandByObject(node);
  });
  scene.add(gltf.scene);

  if (area.addresses) {
    try {
      const labels = await (await fetch(base + area.addresses)).json();
      buildLabels(labels, 0, 0);
    } catch (err) {
      console.warn('adresbordjes niet geladen:', err);
    }
  }
  const center = worldBounds.getCenter(new THREE.Vector3());
  spawnAt(center.x, center.z + 60);
}

// --- streaming: regio met tegels op het RD-raster ----------------------------
async function initRegion(base, region) {
  const wox = Math.min(...region.tiles.map((t) => t.origin_rd[0]));
  const woy = Math.min(...region.tiles.map((t) => t.origin_rd[1]));
  state.world = { base, region, origin: [wox, woy] };
  state.tiles = region.tiles.map((entry) => ({
    entry, state: 'none', group: null, meshes: [], walkables: [], labelRefs: null,
  }));

  const sx = region.spawn_rd[0] - wox;
  const sz = -(region.spawn_rd[1] - woy);

  // starttegel eerst (met laadbalk), buren streamen op de achtergrond
  const startRec = state.tiles
    .map((rec) => [tileDistance(rec.entry, sx, sz), rec])
    .sort((a, b) => a[0] - b[0])[0][1];
  await loadTile(startRec, region.name);
  spawnAt(sx, sz);
  updateTiles();
}

function tileDistance(entry, px, pz) {
  const [wox, woy] = state.world.origin;
  const s = state.world.region.tile_size_m;
  const x0 = entry.origin_rd[0] - wox;
  const z1 = -(entry.origin_rd[1] - woy); // zuidrand
  const dx = Math.max(x0 - px, 0, px - (x0 + s));
  const dz = Math.max((z1 - s) - pz, 0, pz - z1);
  return Math.hypot(dx, dz);
}

let tilesLoading = 0;
async function loadTile(rec, progressLabel = null) {
  if (rec.state !== 'none') return;
  rec.state = 'loading';
  tilesLoading += 1;
  try {
    const { base, origin } = state.world;
    const e = rec.entry;
    const gltf = progressLabel
      ? await loadGlbWithProgress(base + e.file, progressLabel)
      : await loader.loadAsync(base + e.file);
    const ox = e.origin_rd[0] - origin[0];
    const oz = -(e.origin_rd[1] - origin[1]);
    const group = gltf.scene;
    group.position.set(ox, 0, oz);
    group.traverse((node) => {
      if (!node.isMesh) return;
      const cls = prepareMesh(node);
      rec.meshes.push(node);
      if (cls === 'grass' || cls === 'road' || cls === 'ground') {
        state.walkables.push(node);
        rec.walkables.push(node);
      }
    });
    scene.add(group);
    rec.group = group;
    tintMeshes(rec.meshes); // huidige palet direct toepassen

    if (e.addresses) {
      try {
        const data = await (await fetch(base + e.addresses)).json();
        rec.labelRefs = buildLabels(data, ox, oz);
      } catch (err) {
        console.warn('bordjes niet geladen voor', e.id, err);
      }
    }
    rec.state = 'loaded';
  } catch (err) {
    console.warn('tegel laden mislukt:', rec.entry.id, err);
    rec.state = 'none';
  } finally {
    tilesLoading -= 1;
  }
}

function unloadTile(rec) {
  if (rec.state !== 'loaded') return;
  scene.remove(rec.group);
  for (const m of rec.meshes) {
    state.classMeshes.get(m.userData.cls)?.delete(m);
    m.geometry.dispose();
    m.material.dispose(); // gradientMap is gedeeld en blijft leven
  }
  const gone = new Set(rec.meshes);
  state.walkables = state.walkables.filter((w) => !gone.has(w));
  state.surfaces = state.surfaces.filter((s) => !gone.has(s));
  state.blockers = state.blockers.filter((b) => !gone.has(b));
  if (rec.labelRefs) {
    scene.remove(rec.labelRefs.group);
    for (const key of ['numbers', 'signs', 'streets']) {
      const gone = new Set(rec.labelRefs[key]);
      labelState[key] = labelState[key].filter((x) => !gone.has(x));
      for (const obj of rec.labelRefs[key]) obj.geometry?.dispose(); // textures blijven gecachet
    }
  }
  Object.assign(rec, { state: 'none', group: null, meshes: [], walkables: [], labelRefs: null });
}

function updateTiles() {
  if (!state.world) return;
  const px = camera.position.x;
  const pz = camera.position.z;
  const pending = state.tiles
    .filter((r) => r.state === 'none')
    .map((r) => [tileDistance(r.entry, px, pz), r])
    .sort((a, b) => a[0] - b[0]);
  for (const [d, r] of pending) {
    if (d < TILE_LOAD_M && tilesLoading < 2) loadTile(r);
  }
  for (const r of state.tiles) {
    if (r.state === 'loaded' && tileDistance(r.entry, px, pz) > TILE_UNLOAD_M) unloadTile(r);
  }
}

async function findManifest() {
  for (const base of TILE_PATHS) {
    try {
      const resp = await fetch(base + 'index.json');
      if (resp.ok) return { base, manifest: await resp.json() };
    } catch { /* volgende kandidaat */ }
  }
  throw new Error('tiles/index.json niet gevonden — draai eerst de pipeline');
}

// --- bordjes (huisnummers + straatnamen) -------------------------------------
// NL-straatnaambord: verkeersblauw vlak, witte rand, witte kapitalen.
const SIGN_BLUE = '#00519e';
const labelState = { numbers: [], signs: [], streets: [], textures: new Map() };

function labelTexture(text, { width, height, fontPx, border }) {
  const key = `${text}|${width}`;
  if (labelState.textures.has(key)) return labelState.textures.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = SIGN_BLUE;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = border;
  ctx.strokeRect(border * 1.4, border * 1.4, width - border * 2.8, height - border * 2.8);
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${fontPx}px system-ui, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2 + fontPx * 0.05);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace; // anders wordt het NL-blauw wasserig cyaan
  tex.anisotropy = 4;
  labelState.textures.set(key, tex);
  return tex;
}

function makePlaque(text, pos, n, { big }) {
  const chars = Math.max(2, text.length);
  const tex = big
    ? labelTexture(text.toUpperCase(), { width: 64 * chars + 96, height: 160, fontPx: 92, border: 10 })
    : labelTexture(text, { width: 44 * chars + 52, height: 110, fontPx: 62, border: 8 });
  const w = big ? 0.11 * chars + 0.28 : 0.05 * chars + 0.12;
  const h = big ? 0.32 : 0.2;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex }) // zelfverlicht: altijd leesbaar
  );
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.lookAt(pos[0] + n[0], pos[1], pos[2] + n[1]); // gevelnormaal (x, z)
  return mesh;
}

function streetNameTexture(text) {
  const key = `street|${text}`;
  if (labelState.textures.has(key)) return labelState.textures.get(key);
  const fontPx = 96;
  const canvas = document.createElement('canvas');
  canvas.width = fontPx * 0.62 * text.length + 80;
  canvas.height = 150;
  const ctx = canvas.getContext('2d');
  ctx.font = `600 ${fontPx}px system-ui, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 12;
  ctx.strokeStyle = 'rgba(20, 24, 44, 0.9)';
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.userData = { aspect: canvas.width / canvas.height };
  labelState.textures.set(key, tex);
  return tex;
}

function buildLabels(data, ox = 0, oz = 0) {
  const group = new THREE.Group();
  const refs = { group, numbers: [], signs: [], streets: [] };
  const shift = (pos) => [pos[0] + ox, pos[1], pos[2] + oz];
  for (const item of data.items ?? []) {
    const plaque = makePlaque(item.number, shift(item.pos), item.n, { big: false });
    labelState.numbers.push(plaque);
    refs.numbers.push(plaque);
    group.add(plaque);
  }
  for (const sign of data.signs ?? []) {
    const plaque = makePlaque(sign.street, shift(sign.pos), sign.n, { big: true });
    labelState.signs.push(plaque);
    refs.signs.push(plaque);
    group.add(plaque);
  }

  // zwevende straatnamen boven de straat: orientatie in de wijk
  const byStreet = new Map();
  for (const item of data.items ?? []) {
    if (!byStreet.has(item.street)) byStreet.set(item.street, []);
    byStreet.get(item.street).push(shift(item.pos));
  }
  for (const [street, positions] of byStreet) {
    if (positions.length < 2) continue; // losse adressen geen wijklabel
    const c = positions
      .reduce((acc, p) => acc.add(new THREE.Vector3(...p)), new THREE.Vector3())
      .divideScalar(positions.length);
    const tex = streetNameTexture(street);
    // hoog genoeg dat geen dak ervoor staat; depth-test aan zodat namen
    // nooit door huizen heen schijnen
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      opacity: 0.92,
    }));
    sprite.position.set(c.x, c.y + 42, c.z);
    sprite.userData.aspect = tex.userData.aspect;
    labelState.streets.push(sprite);
    group.add(sprite);
  }
  scene.add(group);
}

let labelTick = 0;
function updateLabelVisibility() {
  const p = camera.position;
  // straatnamen elke frame herschalen: constante schermgrootte
  for (const s of labelState.streets) {
    const d = s.position.distanceTo(p);
    const h = THREE.MathUtils.clamp(d * 0.055, 3.5, 26);
    s.scale.set(h * s.userData.aspect, h, 1);
    s.material.opacity = d < 46 ? 0 : 0.92; // vlak eronder: niet in je gezicht
  }
  // huisnummers alleen dichtbij tonen; straatnaamborden dragen verder
  if (++labelTick % 30 !== 0) return;
  for (const m of labelState.numbers) m.visible = m.position.distanceToSquared(p) < 70 * 70;
  for (const m of labelState.signs) m.visible = m.position.distanceToSquared(p) < 220 * 220;
  updateTiles(); // zelfde ritme (~2x/s): buurtegels streamen voor je ze ziet
}

// --- stijl / paletten -------------------------------------------------------
function applyPalette(name) {
  const p = state.palettes[name];
  if (!p) return;
  state.paletteName = name;

  skyUniforms.topColor.value.set(p.sky.top);
  skyUniforms.horizonColor.value.set(p.sky.horizon);
  scene.fog = new THREE.Fog(new THREE.Color(p.fog.color), p.fog.near, p.fog.far);

  sun.color.set(p.sun.color);
  sun.intensity = p.sun.intensity;
  const el = THREE.MathUtils.degToRad(p.sun.elevation);
  const az = THREE.MathUtils.degToRad(p.sun.azimuth);
  // offset t.o.v. de speler: de zon (en schaduwbox) reist mee over de tegels
  state.sunOffset = new THREE.Vector3(
    Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)
  ).multiplyScalar(600);

  hemi.color.set(p.ambient.sky);
  hemi.groundColor.set(p.ambient.ground);
  hemi.intensity = p.ambient.intensity;

  for (const [cls, meshes] of state.classMeshes) {
    const color = p.classes[cls];
    if (color) meshes.forEach((m) => m.material.color.set(color));
  }
  document.querySelectorAll('#palettes button').forEach((b) =>
    b.classList.toggle('active', b.dataset.name === name));
}

function tintMeshes(meshes) {
  const p = state.palettes[state.paletteName];
  if (!p) return;
  for (const m of meshes) {
    const color = p.classes[m.userData.cls];
    if (color) m.material.color.set(color);
  }
}

function buildPaletteButtons() {
  const holder = document.getElementById('palettes');
  for (const [name, p] of Object.entries(state.palettes)) {
    const btn = document.createElement('button');
    btn.textContent = p.label ?? name;
    btn.dataset.name = name;
    btn.addEventListener('click', (e) => { e.stopPropagation(); applyPalette(name); });
    holder.appendChild(btn);
  }
}

// --- besturing --------------------------------------------------------------
function setupControls() {
  const overlay = document.getElementById('overlay');
  document.getElementById('start-hint').textContent = isTouchDevice()
    ? 'linkerduim = bewegen · rechterduim = rondkijken'
    : 'WASD = bewegen · muis = kijken · shift = rennen/sneller · esc = menu';
  document.getElementById('modes').classList.remove('hidden');

  for (const card of document.querySelectorAll('.mode-card')) {
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      startMode(card.dataset.mode);
    });
  }
  document.getElementById('menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    showMenu();
  });

  // actieknoppen (mobiel): modes lezen state.actionA/actionB
  for (const [id, prop] of [['btn-a', 'actionA'], ['btn-b', 'actionB']]) {
    const btn = document.getElementById(id);
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); state[prop] = true; });
    for (const evt of ['pointerup', 'pointercancel', 'pointerleave']) {
      btn.addEventListener(evt, () => { state[prop] = false; });
    }
  }

  // vliegmodus: knop (mobiel + desktop) of F-toets
  const flyBtn = document.getElementById('fly-btn');
  const flyVert = document.getElementById('fly-vert');
  const setFly = (on) => {
    state.fly = on;
    flyBtn.classList.toggle('active', on);
    flyBtn.textContent = on ? '🚶' : '🪂';
    flyVert.classList.toggle('visible', on && isTouchDevice());
    if (!on) state.flyVert = 0;
  };
  engine.setFly = setFly;
  flyBtn.addEventListener('click', (e) => { e.stopPropagation(); setFly(!state.fly); });
  document.addEventListener('keydown', (e) => { if (e.code === 'KeyF' && state.started && !activeMode) setFly(!state.fly); });
  for (const [id, dir] of [['fly-up', 1], ['fly-down', -1]]) {
    const btn = document.getElementById(id);
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); state.flyVert = dir; });
    for (const evt of ['pointerup', 'pointercancel', 'pointerleave']) {
      btn.addEventListener(evt, () => { state.flyVert = 0; });
    }
  }
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && state.started && !isTouchDevice()) {
      showMenu(); // esc -> terug naar het spelmenu
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== renderer.domElement) return;
    state.yaw -= e.movementX * 0.0022;
    state.pitch = clampPitch(state.pitch - e.movementY * 0.0022);
  });
  document.addEventListener('keydown', (e) => { state.keys.add(e.code); state.pressed.add(e.code); });
  document.addEventListener('keyup', (e) => state.keys.delete(e.code));

  // touch: linker schermhelft joystick, rechter helft kijken
  const joyEl = document.getElementById('joystick');
  const knob = joyEl.querySelector('.knob');
  let joyId = null, joyCenter = { x: 0, y: 0 };

  renderer.domElement.addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) {
      if (t.clientX < window.innerWidth / 2 && joyId === null) {
        joyId = t.identifier;
        joyCenter = { x: t.clientX, y: t.clientY };
        joyEl.style.display = 'block';
        joyEl.style.left = `${t.clientX - 55}px`;
        joyEl.style.top = `${t.clientY - 55}px`;
        state.joystick.active = true;
      } else if (state.lookTouch.id === null) {
        state.lookTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
      }
    }
  }, { passive: true });

  renderer.domElement.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) {
        const dx = t.clientX - joyCenter.x, dy = t.clientY - joyCenter.y;
        const len = Math.hypot(dx, dy) || 1;
        const capped = Math.min(len, 50);
        state.joystick.x = (dx / len) * (capped / 50);
        state.joystick.y = (dy / len) * (capped / 50);
        knob.style.transform = `translate(calc(-50% + ${(dx / len) * capped}px), calc(-50% + ${(dy / len) * capped}px))`;
      } else if (t.identifier === state.lookTouch.id) {
        state.yaw -= (t.clientX - state.lookTouch.x) * 0.005;
        state.pitch = clampPitch(state.pitch - (t.clientY - state.lookTouch.y) * 0.005);
        state.lookTouch.x = t.clientX;
        state.lookTouch.y = t.clientY;
      }
    }
  }, { passive: true });

  const endTouch = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) {
        joyId = null;
        state.joystick = { active: false, x: 0, y: 0 };
        joyEl.style.display = 'none';
        knob.style.transform = 'translate(-50%, -50%)';
      } else if (t.identifier === state.lookTouch.id) {
        state.lookTouch.id = null;
      }
    }
  };
  renderer.domElement.addEventListener('touchend', endTouch);
  renderer.domElement.addEventListener('touchcancel', endTouch);
}

const clampPitch = (p) => Math.max(-1.45, Math.min(1.45, p));
function isTouchDevice() { return 'ontouchstart' in window && navigator.maxTouchPoints > 0; }

// --- loop -------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const DOWN = new THREE.Vector3(0, -1, 0);
function groundHeight(x, z) {
  raycaster.set(new THREE.Vector3(x, 500, z), DOWN);
  const hits = raycaster.intersectObjects(state.walkables, false);
  return hits.length ? hits[0].point.y : null;
}

// ondergrond onder (x,z): overlays liggen boven het gras, eerste hit wint
const surfRay = new THREE.Raycaster();
function surfaceAt(x, z) {
  surfRay.set(new THREE.Vector3(x, 500, z), DOWN);
  const hit = surfRay.intersectObjects(state.surfaces, false)[0];
  return hit ? { cls: hit.object.userData.cls, y: hit.point.y } : null;
}

// muur-botsing: eerste wand binnen dist vanaf origin in richting dir
const wallRay = new THREE.Raycaster();
function castWall(origin, dir, dist) {
  wallRay.set(origin, dir);
  wallRay.far = dist;
  return wallRay.intersectObjects(state.blockers, false)[0] ?? null;
}

// --- spelmodi ----------------------------------------------------------------
let activeMode = null;

function hud(main, sub = '') {
  const el = document.getElementById('ghud');
  el.style.display = main ? 'block' : 'none';
  document.getElementById('ghud-main').textContent = main ?? '';
  document.getElementById('ghud-sub').textContent = sub;
}

function showActions(aIcon = null, bIcon = null, cIcon = null) {
  const holder = document.getElementById('actions');
  holder.style.display = aIcon && isTouchDevice() ? 'flex' : 'none';
  if (aIcon) document.getElementById('btn-a').textContent = aIcon;
  if (bIcon) document.getElementById('btn-b').textContent = bIcon;
  document.getElementById('btn-c').style.display = cIcon ? 'block' : 'none';
  if (cIcon) document.getElementById('btn-c').textContent = cIcon;
}

// schermrand-pointer naar het missie/race-doel
const wpVec = new THREE.Vector3();
function updateWaypoint() {
  const el = document.getElementById('waypoint');
  if (!state.waypoint || !state.started) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  wpVec.copy(state.waypoint);
  wpVec.y = (groundHeight(state.waypoint.x, state.waypoint.z) ?? 0) + 12;
  const p = wpVec.clone().project(camera);
  const behind = p.z > 1;
  let x = (p.x * 0.5 + 0.5) * window.innerWidth;
  let y = (-p.y * 0.5 + 0.5) * window.innerHeight;
  if (behind) { x = window.innerWidth - x; y = window.innerHeight * 0.85; }
  const m = 48; // marge: clamp aan de schermrand
  const cx = Math.max(m, Math.min(window.innerWidth - m, x));
  const cy = Math.max(m + 40, Math.min(window.innerHeight - m - 60, y));
  el.style.left = `${cx}px`;
  el.style.top = `${cy}px`;
  // in beeld: pijl wijst omlaag naar het doel; aan de rand: pijl wijst eruit
  const onScreen = !behind && x === cx && y === cy;
  const deg = onScreen ? 90 : Math.atan2(y - cy, x - cx) * 180 / Math.PI;
  el.querySelector('.arrow').style.transform = `rotate(${deg}deg)`;
  const d = Math.hypot(state.waypoint.x - camera.position.x, state.waypoint.z - camera.position.z);
  el.querySelector('.dist').textContent = `${Math.round(d)} m`;
}

// engine-API die de spelmodi injecteren (menu kiest de mode)
const engine = {
  THREE, scene, camera, state, sky,
  groundHeight, surfaceAt, castWall,
  hud, showActions, isTouchDevice,
  clampPitch, sfx,
  setWaypoint: (v) => { state.waypoint = v ? v.clone() : null; },
  showMenu: () => showMenu(),
  regionInfo: () => state.world?.region ?? null,
  worldOrigin: () => state.world?.origin ?? [0, 0],
};

function showMenu() {
  state.started = false;
  if (activeMode) { activeMode.exit?.(); activeMode = null; }
  hud(null);
  showActions(null);
  document.getElementById('menu-btn').style.display = 'none';
  document.getElementById('overlay').classList.remove('hidden');
  document.exitPointerLock?.();
}

async function startMode(name) {
  ensureAudio(); // user-gesture: audio mag nu starten
  sfx.click();
  if (activeMode) { activeMode.exit?.(); activeMode = null; }
  document.getElementById('overlay').classList.add('hidden');
  document.getElementById('menu-btn').style.display = 'block';
  document.getElementById('fly-btn').style.display = name === 'free' ? 'block' : 'none';
  state.started = true;
  if (isTouchDevice()) document.documentElement.requestFullscreen?.().catch(() => {});
  else renderer.domElement.requestPointerLock();

  if (name === 'fight') {
    const { createFightMode } = await import('./game/stickman.js');
    activeMode = createFightMode(engine);
  } else if (name === 'dojo') {
    const { createDojoMode } = await import('./game/dojo.js');
    activeMode = createDojoMode(engine);
  } else if (name === 'race') {
    const { createRaceMode } = await import('./game/race.js');
    activeMode = createRaceMode(engine);
  } else {
    activeMode = null; // free roam = engine-standaard
    engine.setFly?.(true);
  }
  activeMode?.enter?.();
}

const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);

  if (state.started && activeMode) {
    activeMode.tick(dt); // spelmodus stuurt beweging én camera zelf
    state.pressed.clear();
  } else if (state.started) {
    const fwd = (state.keys.has('KeyW') || state.keys.has('ArrowUp') ? 1 : 0)
      - (state.keys.has('KeyS') || state.keys.has('ArrowDown') ? 1 : 0)
      - state.joystick.y;
    const strafe = (state.keys.has('KeyD') || state.keys.has('ArrowRight') ? 1 : 0)
      - (state.keys.has('KeyA') || state.keys.has('ArrowLeft') ? 1 : 0)
      + state.joystick.x;
    // toetsenbord: shift = rennen; joystick: uitslag bepaalt tempo (rand = rennen)
    const shift = state.keys.has('ShiftLeft') || state.keys.has('ShiftRight');
    let speed = state.fly ? (shift ? FLY_FAST : FLY_SPEED) : (shift ? RUN_SPEED : WALK_SPEED);
    if (state.joystick.active) {
      const deflection = Math.min(1, Math.hypot(state.joystick.x, state.joystick.y));
      const lo = state.fly ? FLY_SPEED : WALK_SPEED;
      const hi = state.fly ? FLY_FAST : RUN_SPEED;
      speed = lo + (hi - lo) * Math.max(0, (deflection - 0.55) / 0.45);
    }

    if (state.fly) {
      // vliegen: vooruit = kijkrichting (incl. omhoog/omlaag kijken)
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      const right = new THREE.Vector3(Math.cos(state.yaw), 0, -Math.sin(state.yaw));
      const move = forward.multiplyScalar(fwd).addScaledVector(right, strafe);
      const vert = state.flyVert
        + (state.keys.has('Space') ? 1 : 0)
        - (state.keys.has('KeyC') ? 1 : 0);
      move.y += vert * 0.9;
      if (move.lengthSq() > 1) move.normalize();
      camera.position.addScaledVector(move, speed * dt);
      const ground = groundHeight(camera.position.x, camera.position.z);
      if (ground !== null && camera.position.y < ground + 0.6) camera.position.y = ground + 0.6;
    } else {
      const dir = new THREE.Vector3(
        Math.sin(state.yaw) * -fwd + Math.cos(state.yaw) * strafe,
        0,
        Math.cos(state.yaw) * -fwd - Math.sin(state.yaw) * strafe
      );
      if (dir.lengthSq() > 1) dir.normalize();
      camera.position.addScaledVector(dir, speed * dt);

      const ground = groundHeight(camera.position.x, camera.position.z);
      if (ground !== null) {
        // zachte verticale interpolatie: geen harde hobbels op mesh-randen
        const target = ground + EYE_HEIGHT;
        camera.position.y += (target - camera.position.y) * Math.min(1, dt * 12);
      }
    }
  }

  if (!activeMode) {
    camera.rotation.set(0, 0, 0);
    camera.rotateY(state.yaw);
    camera.rotateX(state.pitch);
  }
  sky.position.copy(camera.position);

  // zon + schaduwbox reizen met de speler mee (nodig bij tile-streaming)
  sun.target.position.set(camera.position.x, 0, camera.position.z);
  if (state.sunOffset) sun.position.copy(sun.target.position).add(state.sunOffset);
  updateLabelVisibility();
  updateWaypoint();

  renderer.render(scene, camera);
}

// debug/test-hook (harmloos in productie)
window.__ld = { camera, state, labelState, engine, startMode, getMode: () => activeMode };

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
