// Stickman-vechtmissie 2.0 — technieken uit productie-vechtgames:
// hitstop + shake op impact, per-segment easing (zweepslag-strikes),
// overlapping action (hoofd/onderarmen volgen vertraagd), root motion
// (uitval), cancel-windows voor combo's, i-frames op de dodge en een
// bullet-time finisher. Moves zijn data (moves.js).

import * as THREE from 'three';
import { MOVES, CHAIN_A, CHAIN_B } from './moves.js';

const WALK = 3.4, RUN = 7.0;
const PLAYER_HP = 6, DUMMY_HP = 3;

// per-joint volgsnelheid: de hoofdactie volgt de keyframes strak (hoge
// waarden), alleen hoofd en onderarmen slepen na -> overlapping action als
// subtiele tweede laag, zonder de zweepslag van de strike af te vlakken
const JOINT_LAG = {
  torso: 50, hL: 45, hR: 45, sL: 42, sR: 42, kL: 38, kR: 38, eL: 18, eR: 18, head: 11,
};
const JOINTS = Object.keys(JOINT_LAG);

const EASE = {
  smooth: (t) => t * t * (3 - 2 * t),
  in: (t) => t * t * t,
  out: (t) => 1 - Math.pow(1 - t, 3),
};

// --- rig -----------------------------------------------------------------------
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
  const j = {};
  const root = new THREE.Group();
  j.root = root;

  j.torso = limb(0.55, 0.055, color);
  j.torso.children[0].position.y = 0.275;
  root.add(j.torso);

  const headPivot = new THREE.Group();
  headPivot.position.y = 0.6;
  const headMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 12, 10),
    new THREE.MeshToonMaterial({ color })
  );
  headMesh.position.y = 0.12;
  headMesh.castShadow = true;
  headPivot.add(headMesh);
  j.torso.add(headPivot);
  j.head = headPivot;

  for (const [side, sx] of [['L', -1], ['R', 1]]) {
    const sh = limb(0.3, 0.045, color);
    sh.position.set(sx * 0.2, 0.52, 0);
    j.torso.add(sh);
    const el = limb(0.3, 0.04, color);
    el.position.y = -0.28;
    sh.add(el);
    const hip = limb(0.45, 0.05, color);
    hip.position.set(sx * 0.11, 0, 0);
    root.add(hip);
    const knee = limb(0.45, 0.045, color);
    knee.position.y = -0.43;
    hip.add(knee);
    j['s' + side] = sh; j['e' + side] = el; j['h' + side] = hip; j['k' + side] = knee;
  }
  return { root, j };
}

// --- animator --------------------------------------------------------------------
function sampleCurve(points, t) { // [[at, val], ...] lineair
  if (!points) return 0;
  let a = points[0], b = points[points.length - 1];
  for (let i = 0; i < points.length - 1; i++) {
    if (t >= points[i][0] && t <= points[i + 1][0]) { a = points[i]; b = points[i + 1]; break; }
  }
  const f = (t - a[0]) / Math.max(1e-5, b[0] - a[0]);
  return a[1] + (b[1] - a[1]) * Math.min(1, Math.max(0, f));
}

function samplePose(clip, t) {
  const frames = clip.frames;
  let a = frames[0], b = frames[frames.length - 1];
  for (let i = 0; i < frames.length - 1; i++) {
    if (t >= frames[i].at && t <= frames[i + 1].at) { a = frames[i]; b = frames[i + 1]; break; }
  }
  const span = Math.max(1e-5, b.at - a.at);
  const f = (EASE[b.ease] ?? EASE.smooth)(Math.min(1, Math.max(0, (t - a.at) / span)));
  const pose = {};
  for (const name of JOINTS) {
    const pa = a.pose[name] ?? [0, 0, 0];
    const pb = b.pose[name] ?? [0, 0, 0];
    pose[name] = [0, 1, 2].map((i) => pa[i] + (pb[i] - pa[i]) * f);
  }
  return pose;
}

