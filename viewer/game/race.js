// Race-modus: zo snel mogelijk van A naar B. De ondergrond bepaalt je tempo
// (weg = snel, groen/zand = traag), water en gebouwen blokkeren.

import * as THREE from 'three';

const ACCEL = 9.0;
const BRAKE = 18.0;
const DRAG = 0.35;
// maximumsnelheid (m/s) per ondergrond
const VMAX = { road: 33, ground: 15, sand: 12, green: 10, grass: 10, water: 0 };

function buildCar() {
  const car = new THREE.Group();
  const paint = new THREE.MeshToonMaterial({ color: 0xd8552f });
  const dark = new THREE.MeshToonMaterial({ color: 0x22242c });

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.45, 3.7), paint);
  body.position.y = 0.42;
  body.castShadow = true;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.42, 1.7), new THREE.MeshToonMaterial({ color: 0xe8e2d2 }));
  cabin.position.set(0, 0.85, -0.25);
  cabin.castShadow = true;
  car.add(body, cabin);

  const wheels = [];
  for (const [x, z] of [[-0.82, 1.25], [0.82, 1.25], [-0.82, -1.25], [0.82, -1.25]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.26, 10), dark);
    w.rotation.z = Math.PI / 2;
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.34, z);
    pivot.add(w);
    car.add(pivot);
    wheels.push({ pivot, mesh: w, front: z > 0 });
  }
  return { car, wheels };
}

