// Stickman-vechtmissie: loop van A naar B, schakel vijanden uit onderweg.
// De stickman is volledig procedureel (capsule-rig + keyframe-clips met
// easing) — geen externe assets, dus werkt binnen de strikte CSP van Pages.

import * as THREE from 'three';

const WALK = 3.2, RUN = 6.5;
const PLAYER_HP = 5, ENEMY_HP = 2;

// --- rig ----------------------------------------------------------------------
function limb(len, radius, color) {
  const pivot = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(radius, len - radius * 2, 3, 8),
    new THREE.MeshToonMaterial({ color })
  );
  mesh.position.y = -len / 2;
  mesh.castShadow = true;
  pivot.add(mesh);
  return pivot;
}

export function buildStickman(color = 0x20242c) {
  const j = {}; // joints
  const root = new THREE.Group();          // heupen (~0.95 m)
  j.root = root;

  j.torso = limb(0.55, 0.055, color);      // romp: pivot bij heup, omhoog
  j.torso.children[0].position.y = 0.275;  // capsule boven de pivot
  root.add(j.torso);

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 12, 10),
    new THREE.MeshToonMaterial({ color })
  );
  head.position.y = 0.72;
  head.castShadow = true;
  j.torso.add(head);
  j.head = head;

  for (const [side, sx] of [['L', -1], ['R', 1]]) {
    const sh = limb(0.3, 0.045, color);    // bovenarm
    sh.position.set(sx * 0.2, 0.52, 0);
    j.torso.add(sh);
    const el = limb(0.3, 0.04, color);     // onderarm
    el.position.y = -0.28;
    sh.add(el);
    const hip = limb(0.45, 0.05, color);   // bovenbeen
    hip.position.set(sx * 0.11, 0, 0);
    root.add(hip);
    const knee = limb(0.45, 0.045, color); // onderbeen
    knee.position.y = -0.43;
    hip.add(knee);
    j['s' + side] = sh; j['e' + side] = el; j['h' + side] = hip; j['k' + side] = knee;
  }
  return { root, j };
}

// --- pose/clip-systeem ----------------------------------------------------------
// pose = { jointnaam: [rx, ry, rz] }; clip = keyframes op genormaliseerde tijd
const JOINTS = ['torso', 'sL', 'sR', 'eL', 'eR', 'hL', 'hR', 'kL', 'kR'];
const ease = (t) => t * t * (3 - 2 * t); // smoothstep: vloeiende anticipatie/afronding

function samplePose(clip, t) {
  const frames = clip.frames;
  let a = frames[0], b = frames[frames.length - 1];
  for (let i = 0; i < frames.length - 1; i++) {
    if (t >= frames[i].at && t <= frames[i + 1].at) { a = frames[i]; b = frames[i + 1]; break; }
  }
  const span = Math.max(1e-5, b.at - a.at);
  const f = ease(Math.min(1, Math.max(0, (t - a.at) / span)));
  const pose = {};
  for (const name of JOINTS) {
    const pa = a.pose[name] ?? [0, 0, 0];
    const pb = b.pose[name] ?? [0, 0, 0];
    pose[name] = [0, 1, 2].map((i) => pa[i] + (pb[i] - pa[i]) * f);
  }
  return pose;
}

function applyPose(j, pose, blend = 1) {
  for (const name of JOINTS) {
    const [rx, ry, rz] = pose[name] ?? [0, 0, 0];
    const g = j[name];
    g.rotation.x += (rx - g.rotation.x) * blend;
    g.rotation.y += (ry - g.rotation.y) * blend;
    g.rotation.z += (rz - g.rotation.z) * blend;
  }
}