// doelpose per frame toepassen met per-joint lag (overlap/follow-through)
function driveJoints(j, target, dt) {
  for (const name of JOINTS) {
    const [rx, ry, rz] = target[name] ?? [0, 0, 0];
    const g = j[name];
    const k = Math.min(1, dt * JOINT_LAG[name]);
    g.rotation.x += (rx - g.rotation.x) * k;
    g.rotation.y += (ry - g.rotation.y) * k;
    g.rotation.z += (rz - g.rotation.z) * k;
  }
}

function shortestAngle(from, to) {
  return ((to - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

// --- vechter -----------------------------------------------------------------------
export class Fighter {
  constructor(engine, color, x, z, hp) {
    const { root, j } = buildStickman(color);
    this.engine = engine;
    this.root = root; this.j = j;
    this.hp = hp;
    this.heading = 0;
    this.walkPhase = 0;
    this.move = null;       // actieve move (uit MOVES)
    this.moveT = 0;         // genormaliseerde cliptijd
    this.prevRoot = 0;      // vorige root-motion sample
    this.hitDone = false;
    this.queued = null;     // gebufferde combo-move
    this.blocking = false;
    this.invuln = 0;
    this.hitstop = 0;       // bevriezing op impact
    this.downT = null;
    this.slump = null;      // losse eind-rotaties voor de knock-down
    const g = engine.groundHeight(x, z) ?? 0;
    root.position.set(x, g + 0.95, z);
    engine.scene.add(root);
  }

  get busy() { return this.move !== null || this.downT !== null; }

  start(name) {
    const m = MOVES[name];
    if (!m || this.downT !== null) return false;
    this.move = m; this.moveName = name;
    this.moveT = 0; this.prevRoot = 0; this.hitDone = false;
    return true;
  }

  attack(chain) { // chain 'A'|'B': start of buffer (royaal, zoals in echte games)
    if (this.downT !== null || this.blocking) return;
    if (!this.move) { this.start(chain === 'A' ? CHAIN_A : CHAIN_B); return; }
    const m = this.move;
    // input op elk moment vóór het einde van het cancel-venster bufferert de
    // volgende move in de keten — geen "gedropte" combo-inputs
    if (m.chainsTo && this.moveT <= (m.chainTo ?? 1)) {
      this.queued = m.chainsTo;
    }
  }

  dodge(dirVec) {
    if (this.busy || this.blocking) return;
    this.start('dodge');
    this.invuln = 0.3;
    this._dodgeDir = dirVec.clone().normalize();
  }

  update(dt, moveInput, running) {
    const e = this.engine;
    if (this.hitstop > 0) { // impact-freeze: alles staat stil, shake verkoopt de klap
      this.hitstop -= dt;
      this.j.torso.position.x = (Math.random() - 0.5) * 0.05;
      if (this.hitstop <= 0) this.j.torso.position.x = 0;
      return;
    }

    if (this.downT !== null) { // knock-down: kantelen + ledematen verslappen
      this.downT = Math.min(1, this.downT + dt * 2.0);
      const f = EASE.out(this.downT);
      this.root.rotation.z = (Math.PI / 2) * f * this._fallSide;
      this.root.position.y += ((this.groundY() + 0.22) - this.root.position.y) * 0.18;
      if (this.slump) {
        for (const name of JOINTS) {
          const g = this.j[name];
          g.rotation.x += (this.slump[name][0] - g.rotation.x) * dt * 4;
          g.rotation.z += (this.slump[name][2] - g.rotation.z) * dt * 4;
        }
      }
      return;
    }
    this.invuln = Math.max(0, this.invuln - dt);

    // dodge verplaatst zelf
    if (this.move === MOVES.dodge && this._dodgeDir) {
      const step = 5.2 * dt;
      const origin = this.root.position.clone(); origin.y += 0.4;
      if (!e.castWall(origin, this._dodgeDir, step + 0.4)) {
        this.root.position.addScaledVector(this._dodgeDir, step);
      }
    }

    let speed = 0;
    if (moveInput.lengthSq() > 0.001 && !this.move && !this.blocking) {
      speed = running ? RUN : WALK;
      const origin = this.root.position.clone(); origin.y += 0.2;
      if (!e.castWall(origin, moveInput, speed * dt + 0.45)) {
        this.root.position.addScaledVector(moveInput, speed * dt);
      }
      this.heading = Math.atan2(moveInput.x, moveInput.z);
    }

    const g = this.groundY();
    this.root.position.y += ((g + 0.95) - this.root.position.y) * Math.min(1, dt * 14);
    this.root.rotation.y += shortestAngle(this.root.rotation.y, this.heading) * Math.min(1, dt * 14);

    if (this.move) {
      const m = this.move;
      this.moveT += dt / m.dur;
      // root motion: gewicht/uitval in de slag, met muurcheck
      const rootNow = sampleCurve(m.root, Math.min(1, this.moveT));
      const delta = rootNow - this.prevRoot;
      this.prevRoot = rootNow;
      if (delta > 0) {
        const fwd = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
        const origin = this.root.position.clone(); origin.y += 0.4;
        if (!e.castWall(origin, fwd, delta + 0.4)) this.root.position.addScaledVector(fwd, delta);
      }
      if (m.spin) this.heading += m.spin * dt / m.dur; // tornado draait door

      if (this.moveT >= 1) {
        this.move = null;
        if (this.queued) { const q = this.queued; this.queued = null; this.start(q); }
      } else {
        driveJoints(this.j, samplePose(m, this.moveT), dt);
        return;
      }
    }

    if (this.blocking) { driveJoints(this.j, samplePose(MOVES.block, 0.5), dt); return; }

    // idle/loop-cycle met ademhaling
    this.walkPhase += dt * (speed > 0 ? speed * 2.3 : 0);
    const ph = this.walkPhase;
    const amp = speed > 0 ? (running ? 0.9 : 0.62) : 0;
    const breathe = Math.sin(performance.now() / 650) * 0.035;
    driveJoints(this.j, {
      hL: [Math.sin(ph) * amp, 0, 0],
      hR: [-Math.sin(ph) * amp, 0, 0],
      kL: [Math.max(0, -Math.sin(ph)) * amp * 1.5, 0, 0],
      kR: [Math.max(0, Math.sin(ph)) * amp * 1.5, 0, 0],
      sL: [-Math.sin(ph) * amp * 0.75 - 0.1, 0, 0.12 + breathe],
      sR: [Math.sin(ph) * amp * 0.75 - 0.1, 0, -0.12 - breathe],
      eL: [-0.4 - Math.max(0, Math.sin(ph)) * amp * 0.45, 0, 0],
      eR: [-0.4 - Math.max(0, -Math.sin(ph)) * amp * 0.45, 0, 0],
      torso: [speed > 0 ? 0.14 : 0.02 + breathe * 0.6, 0, 0],
      head: [breathe * 0.5, 0, 0],
    }, dt);
    if (speed > 0) this.root.position.y += Math.abs(Math.cos(ph)) * 0.035;
  }

  groundY() {
    return this.engine.groundHeight(this.root.position.x, this.root.position.z) ?? this.root.position.y - 0.95;
  }

  strikes(target) {
    const m = this.move;
    if (!m || this.hitDone || !m.reach) return false;
    if (this.moveT < m.hitFrom || this.moveT > m.hitTo) return false;
    if (target.invuln > 0 || target.downT !== null) return false;
    const d = this.root.position.distanceTo(target.root.position);
    if (d > m.reach) return false;
    const dir = target.root.position.clone().sub(this.root.position).setY(0).normalize();
    const facing = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    if (facing.dot(dir) < 0.25) return false;
    this.hitDone = true;
    return true;
  }

  takeHit(m, from) {
    if (this.blocking) { // blok: geen schade, kleine duw
      const push = this.root.position.clone().sub(from.root.position).setY(0).normalize();
      this.root.position.addScaledVector(push, 0.3);
      return 'blocked';
    }
    this.hp -= m.dmg;
    this.move = null; this.queued = null;
    const push = this.root.position.clone().sub(from.root.position).setY(0).normalize();
    this.root.position.addScaledVector(push, m.knockback ?? 0.5);
    if (this.hp <= 0) {
      this.downT = 0;
      this._fallSide = Math.random() < 0.5 ? 1 : -1;
      this.slump = {}; // losse "ragdoll-achtige" eindhouding
      for (const name of JOINTS) {
        this.slump[name] = [(Math.random() - 0.5) * 1.4, 0, (Math.random() - 0.5) * 1.0];
      }
      return 'down';
    }
    this.start(m.heavy ? 'hitHeavy' : 'hitLight');
    return 'hit';
  }

  dispose() {
    this.engine.scene.remove(this.root);
    this.root.traverse((n) => { if (n.isMesh) { n.geometry.dispose(); n.material.dispose(); } });
  }
}

// --- impact-spark ---------------------------------------------------------------
function spark(engine, pos) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.5),
    new THREE.MeshBasicMaterial({ color: 0xfff2c0, transparent: true, opacity: 0.95, depthWrite: false })
  );
  m.position.copy(pos);
  m.rotation.z = Math.random() * Math.PI;
  engine.scene.add(m);
  const t0 = performance.now();
  const grow = () => {
    const f = (performance.now() - t0) / 160;
    if (f >= 1) { engine.scene.remove(m); m.geometry.dispose(); m.material.dispose(); return; }
    m.scale.setScalar(1 + f * 2.2);
    m.material.opacity = 0.95 * (1 - f);
    m.lookAt(engine.camera.position);
    requestAnimationFrame(grow);
  };
  grow();
}

