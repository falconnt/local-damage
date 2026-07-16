// Local Damage — walking-viewer (MVP stap 1)
// Data: neutrale GLB met klasse-meshes ("class:grass" enz.); stijl komt uit
// palettes/palettes.json + toon-shading + gradient-sky + fog (zie bouwplan).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const TILE_PATHS = ['tiles/', '../dist/tiles/']; // Pages-layout, daarna lokale dev-layout
const EYE_HEIGHT = 1.7;
const WALK_SPEED = 5.0;
const RUN_SPEED = 11.0;
const FLY_SPEED = 22.0;
const FLY_FAST = 45.0;

const state = {
  paletteName: 'sunset',
  palettes: {},
  yaw: 0,
  pitch: -0.05,
  velocity: new THREE.Vector3(),
  keys: new Set(),
  joystick: { active: false, x: 0, y: 0 },
  lookTouch: { id: null, x: 0, y: 0 },
  walkables: [],
  classMeshes: new Map(),
  started: false,
  fly: false,
  flyVert: 0, // -1/0/+1 via mobiele knoppen
};

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

async function init() {
  state.palettes = await (await fetch('./palettes/palettes.json')).json();
  buildPaletteButtons();

  const { base, manifest } = await findManifest();
  const area = manifest.areas[manifest.areas.length - 1]; // nieuwste gebied
  document.getElementById('area-name').textContent = `${area.name} — laden…`;

  // laadbalk: GLB's van echte wijken zijn 10-20 MB, op mobiel duurt dat even
  const progressBar = document.querySelector('#progress .bar');
  const gltf = await new GLTFLoader().loadAsync(base + area.file, (evt) => {
    if (evt.total > 0) {
      progressBar.style.width = `${Math.round((evt.loaded / evt.total) * 100)}%`;
    } else {
      progressBar.style.width = '100%';
      document.getElementById('area-name').textContent =
        `${area.name} — ${(evt.loaded / 1e6).toFixed(1)} MB geladen…`;
    }
  });
  document.getElementById('area-name').textContent = area.name;
  document.getElementById('progress').classList.add('hidden');
  const worldBounds = new THREE.Box3();
  gltf.scene.traverse((node) => {
    if (!node.isMesh) return;
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
    state.classMeshes.set(cls, [...(state.classMeshes.get(cls) ?? []), node]);
    if (cls === 'grass' || cls === 'road' || cls === 'ground') state.walkables.push(node);
    worldBounds.expandByObject(node);
  });
  scene.add(gltf.scene);

  // huisnummerbordjes + straatnaamborden (blauw/wit, NL-stijl)
  if (area.addresses) {
    try {
      const labels = await (await fetch(base + area.addresses)).json();
      buildLabels(labels);
    } catch (err) {
      console.warn('adresbordjes niet geladen:', err);
    }
  }

  // spawn iets ten zuiden van het midden, kijkend richting het centrum
  const center = worldBounds.getCenter(new THREE.Vector3());
  const spawn = { x: center.x, z: center.z + 60 };
  state.yaw = 0; // -Z = noord = richting centrum
  camera.position.set(spawn.x, worldBounds.max.y + 30, spawn.z);
  const ground = groundHeight(spawn.x, spawn.z);
  camera.position.y = (ground ?? 0) + EYE_HEIGHT;

  // zon-schaduwbox over het hele gebied
  const size = worldBounds.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.z) * 0.75;
  Object.assign(sun.shadow.camera, { left: -radius, right: radius, top: radius, bottom: -radius, far: 4 * radius });
  sun.target.position.copy(center);

  applyPalette(state.paletteName);
  setupControls();
  renderer.setAnimationLoop(tick);
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

function buildLabels(data) {
  const group = new THREE.Group();
  for (const item of data.items ?? []) {
    const plaque = makePlaque(item.number, item.pos, item.n, { big: false });
    labelState.numbers.push(plaque);
    group.add(plaque);
  }
  for (const sign of data.signs ?? []) {
    const plaque = makePlaque(sign.street, sign.pos, sign.n, { big: true });
    labelState.signs.push(plaque);
    group.add(plaque);
  }

  // zwevende straatnamen boven de straat: orientatie in de wijk
  const byStreet = new Map();
  for (const item of data.items ?? []) {
    if (!byStreet.has(item.street)) byStreet.set(item.street, []);
    byStreet.get(item.street).push(item.pos);
  }
  for (const [street, positions] of byStreet) {
    if (positions.length < 2) continue; // losse adressen geen wijklabel
    const c = positions
      .reduce((acc, p) => acc.add(new THREE.Vector3(...p)), new THREE.Vector3())
      .divideScalar(positions.length);
    const tex = streetNameTexture(street);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex,
      depthTest: false, // altijd leesbaar, ook achter huizen/bomen
      transparent: true,
      opacity: 0.92,
    }));
    sprite.renderOrder = 999;
    sprite.position.set(c.x, c.y + 24, c.z);
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
    s.material.opacity = d < 28 ? 0 : 0.92; // vlak eronder: niet in je gezicht
  }
  // huisnummers alleen dichtbij tonen; straatnaamborden dragen verder
  if (++labelTick % 30 !== 0) return;
  for (const m of labelState.numbers) m.visible = m.position.distanceToSquared(p) < 70 * 70;
  for (const m of labelState.signs) m.visible = m.position.distanceToSquared(p) < 220 * 220;
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
  sun.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el))
    .multiplyScalar(600).add(sun.target.position);

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
  const startBtn = document.getElementById('start-btn');
  document.getElementById('start-hint').textContent = isTouchDevice()
    ? 'linkerduim = lopen (verder duwen = rennen) · rechterduim = rondkijken · 🪂 = vliegen'
    : 'WASD = bewegen · muis = kijken · shift = rennen · F = vliegen (spatie/C = stijgen/dalen)';
  startBtn.style.display = 'inline-block';

  const start = () => {
    overlay.classList.add('hidden');
    state.started = true;
    if (isTouchDevice()) {
      // volledig scherm voelt als een echte app; mislukt stilletjes in PWA-modus
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      renderer.domElement.requestPointerLock();
    }
  };
  startBtn.addEventListener('click', (e) => { e.stopPropagation(); start(); });
  overlay.addEventListener('click', start);

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
  flyBtn.addEventListener('click', (e) => { e.stopPropagation(); setFly(!state.fly); });
  document.addEventListener('keydown', (e) => { if (e.code === 'KeyF' && state.started) setFly(!state.fly); });
  for (const [id, dir] of [['fly-up', 1], ['fly-down', -1]]) {
    const btn = document.getElementById(id);
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); state.flyVert = dir; });
    for (const evt of ['pointerup', 'pointercancel', 'pointerleave']) {
      btn.addEventListener(evt, () => { state.flyVert = 0; });
    }
  }
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && state.started && !isTouchDevice()) {
      overlay.classList.remove('hidden'); // esc -> menu terug
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== renderer.domElement) return;
    state.yaw -= e.movementX * 0.0022;
    state.pitch = clampPitch(state.pitch - e.movementY * 0.0022);
  });
  document.addEventListener('keydown', (e) => state.keys.add(e.code));
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

const clock = new THREE.Clock();
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);

  if (state.started) {
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

  camera.rotation.set(0, 0, 0);
  camera.rotateY(state.yaw);
  camera.rotateX(state.pitch);
  sky.position.copy(camera.position);
  updateLabelVisibility();

  renderer.render(scene, camera);
}

// debug/test-hook (harmloos in productie)
window.__ld = { camera, state, labelState };

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