export function createRaceMode(engine) {
  const { state, camera, hud } = engine;
  let car, wheels, goal, goalPos;
  let v = 0, heading = 0, t0 = 0, done = false, steerVis = 0;

  function findRoadNear(x, z, maxR = 140) {
    // spiraal-samples tot we een wegcel vinden
    for (let r = 0; r <= maxR; r += 8) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
        const sx = x + Math.cos(a) * r, sz = z + Math.sin(a) * r;
        if (engine.surfaceAt(sx, sz)?.cls === 'road') return [sx, sz];
      }
    }
    return [x, z];
  }

  function pickGoal(fromX, fromZ) {
    const region = engine.regionInfo();
    if (region) {
      const [wox, woy] = engine.worldOrigin();
      const s = region.tile_size_m;
      const xs = region.tiles.map((t) => t.origin_rd[0] - wox);
      const zs = region.tiles.map((t) => -(t.origin_rd[1] - woy));
      const corners = [
        [Math.min(...xs) + 80, Math.min(...zs) - 80],
        [Math.max(...xs) + s - 80, Math.min(...zs) - 80],
        [Math.min(...xs) + 80, Math.max(...zs) - s + 80],
        [Math.max(...xs) + s - 80, Math.max(...zs) - s + 80],
      ].sort((a, b) => Math.hypot(b[0] - fromX, b[1] - fromZ) - Math.hypot(a[0] - fromX, a[1] - fromZ));
      return corners[0];
    }
    return [fromX + 300, fromZ - 300];
  }

  return {
    enter() {
      ({ car, wheels } = buildCar());
      const [sx, sz] = findRoadNear(camera.position.x, camera.position.z);
      const g = engine.groundHeight(sx, sz) ?? 0;
      car.position.set(sx, g, sz);
      engine.scene.add(car);
      v = 0; heading = 0; done = false;

      const [gx, gz] = pickGoal(sx, sz);
      goalPos = new THREE.Vector3(gx, engine.groundHeight(gx, gz) ?? 0, gz);
      goal = new THREE.Mesh(
        new THREE.CylinderGeometry(3.2, 3.2, 60, 16, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false })
      );
      goal.position.set(goalPos.x, goalPos.y + 30, goalPos.z);
      engine.scene.add(goal);

      engine.showActions('🚀', '🛑');
      t0 = performance.now();
      hud('🏁 0.0', 'rij naar het gele baken — weg is snel, gras is traag');
    },

    exit() {
      if (car) {
        engine.scene.remove(car);
        car.traverse((n) => { if (n.isMesh) { n.geometry.dispose(); n.material.dispose(); } });
      }
      if (goal) {
        engine.scene.remove(goal);
        goal.geometry.dispose(); goal.material.dispose();
      }
    },

    tick(dt) {
      if (done) return;
      // input: pijltjes/WASD of joystick; mobiel: 🚀/🛑 + joystick sturen
      const joyMag = Math.hypot(state.joystick.x, state.joystick.y);
      const throttle = (state.keys.has('KeyW') || state.keys.has('ArrowUp') || state.actionA ? 1 : 0)
        + (joyMag > 0.15 ? Math.max(0, -state.joystick.y) : 0);
      const brake = state.keys.has('KeyS') || state.keys.has('ArrowDown') || state.actionB ? 1 : 0;
      const steer = (state.keys.has('KeyA') || state.keys.has('ArrowLeft') ? -1 : 0)
        + (state.keys.has('KeyD') || state.keys.has('ArrowRight') ? 1 : 0)
        + (joyMag > 0.15 ? state.joystick.x : 0);

      const surf = engine.surfaceAt(car.position.x, car.position.z);
      const cls = surf?.cls ?? 'grass';
      const vmax = VMAX[cls] ?? 10;

      v += (Math.min(1, throttle) * ACCEL - DRAG * v - brake * BRAKE * Math.sign(v)) * dt;
      v = Math.max(-6, Math.min(v, Math.max(vmax, v - 14 * dt))); // te snel voor deze ondergrond: hard afremmen
      if (Math.abs(v) < 0.02 && !throttle) v = 0;

      // sturen: effect schaalt met snelheid (zoals een echte auto)
      const steerClamped = Math.max(-1, Math.min(1, steer));
      heading -= steerClamped * (v / VMAX.road) * 2.4 * dt * Math.sign(v || 1);
      steerVis += (steerClamped - steerVis) * Math.min(1, dt * 10);

      const dir = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
      const step = v * dt;
      // botsen: muren en water blokkeren
      const bumper = car.position.clone(); bumper.y += 0.55;
      const ahead = engine.surfaceAt(car.position.x + dir.x * (step + 1.6), car.position.z + dir.z * (step + 1.6));
      const wallHit = engine.castWall(bumper, dir.clone().multiplyScalar(Math.sign(v || 1)), Math.abs(step) + 2.1);
      if (wallHit || ahead?.cls === 'water') {
        v = -Math.sign(v) * Math.min(Math.abs(v) * 0.25, 3); // stuiter zachtjes terug
      } else {
        car.position.addScaledVector(dir, step);
      }
      const g = engine.groundHeight(car.position.x, car.position.z);
      if (g !== null) car.position.y += (g - car.position.y) * Math.min(1, dt * 12);
      car.rotation.y = heading;

      for (const w of wheels) {
        w.mesh.rotation.x += (v / 0.34) * dt;
        if (w.front) w.pivot.rotation.y = -steerVis * 0.45;
      }

      // HUD: tijd + snelheid + afstand
      goal.rotation.y += dt * 0.6;
      const sec = (performance.now() - t0) / 1000;
      const gd = Math.hypot(goalPos.x - car.position.x, goalPos.z - car.position.z);
      hud(`🏁 ${sec.toFixed(1)} s`, `${Math.round(Math.abs(v) * 3.6)} km/u · ${cls === 'road' ? 'asfalt' : cls} · baken: ${Math.round(gd)} m`);

      if (gd < 8) {
        done = true;
        const best = Number(localStorage.getItem('ld-race-best') ?? Infinity);
        if (sec < best) localStorage.setItem('ld-race-best', String(sec));
        hud(`🏆 finish: ${sec.toFixed(1)} s`, best === Infinity || sec < best
          ? 'nieuw record! — terug naar het menu…'
          : `record: ${best.toFixed(1)} s — terug naar het menu…`);
        setTimeout(() => engine.showMenu(), 3200);
      }

      // chase-cam achter de auto
      const back = new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading));
      const camT = car.position.clone().addScaledVector(back, 7.5);
      camT.y = car.position.y + 3.2;
      camera.position.lerp(camT, Math.min(1, dt * 5));
      camera.lookAt(car.position.x, car.position.y + 1.0, car.position.z);
    },
  };
}
