// Local Damage — walking-viewer (MVP stap 1)
// Data: neutrale GLB met klasse-meshes ("class:grass" enz.); stijl komt uit
// palettes/palettes.json + toon-shading + gradient-sky + fog (zie bouwplan).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const TILE_PATHS = ['tiles/', '../dist/tiles/']; // Pages-layout, daarna lokale dev-layout
const EYE_HEIGHT = 1.7;
const WALK_SPEED = 5.0;
const RUN_SPEED = 11.0;

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
};

// --- renderer / scene ------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
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
  document.getElementById('area-name').textContent = area.name;

  const gltf = await new GLTFLoader().loadAsync(base + area.file);
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
    node.castShadow = cls === 'roof' || cls === 'wall';
    node.receiveShadow = true;
    state.classMeshes.set(cls, [...(state.classMeshes.get(cls) ?? []), node]);
    if (cls === 'grass' || cls === 'road' || cls === 'ground') state.walkables.push(node);
    worldBounds.expandByObject(node);
  });
  scene.add(gltf.scene);

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
  if (isTouchDevice()) document.getElementById('start-hint').textContent =
    'tik om te lopen — linkerduim = bewegen · rechterduim = kijken';

  overlay.addEventListener('click', () => {
    overlay.classList.add('hidden');
    state.started = true;
    if (!isTouchDevice()) renderer.domElement.requestPointerLock();
  });
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
    const speed = state.keys.has('ShiftLeft') || state.keys.has('ShiftRight') ? RUN_SPEED : WALK_SPEED;

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

  camera.rotation.set(0, 0, 0);
  camera.rotateY(state.yaw);
  camera.rotateX(state.pitch);
  sky.position.copy(camera.position);

  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
