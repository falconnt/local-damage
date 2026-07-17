// Race-modus: zo snel mogelijk van A naar B. De ondergrond bepaalt je tempo
// (weg = snel, groen/zand = traag), water en gebouwen blokkeren.
// De auto komt uit cars.js (keuze in het menu) en bepaalt het rijgedrag.

import * as THREE from 'three';
import { CARS, buildCarModel } from './cars.js';

const BRAKE = 18.0;
const DRAG = 0.35;
const BOOST_ACCEL = 12;   // extra duw van de turbo
const BOOST_CAP = 1.35;   // topsnelheid × dit tijdens boost
const BOOST_DRAIN = 0.5;  // tank leeg in ~2 s
const BOOST_REFILL = 0.16;
// factor op de offroad-topsnelheid per ondergrond
const OFF = { ground: 1.0, sand: 0.8, green: 0.65, grass: 0.65 };

export function createRaceMode(engine) {
  const { state, camera, hud } = engine;
  const spec = CARS.find((c) => c.id === localStorage.getItem('ld-car')) ?? CARS[0];
  const PHY = spec.physics;
  let car, wheels, goal, goalPos;
  let v = 0, heading = 0, t0 = 0, done = false, steerVis = 0;
  let steerCur = 0, camYaw = 0;
  let boostTank = 1, boostLock = false, baseFov = camera.fov;
  const wheelbase = Math.abs(spec.wheels[0].z - spec.wheels[1].z);

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
      ({ group: car, wheels } = buildCarModel(spec));
      car.name = 'race-car';
      const [sx, sz] = findRoadNear(camera.position.x, camera.position.z);
      const g = engine.groundHeight(sx, sz) ?? 0;
      car.position.set(sx, g, sz);
      engine.scene.add(car);
      v = 0; done = false; boostTank = 1; boostLock = false;
      baseFov = camera.fov;

      const [gx, gz] = pickGoal(sx, sz);
      // start met de neus de weg op, liefst richting het baken
      const toGoal = Math.atan2(gx - sx, gz - sz);
      let bestScore = -Infinity;
      heading = toGoal;
      for (let i = 0; i < 16; i++) {
        const h = (i / 16) * Math.PI * 2;
        let score = 0;
        for (const d of [4, 8, 12, 16, 22]) {
          if (engine.surfaceAt(sx + Math.sin(h) * d, sz + Math.cos(h) * d)?.cls === 'road') score += 1;
        }
        const turn = Math.abs(Math.atan2(Math.sin(h - toGoal), Math.cos(h - toGoal)));
        score = score * 10 - turn; // wegdekking eerst, dan richting doel
        if (score > bestScore) { bestScore = score; heading = h; }
      }
      car.rotation.y = heading;
      camYaw = heading; steerCur = 0; steerVis = 0;
      // camera meteen op zijn volgplek zetten (geen lange zwiep bij de start)
      camera.position.set(sx - Math.sin(heading) * 10, g + 4.2, sz - Math.cos(heading) * 10);
      goalPos = new THREE.Vector3(gx, engine.groundHeight(gx, gz) ?? 0, gz);
      goal = new THREE.Mesh(
        new THREE.CylinderGeometry(3.2, 3.2, 60, 16, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false })
      );
      goal.position.set(goalPos.x, goalPos.y + 30, goalPos.z);
      engine.scene.add(goal);
      engine.setWaypoint?.(goalPos, '🏁');

      engine.showActions('🚀', '🛑');
      engine.sfx?.engineStart();
      t0 = performance.now();
      hud(`🏁 ${spec.name}`, 'gas = W/joystick · 🚀 = turbo · 🛑 = rem/achteruit');
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
      engine.setWaypoint?.(null);
      engine.sfx?.engineStop();
      camera.fov = baseFov;
      camera.updateProjectionMatrix();
    },

    tick(dt) {
      if (done) return;
      // input: W/pijltjes/joystick = gas, 🚀/shift = turbo, 🛑/S = rem & achteruit
      const joyMag = Math.hypot(state.joystick.x, state.joystick.y);
      const throttle = Math.min(1,
        (state.keys.has('KeyW') || state.keys.has('ArrowUp') ? 1 : 0)
        + (joyMag > 0.15 ? Math.max(0, -state.joystick.y) : 0));
      const brake = state.keys.has('KeyS') || state.keys.has('ArrowDown') || state.actionB;
      const steer = (state.keys.has('KeyA') || state.keys.has('ArrowLeft') ? -1 : 0)
        + (state.keys.has('KeyD') || state.keys.has('ArrowRight') ? 1 : 0)
        + (joyMag > 0.15 ? state.joystick.x : 0);

      // turbo: eigen stuwkracht + hogere top, tank loopt leeg en laadt weer op
      const wantBoost = state.actionA || state.keys.has('ShiftLeft') || state.keys.has('ShiftRight');
      if (boostTank <= 0.01) boostLock = true;      // leeg: eerst bijladen
      if (boostTank > 0.3) boostLock = false;
      const boosting = wantBoost && !boostLock && !brake;
      boostTank = Math.max(0, Math.min(1, boostTank + (boosting ? -BOOST_DRAIN : BOOST_REFILL) * dt));

      const surf = engine.surfaceAt(car.position.x, car.position.z);
      const cls = surf?.cls ?? 'grass';
      const vmax = cls === 'road' ? PHY.vmaxRoad
        : cls === 'water' ? 0
        : PHY.vmaxOff * (OFF[cls] ?? 0.7);

      v += (throttle * PHY.accel + (boosting ? BOOST_ACCEL : 0) - DRAG * v) * dt;
      if (brake) {
        // eerst remmen; sta je (bijna) stil, dan rustig achteruit
        if (v > 0.2) v = Math.max(0, v - BRAKE * dt);
        else v = Math.max(v - PHY.accel * 0.7 * dt, -PHY.revMax);
      }
      const cap = Math.max(vmax * (boosting ? BOOST_CAP : 1), Math.abs(v) - 14 * dt);
      v = Math.max(-PHY.revMax, Math.min(v, cap)); // te snel voor deze ondergrond: hard afremmen
      if (Math.abs(v) < 0.02 && !throttle && !brake) v = 0;

      // sturen als een echte auto (fietsmodel): het stuur draait geleidelijk in,
      // de uitslag wordt kleiner bij hoge snelheid en de grip begrenst hoe snel
      // de neus kan draaien — geen "om zijn as schieten" meer
      const steerT = Math.max(-1, Math.min(1, steer));
      const rate = Math.abs(steerT) > Math.abs(steerCur) ? 2.8 : 6; // loslaten = sneller terug
      steerCur += Math.max(-rate * dt, Math.min(rate * dt, steerT - steerCur));
      const angle = steerCur * PHY.steer / (1 + Math.abs(v) / 15);
      let yawRate = (v / wheelbase) * Math.tan(angle);
      const grip = PHY.grip * (cls === 'road' ? 1 : 0.7);
      const yawCap = grip / Math.max(3, Math.abs(v)); // laterale g-limiet
      yawRate = Math.max(-yawCap, Math.min(yawCap, yawRate));
      heading -= yawRate * dt;
      steerVis += (steerCur - steerVis) * Math.min(1, dt * 10);

      const dir = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
      const step = v * dt;
      // botsen: muren en water blokkeren (in beide richtingen)
      const bumper = car.position.clone(); bumper.y += 0.55;
      const sgn = Math.sign(v || 1);
      const ahead = engine.surfaceAt(car.position.x + dir.x * sgn * (Math.abs(step) + 1.6), car.position.z + dir.z * sgn * (Math.abs(step) + 1.6));
      const wallHit = engine.castWall(bumper, dir.clone().multiplyScalar(sgn), Math.abs(step) + 2.1);
      if (wallHit || ahead?.cls === 'water') {
        v = -sgn * Math.min(Math.abs(v) * 0.25, 3); // stuiter zachtjes terug
      } else {
        car.position.addScaledVector(dir, step);
      }
      const g = engine.groundHeight(car.position.x, car.position.z);
      if (g !== null) car.position.y += (g - car.position.y) * Math.min(1, dt * 12);
      car.rotation.y = heading;

      for (const w of wheels) {
        w.mesh.rotation.x += (v / w.r) * dt;
        if (w.front) w.pivot.rotation.y = -steerVis * PHY.steer;
      }
      engine.sfx?.engineUpdate(v * (boosting ? 1.3 : 1));

      // boost voelbaar maken: beeld iets wijder tijdens de turbo
      const fovT = baseFov + (boosting ? 9 : 0) + Math.max(0, v - PHY.vmaxRoad * 0.7) * 0.25;
      camera.fov += (fovT - camera.fov) * Math.min(1, dt * 6);
      camera.updateProjectionMatrix();

      // HUD: tijd + snelheid + turbotank + afstand
      goal.rotation.y += dt * 0.6;
      const sec = (performance.now() - t0) / 1000;
      const gd = Math.hypot(goalPos.x - car.position.x, goalPos.z - car.position.z);
      const segs = Math.round(boostTank * 5);
      const tank = '▰'.repeat(segs) + '▱'.repeat(5 - segs);
      hud(`🏁 ${sec.toFixed(1)} s`, `${Math.round(Math.abs(v) * 3.6)} km/u · ⚡${tank} · ${cls === 'road' ? 'asfalt' : cls} · baken: ${Math.round(gd)} m`);

      if (gd < 8) {
        done = true;
        engine.sfx?.engineStop();
        engine.sfx?.jingle(true);
        const bestKey = `ld-race-best-${spec.id}`;
        const best = Number(localStorage.getItem(bestKey) ?? Infinity);
        if (sec < best) localStorage.setItem(bestKey, String(sec));
        hud(`🏆 finish: ${sec.toFixed(1)} s`, best === Infinity || sec < best
          ? `nieuw record met de ${spec.name}! — terug naar het menu…`
          : `record ${spec.name}: ${best.toFixed(1)} s — terug naar het menu…`);
        setTimeout(() => engine.showMenu(), 3200);
      }

      // losse chase-cam: hangt verder weg en draait traag achter de auto aan,
      // zodat de wereld niet 1-op-1 meezwiept met elke stuurbeweging
      const yawErr = Math.atan2(Math.sin(heading - camYaw), Math.cos(heading - camYaw));
      camYaw += yawErr * Math.min(1, dt * 2.2);
      const dist = 10 + Math.abs(v) * 0.12;
      const back = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw));
      const camT = car.position.clone().addScaledVector(back, dist);
      camT.y = car.position.y + 4.2 + Math.abs(v) * 0.05;
      camera.position.lerp(camT, Math.min(1, dt * 3.5));
      // kijk iets vóór de auto uit, dan is de rijlijn beter in te schatten
      const lead = Math.max(0, v) * 0.35;
      camera.lookAt(
        car.position.x + Math.sin(heading) * lead,
        car.position.y + 1.1,
        car.position.z + Math.cos(heading) * lead
      );
    },
  };
}