// vechtclips: wind-up -> strike -> recover ("vloeiende karate", taekwondo-kick)
const CLIPS = {
  jab: {
    dur: 0.38, hitFrom: 0.35, hitTo: 0.6, reach: 1.35, dmg: 1,
    frames: [
      { at: 0.0, pose: { sR: [-0.4, 0, -0.15], eR: [-1.9, 0, 0], torso: [0, 0.25, 0] } },
      { at: 0.45, pose: { sR: [-1.55, 0, 0], eR: [-0.08, 0, 0], sL: [-0.3, 0, 0.2], eL: [-1.6, 0, 0], torso: [0.12, -0.45, 0] } },
      { at: 1.0, pose: { sR: [-0.4, 0, -0.15], eR: [-1.7, 0, 0], torso: [0, 0, 0] } },
    ],
  },
  frontkick: {
    dur: 0.55, hitFrom: 0.38, hitTo: 0.62, reach: 1.75, dmg: 1,
    frames: [
      { at: 0.0, pose: { hR: [0.2, 0, 0], kR: [0.3, 0, 0], torso: [0.1, 0, 0] } },
      { at: 0.3, pose: { hR: [-1.9, 0, 0], kR: [2.1, 0, 0], torso: [-0.18, 0, 0], sL: [-0.9, 0, 0.3], sR: [-0.9, 0, -0.3] } },
      { at: 0.52, pose: { hR: [-1.6, 0, 0], kR: [0.12, 0, 0], torso: [-0.3, 0, 0], sL: [-0.9, 0, 0.3], sR: [-0.9, 0, -0.3] } },
      { at: 1.0, pose: { hR: [0, 0, 0], kR: [0, 0, 0], torso: [0, 0, 0] } },
    ],
  },
  roundhouse: {
    dur: 0.75, hitFrom: 0.42, hitTo: 0.66, reach: 1.85, dmg: 2,
    frames: [
      { at: 0.0, pose: { torso: [0, 0.4, 0], hL: [0.25, 0, 0] } },
      { at: 0.32, pose: { torso: [0.08, 1.35, -0.25], hL: [-1.2, 0.7, 0], kL: [1.9, 0, 0], sL: [-1.1, 0, 0.4], sR: [-0.7, 0, -0.5] } },
      { at: 0.55, pose: { torso: [0.05, 2.4, -0.35], hL: [-1.55, 1.25, 0], kL: [0.15, 0, 0], sL: [-1.2, 0, 0.5], sR: [-0.6, 0, -0.6] } },
      { at: 1.0, pose: { torso: [0, 0, 0], hL: [0, 0, 0], kL: [0, 0, 0] } },
    ],
  },
  hit: {
    dur: 0.35, frames: [
      { at: 0.0, pose: {} },
      { at: 0.35, pose: { torso: [-0.5, 0, 0.12], sL: [-0.6, 0, 0.4], sR: [-0.6, 0, -0.4] } },
      { at: 1.0, pose: {} },
    ],
  },
};

// --- personage (speler of vijand) -----------------------------------------------
class Fighter {
  constructor(engine, color, x, z) {
    const { root, j } = buildStickman(color);
    this.engine = engine;
    this.root = root;
    this.j = j;
    this.hp = ENEMY_HP;
    this.heading = 0;
    this.walkPhase = 0;
    this.clip = null;
    this.clipT = 0;
    this.hitDone = false;
    this.downT = null; // knock-out animatietijd
    this.stun = 0;
    const g = engine.groundHeight(x, z) ?? 0;
    root.position.set(x, g + 0.95, z);
    engine.scene.add(root);
  }

  play(name) {
    if (this.clip || this.downT !== null) return false;
    this.clip = CLIPS[name];
    this.clipName = name;
    this.clipT = 0;
    this.hitDone = false;
    return true;
  }

  // beweging + animatie; move = THREE.Vector3 (xz), speed m/s
  update(dt, move, running) {
    const e = this.engine;
    if (this.downT !== null) { // neergaan: kantelen en blijven liggen
      this.downT = Math.min(1, this.downT + dt * 2.2);
      this.root.rotation.z = (Math.PI / 2) * ease(this.downT);
      this.root.position.y += ((this.groundY() + 0.25) - this.root.position.y) * 0.2;
      return;
    }
    this.stun = Math.max(0, this.stun - dt);

    let speed = 0;
    if (move.lengthSq() > 0.001 && !this.clip && this.stun <= 0) {
      speed = running ? RUN : WALK;
      const next = this.root.position.clone().addScaledVector(move, speed * dt);
      // muurbotsing: korte straal vooruit op borsthoogte
      const origin = this.root.position.clone(); origin.y += 0.2;
      if (!e.castWall(origin, move, speed * dt + 0.45)) {
        this.root.position.x = next.x;
        this.root.position.z = next.z;
      }
      this.heading = Math.atan2(move.x, move.z);
    }
    // grond volgen
    const g = this.groundY();
    this.root.position.y += ((g + 0.95) - this.root.position.y) * Math.min(1, dt * 14);
    this.root.rotation.y += shortestAngle(this.root.rotation.y, this.heading) * Math.min(1, dt * 12);

    // animatie: clip heeft voorrang, anders loop/idle-cycle
    if (this.clip) {
      this.clipT += dt / this.clip.dur;
      if (this.clipT >= 1) { this.clip = null; }
      else { applyPose(this.j, samplePose(this.clip, this.clipT), 0.8); return; }
    }
    this.walkPhase += dt * (speed > 0 ? speed * 2.4 : 0);
    const ph = this.walkPhase;
    const amp = speed > 0 ? (running ? 0.85 : 0.6) : 0;
    const idle = Math.sin(performance.now() / 700) * 0.03;
    applyPose(this.j, {
      hL: [Math.sin(ph) * amp, 0, 0],
      hR: [-Math.sin(ph) * amp, 0, 0],
      kL: [Math.max(0, -Math.sin(ph)) * amp * 1.4, 0, 0],
      kR: [Math.max(0, Math.sin(ph)) * amp * 1.4, 0, 0],
      sL: [-Math.sin(ph) * amp * 0.7 - 0.08, 0, 0.1 + idle],
      sR: [Math.sin(ph) * amp * 0.7 - 0.08, 0, -0.1 - idle],
      eL: [-0.35 - Math.max(0, Math.sin(ph)) * amp * 0.4, 0, 0],
      eR: [-0.35 - Math.max(0, -Math.sin(ph)) * amp * 0.4, 0, 0],
      torso: [speed > 0 ? 0.12 : 0.02 + idle * 0.5, 0, 0],
    }, 0.6);
    this.root.position.y += Math.abs(Math.cos(ph)) * 0.03 * (speed > 0 ? 1 : 0);
  }