// --- missie-modus ------------------------------------------------------------------
export function createFightMode(engine) {
  const { state, camera, hud } = engine;
  let player, dummies = [], goal, goalPos, done = false;
  let prevA = false, prevB = false, prevDodge = false;
  let combo = 0, comboT = 0;
  let timeScale = 1, slowmoT = 0, camShake = 0, baseFov = camera.fov;

  function pickGoal() {
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
      ].sort((a, b) => Math.hypot(b[0] - p.x, b[1] - p.z) - Math.hypot(a[0] - p.x, a[1] - p.z));
      return new THREE.Vector3(corners[0][0], 0, corners[0][1]);
    }
    return new THREE.Vector3(p.x + 250, 0, p.z - 250);
  }

  return {
    enter() {
      const p = camera.position;
      player = new Fighter(engine, 0x20242c, p.x, p.z, PLAYER_HP);

      goalPos = pickGoal();
      goalPos.y = engine.groundHeight(goalPos.x, goalPos.z) ?? 0;
      goal = new THREE.Mesh(
        new THREE.CylinderGeometry(2.4, 2.4, 60, 16, 1, true),
        new THREE.MeshBasicMaterial({ color: 0x69d2ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false })
      );
      goal.position.set(goalPos.x, goalPos.y + 30, goalPos.z);
      engine.scene.add(goal);
      engine.setWaypoint?.(goalPos, '🥋');

      // statische trainingsdummies langs de route (AI komt later)
      const from = player.root.position;
      for (let i = 1; i <= 7; i++) {
        const f = i / 8;
        const x = from.x + (goalPos.x - from.x) * f + (Math.random() - 0.5) * 60;
        const z = from.z + (goalPos.z - from.z) * f + (Math.random() - 0.5) * 60;
        if ((engine.surfaceAt(x, z)?.cls ?? 'grass') === 'water') continue;
        dummies.push(new Fighter(engine, 0x8c2626, x, z, DUMMY_HP));
      }
      engine.showActions('👊', '🦵', '🛡️');
      hud('❤️'.repeat(PLAYER_HP), 'sla de dummies neer · haal het blauwe baken');
    },

    exit() {
      player?.dispose();
      for (const f of dummies) f.dispose();
      dummies = [];
      if (goal) { engine.scene.remove(goal); goal.geometry.dispose(); goal.material.dispose(); }
      engine.setWaypoint?.(null);
      camera.fov = baseFov; camera.updateProjectionMatrix();
      done = false; timeScale = 1;
    },

    tick(rawDt) {
      if (done) return;
      // bullet-time finisher: de wereld vertraagt, de HUD niet
      if (slowmoT > 0) {
        slowmoT -= rawDt;
        if (slowmoT <= 0) { timeScale = 1; camera.fov = baseFov; camera.updateProjectionMatrix(); }
      }
      const dt = rawDt * timeScale;

      const fwd = (state.keys.has('KeyW') ? 1 : 0) - (state.keys.has('KeyS') ? 1 : 0) - state.joystick.y;
      const strafe = (state.keys.has('KeyD') ? 1 : 0) - (state.keys.has('KeyA') ? 1 : 0) + state.joystick.x;
      const running = state.keys.has('ShiftLeft') || Math.hypot(state.joystick.x, state.joystick.y) > 0.85;
      const move = new THREE.Vector3(
        Math.sin(state.yaw) * -fwd + Math.cos(state.yaw) * strafe, 0,
        Math.cos(state.yaw) * -fwd - Math.sin(state.yaw) * strafe
      );
      if (move.lengthSq() > 1) move.normalize();

      // toetsen via de one-shot buffer (droppen nooit), knoppen edge-detected
      const a = state.actionA;
      const b = state.actionB;
      player.blocking = (state.actionC || state.keys.has('KeyL')) && !player.move;
      if (state.pressed.has('KeyJ') || (a && !prevA)) player.attack('A');
      if (state.pressed.has('KeyK') || (b && !prevB)) player.attack('B');
      if (state.pressed.has('Space')) {
        player.dodge(move.lengthSq() > 0.01 ? move : new THREE.Vector3(Math.cos(state.yaw), 0, -Math.sin(state.yaw)));
      }
      prevA = a; prevB = b;

      // auto-richten op de dichtstbijzijnde staande dummy tijdens een aanval
      if (player.move && player.move.reach) {
        const near = dummies.filter((f) => f.downT === null)
          .sort((x, y) => x.root.position.distanceTo(player.root.position) - y.root.position.distanceTo(player.root.position))[0];
        if (near && near.root.position.distanceTo(player.root.position) < 3.5 && !player.move.spin) {
          player.heading = Math.atan2(
            near.root.position.x - player.root.position.x,
            near.root.position.z - player.root.position.z);
        }
      }

      player.update(dt, move, running);
      combo = comboT > 0 ? combo : 0;
      comboT = Math.max(0, comboT - dt);

      for (const dummy of dummies) {
        dummy.update(dt, new THREE.Vector3(), false); // statisch: alleen ademen/vallen
        if (player.strikes(dummy)) {
          const m = player.move;
          const result = dummy.takeHit(m, player);
          const mid = dummy.root.position.clone().lerp(player.root.position, 0.4);
          mid.y += 1.2;
          spark(engine, mid);
          player.hitstop = m.hitstop; dummy.hitstop = m.hitstop;
          camShake = m.heavy ? 0.35 : 0.18;
          combo += 1; comboT = 2.0;

          const standing = dummies.filter((f) => f.downT === null).length;
          if (result === 'down' && standing === 0) {
            // laatste dummy: bullet-time + inzoomen
            timeScale = 0.18; slowmoT = 1.5;
            camera.fov = 44; camera.updateProjectionMatrix();
          }
        }
      }

      goal.rotation.y += dt * 0.6;
      const gd = player.root.position.distanceTo(new THREE.Vector3(goalPos.x, player.root.position.y, goalPos.z));
      if (gd < 6) {
        done = true;
        const downed = dummies.filter((f) => f.downT !== null).length;
        hud('🏆 missie volbracht!', `${downed}/${dummies.length} dummies neergeslagen — terug naar het menu…`);
        setTimeout(() => engine.showMenu(), 3200);
      } else {
        const comboTxt = combo > 1 ? ` · combo x${combo}` : '';
        hud('❤️'.repeat(PLAYER_HP), `🥋 baken: ${Math.round(gd)} m${comboTxt}`);
      }

      // derde-persoons camera + impact-shake
      camShake = Math.max(0, camShake - rawDt * 1.6);
      const pp = player.root.position;
      const dist = 4.6, pitch = Math.max(-0.9, Math.min(0.5, state.pitch));
      camera.position.set(
        pp.x + Math.sin(state.yaw) * Math.cos(pitch) * dist + (Math.random() - 0.5) * camShake,
        pp.y + 1.4 + Math.sin(-pitch) * dist * 0.8 + (Math.random() - 0.5) * camShake,
        pp.z + Math.cos(state.yaw) * Math.cos(pitch) * dist
      );
      camera.lookAt(pp.x, pp.y + 1.0, pp.z);
    },
  };
}