  groundY() {
    return this.engine.groundHeight(this.root.position.x, this.root.position.z) ?? this.root.position.y - 0.95;
  }

  // raakt deze fighter (tijdens strike-venster) het doel?
  strikes(target) {
    if (!this.clip || this.hitDone) return false;
    if (this.clipT < this.clip.hitFrom || this.clipT > this.clip.hitTo) return false;
    const d = this.root.position.distanceTo(target.root.position);
    if (d > this.clip.reach) return false;
    const dir = target.root.position.clone().sub(this.root.position);
    const facing = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    if (facing.dot(dir.normalize()) < 0.35) return false;
    this.hitDone = true;
    return true;
  }

  takeHit(dmg, from) {
    this.hp -= dmg;
    this.stun = 0.45;
    this.clip = null;
    if (this.hp <= 0) { this.downT = 0; }
    else { this.play('hit'); }
    // kleine knockback van de aanvaller af
    const push = this.root.position.clone().sub(from.root.position).setY(0).normalize();
    this.root.position.addScaledVector(push, 0.5);
  }

  dispose() {
    this.engine.scene.remove(this.root);
    this.root.traverse((n) => { if (n.isMesh) { n.geometry.dispose(); n.material.dispose(); } });
  }
}

function shortestAngle(from, to) {
  return ((to - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

// --- missie-modus -----------------------------------------------------------------
export function createFightMode(engine) {
  const { state, camera, hud } = engine;
  let player, enemies = [], goal, goalPos, done = false;
  let hp = PLAYER_HP;
  let prevA = false, prevB = false, comboB = 0;

  function pickGoal() {
    // doel: schuin tegenover de spawn, zo ver mogelijk binnen de regio
    const region = engine.regionInfo();
    const p = camera.position;
    if (region) {
      const [wox, woy] = engine.worldOrigin();
      const s = region.tile_size_m;
      const xs = region.tiles.map((t) => t.origin_rd[0] - wox);
      const zs = region.tiles.map((t) => -(t.origin_rd[1] - woy));
      const corners = [
        [Math.min(...xs) + 60, Math.min(...zs) - 60],
        [Math.max(...xs) + s - 60, Math.min(...zs) - 60],
        [Math.min(...xs) + 60, Math.max(...zs) - s + 60],
        [Math.max(...xs) + s - 60, Math.max(...zs) - s + 60],
      ];
      corners.sort((a, b) =>
        Math.hypot(b[0] - p.x, b[1] - p.z) - Math.hypot(a[0] - p.x, a[1] - p.z));
      return new THREE.Vector3(corners[0][0], 0, corners[0][1]);
    }
    return new THREE.Vector3(p.x + 250, 0, p.z - 250);
  }

  return {
    enter() {
      const p = camera.position;
      player = new Fighter(engine, 0x20242c, p.x, p.z);
      player.hp = PLAYER_HP;

      goalPos = pickGoal();
      goalPos.y = (engine.groundHeight(goalPos.x, goalPos.z) ?? 0);
      goal = new THREE.Mesh(
        new THREE.CylinderGeometry(2.4, 2.4, 60, 16, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x69d2ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false })
      );
      goal.position.set(goalPos.x, goalPos.y + 30, goalPos.z);
      engine.scene.add(goal);

      // vijanden verspreid langs de route
      const from = player.root.position;
      for (let i = 1; i <= 6; i++) {
        const f = i / 7;
        const jitter = () => (Math.random() - 0.5) * 70;
        const x = from.x + (goalPos.x - from.x) * f + jitter();
        const z = from.z + (goalPos.z - from.z) * f + jitter();
        if ((engine.surfaceAt(x, z)?.cls ?? 'grass') === 'water') continue;
        const foe = new Fighter(engine, 0x8c2626, x, z);
        enemies.push(foe);
      }
      engine.showActions('👊', '🦵');
      hud(`❤️`.repeat(hp), 'versla vijanden · haal het blauwe baken');
    },

    exit() {
      player?.dispose();
      for (const f of enemies) f.dispose();
      enemies = [];
      if (goal) {
        engine.scene.remove(goal);
        goal.geometry.dispose(); goal.material.dispose();
      }
      done = false;
    },

    tick(dt) {
      if (done) return;
      // input: bewegen relatief aan camera-yaw
      const fwd = (state.keys.has('KeyW') ? 1 : 0) - (state.keys.has('KeyS') ? 1 : 0) - state.joystick.y;
      const strafe = (state.keys.has('KeyD') ? 1 : 0) - (state.keys.has('KeyA') ? 1 : 0) + state.joystick.x;
      const running = state.keys.has('ShiftLeft') || Math.hypot(state.joystick.x, state.joystick.y) > 0.85;
      const move = new THREE.Vector3(
        Math.sin(state.yaw) * -fwd + Math.cos(state.yaw) * strafe, 0,
        Math.cos(state.yaw) * -fwd - Math.sin(state.yaw) * strafe
      );
      if (move.lengthSq() > 1) move.normalize();

      // aanvallen: 👊 = jab, 🦵 = kick (2e kick binnen 0.9s = roundhouse)
      const a = state.actionA || state.keys.has('KeyJ');
      const b = state.actionB || state.keys.has('KeyK');
      if (a && !prevA) player.play('jab');
      if (b && !prevB) {
        const now = performance.now();
        player.play(now - comboB < 900 ? 'roundhouse' : 'frontkick');
        comboB = now;
      }
      prevA = a; prevB = b;

      // richt automatisch op de dichtstbijzijnde vijand tijdens een aanval
      if (player.clip) {
        const near = enemies.filter((f) => f.downT === null)
          .sort((x, y) => x.root.position.distanceTo(player.root.position) - y.root.position.distanceTo(player.root.position))[0];
        if (near && near.root.position.distanceTo(player.root.position) < 3.5) {
          player.heading = Math.atan2(
            near.root.position.x - player.root.position.x,
            near.root.position.z - player.root.position.z);
        }
      }
      player.update(dt, move, running);

      // vijand-AI: achtervolgen en aanvallen
      for (const foe of enemies) {
        const toP = player.root.position.clone().sub(foe.root.position).setY(0);
        const d = toP.length();
        let foeMove = new THREE.Vector3();
        if (foe.downT === null && d < 45) {
          if (d > 1.5) foeMove = toP.normalize();
          else if (!foe.clip && foe.stun <= 0 && Math.random() < dt * 1.4) {
            foe.heading = Math.atan2(toP.x, toP.z);
            foe.play(Math.random() < 0.6 ? 'jab' : 'frontkick');
          }
        }
        foe.update(dt, foeMove, false);
        if (foe.strikes(player)) {
          hp -= 1;
          player.takeHit(0, foe); // knockback/anim; hp beheren we hier
          player.hp = 99;
          hud('❤️'.repeat(Math.max(0, hp)), 'versla vijanden · haal het blauwe baken');
          if (hp <= 0) {
            done = true;
            hud('💀 verslagen', 'terug naar het menu…');
            setTimeout(() => engine.showMenu(), 2200);
          }
        }
        if (player.strikes(foe)) foe.takeHit(player.clip?.dmg ?? 1, player);
      }

      // doel bereikt?
      goal.rotation.y += dt * 0.6;
      const gd = player.root.position.distanceTo(new THREE.Vector3(goalPos.x, player.root.position.y, goalPos.z));
      if (gd < 6) {
        done = true;
        const downed = enemies.filter((f) => f.downT !== null).length;
        hud('🏆 missie volbracht!', `${downed} vijanden uitgeschakeld — terug naar het menu…`);
        setTimeout(() => engine.showMenu(), 3200);
      } else if (!done) {
        hud('❤️'.repeat(Math.max(0, hp)), `🥋 baken: ${Math.round(gd)} m`);
      }

      // derde-persoons camera: orbit rond de speler op state.yaw/pitch
      const pp = player.root.position;
      const dist = 4.6, pitch = Math.max(-0.9, Math.min(0.5, state.pitch));
      camera.position.set(
        pp.x + Math.sin(state.yaw) * Math.cos(pitch) * dist,
        pp.y + 1.4 + Math.sin(-pitch) * dist * 0.8,
        pp.z + Math.cos(state.yaw) * Math.cos(pitch) * dist
      );
      camera.lookAt(pp.x, pp.y + 1.0, pp.z);
    },
  };
}
