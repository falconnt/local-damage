// Stickman-vechtmissie — active-ragdoll editie (Stick Fight-stijl).
// Het lichaam is een Verlet-skelet (ragdoll.js); keyframe-moves (moves.js)
// leveren de DOELpose en spierveren trekken het lijf erheen. Klappen zijn
// echte impulsen, een knock-out is spieren-uit. Hitstop, combo-buffering,
// blokkeren, ontwijken met i-frames en de bullet-time finisher blijven.

import * as THREE from 'three';
import { MOVES, CHAIN_A, CHAIN_B } from './moves.js';
import { Ragdoll, computeTargets, LIMBS, P } from './ragdoll.js';
import { impactBurst } from './fx.js';

const WALK = 3.4, RUN = 7.0;
const PLAYER_HP = 6, DUMMY_HP = 3;

const EASE = {
  smooth: (t) => t * t * (3 - 2 * t),
  in: (t) => t * t * t,
  out: (t) => 1 - Math.pow(1 - t, 3),
};

function samplePose(clip, t) {
  const frames = clip.frames;
  let a = frames[0], b = frames[frames.length - 1];
  for (let i = 0; i < frames.length - 1; i++) {
    if (t >= frames[i].at && t <= frames[i + 1].at) { a = frames[i]; b = frames[i + 1]; break; }
  }
  const span = Math.max(1e-5, b.at - a.at);
  const f = (EASE[b.ease] ?? EASE.smooth)(Math.min(1, Math.max(0, (t - a.at) / span)));
  const pose = {};
  const keys = new Set([...Object.keys(a.pose), ...Object.keys(b.pose)]);
  for (const name of keys) {
    const pa = a.pose[name] ?? [0, 0, 0];
    const pb = b.pose[name] ?? [0, 0, 0];
    pose[name] = [0, 1, 2].map((i) => pa[i] + (pb[i] - pa[i]) * f);
  }
  return pose;
}

function sampleCurve(points, t) {
  if (!points) return 0;
  let a = points[0], b = points[points.length - 1];
  for (let i = 0; i < points.length - 1; i++) {
    if (t >= points[i][0] && t <= points[i + 1][0]) { a = points[i]; b = points[i + 1]; break; }
  }
  const f = (t - a[0]) / Math.max(1e-5, b[0] - a[0]);
  return a[1] + (b[1] - a[1]) * Math.min(1, Math.max(0, f));
}

function shortestAngle(from, to) {
  return ((to - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

export class Fighter {
  constructor(engine, color, x, z, hp) {
    this.engine = engine;
    const g = engine.groundHeight(x, z) ?? 0;
    this.rig = new Ragdoll(engine.scene, color, x, z, g);
    this.ctrl = { x, z };          // besturingspositie (het lijf veert erachteraan)
    this.position = new THREE.Vector3(x, g + 0.95, z);
    this.hp = hp;
    this.heading = 0;
    this.walkPhase = 0;
    this.move = null; this.moveT = 0; this.prevRoot = 0;
    this.hitDone = false; this.queued = null;
    this.blocking = false;
    this.invuln = 0; this.stun = 0; this.hitstop = 0;
    this.downT = null;
    this.targets = new Float64Array(16 * 3);
  }

  get busy() { return this.move !== null || this.downT !== null; }

  start(name) {
    const m = MOVES[name];
    if (!m || this.downT !== null) return false;
    this.move = m; this.moveName = name;
    this.moveT = 0; this.prevRoot = 0; this.hitDone = false;
    if (m.reach) this.engine.sfx?.whoosh();
    if (name === 'dodge') this.engine.sfx?.dodge();
    return true;
  }

  attack(chain) {
    if (this.downT !== null || this.blocking || this.stun > 0) return;
    if (!this.move) { this.start(chain === 'A' ? CHAIN_A : CHAIN_B); return; }
    const m = this.move;
    if (m.chainsTo && this.moveT <= (m.chainTo ?? 1)) this.queued = m.chainsTo;
  }

  dodge(dirVec) {
    if (this.busy || this.blocking || this.stun > 0) return;
    this.start('dodge');
    this.invuln = 0.32;
    const d = dirVec.clone().normalize();
    this._dodgeDir = d;
    this.rig.impulseAll(d.x * 4.5, 1.2, d.z * 4.5);
  }

  update(dt, moveInput, running) {
    const e = this.engine;
    const groundY = e.groundHeight(this.ctrl.x, this.ctrl.z) ?? this.rig.groundY;

    if (this.hitstop > 0) { // impact-freeze: physics staat stil
      this.hitstop -= dt;
      return;
    }

    if (this.downT !== null) { // knock-out: pure ragdoll
      this.downT = Math.min(1, this.downT + dt);
      this.rig.muscleScale = Math.max(0, this.rig.muscleScale - dt * 8);
      this.rig.step(dt, null, groundY);
      this.position.copy(this.rig.point(P.pelvis));
      return;
    }

    this.invuln = Math.max(0, this.invuln - dt);
    this.stun = Math.max(0, this.stun - dt);

    // dodge-verplaatsing
    if (this.move === MOVES.dodge && this._dodgeDir) {
      const step = 4.6 * dt;
      const origin = this.position.clone(); origin.y = groundY + 0.5;
      if (!e.castWall(origin, this._dodgeDir, step + 0.4)) {
        this.ctrl.x += this._dodgeDir.x * step;
        this.ctrl.z += this._dodgeDir.z * step;
      }
    }

    let speed = 0;
    if (moveInput.lengthSq() > 0.001 && !this.move && !this.blocking && this.stun <= 0) {
      speed = running ? RUN : WALK;
      const origin = this.position.clone(); origin.y = groundY + 0.5;
      if (!e.castWall(origin, moveInput, speed * dt + 0.45)) {
        this.ctrl.x += moveInput.x * speed * dt;
        this.ctrl.z += moveInput.z * speed * dt;
      }
      const want = Math.atan2(moveInput.x, moveInput.z);
      this.heading += shortestAngle(this.heading, want) * Math.min(1, dt * 10);
    }
    // besturing mag nooit ver voor het lijf uitlopen, anders wordt de pop
    // als een marionet vooruitgesleept (armen/benen bungelen erachteraan)
    {
      const dx = this.ctrl.x - this.position.x, dz = this.ctrl.z - this.position.z;
      const lead = Math.hypot(dx, dz);
      if (lead > 0.28) {
        this.ctrl.x = this.position.x + (dx / lead) * 0.28;
        this.ctrl.z = this.position.z + (dz / lead) * 0.28;
      }
    }

    // pose bepalen: move-clip of loop/idle-cycle
    let pose, bob = 0;
    this.rig.setBoost(null, 1);
    const targetMuscle = this.stun > 0 ? 0.4 : 1;
    // zacht herstellen (o.a. na revive) zodat opstaan niet teleporteert
    this.rig.muscleScale = Math.min(targetMuscle, this.rig.muscleScale + dt * 2.5);

    if (this.move) {
      const m = this.move;
      this.moveT += dt / m.dur;
      const rootNow = sampleCurve(m.root, Math.min(1, this.moveT));
      const delta = rootNow - this.prevRoot;
      this.prevRoot = rootNow;
      if (delta > 0) {
        const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
        const origin = this.position.clone(); origin.y = groundY + 0.5;
        if (!e.castWall(origin, new THREE.Vector3(fx, 0, fz), delta + 0.4)) {
          this.ctrl.x += fx * delta; this.ctrl.z += fz * delta;
        }
      }
      if (m.spin) this.heading += m.spin * dt / m.dur;

      // combo cancelt direct het cancel-venster in (geen wachten op recovery)
      if (this.queued && this.moveT >= (m.chainFrom ?? 1)) {
        const q = this.queued; this.queued = null;
        this.start(q);
        pose = samplePose(this.move, 0);
      } else if (this.moveT >= 1) {
        this.move = null;
        pose = {};
      } else {
        pose = samplePose(m, this.moveT);
      }
      if (this.move?.limb) {
        this.rig.setBoost(LIMBS[this.move.limb], 3.4); // snap in de slag
        this.rig.boost[1] = 1.6; // borst whipt mee (P.chest)
      }
    }

    if (!pose) {
      if (this.blocking) {
        pose = samplePose(MOVES.block, 0.5);
        this.rig.setBoost([...LIMBS.armL, ...LIMBS.armR], 2.0);
      } else {
        this.walkPhase += dt * (speed > 0 ? speed * 2.3 : 0);
        const ph = this.walkPhase;
        const amp = speed > 0 ? (running ? 0.95 : 0.62) : 0;
        const breathe = Math.sin(performance.now() / 650) * 0.035;
        // rennen: gebogen, pompende armen (geen slungel-armen)
        const armPump = running && speed > 0 ? 1.15 : 0.75;
        const elbowBend = running && speed > 0 ? -1.5 : -0.4;
        pose = {
          hL: [Math.sin(ph) * amp, 0, 0],
          hR: [-Math.sin(ph) * amp, 0, 0],
          kL: [Math.max(0, -Math.sin(ph)) * amp * 1.5, 0, 0],
          kR: [Math.max(0, Math.sin(ph)) * amp * 1.5, 0, 0],
          sL: [-Math.sin(ph) * amp * armPump - 0.1, 0, 0.12 + breathe],
          sR: [Math.sin(ph) * amp * armPump - 0.1, 0, -0.12 - breathe],
          eL: [elbowBend - Math.max(0, Math.sin(ph)) * amp * 0.4, 0, 0],
          eR: [elbowBend - Math.max(0, -Math.sin(ph)) * amp * 0.4, 0, 0],
          torso: [speed > 0 ? (running ? 0.22 : 0.14) : 0.02 + breathe * 0.6, 0, 0],
          head: [breathe * 0.5, 0, 0],
        };
        bob = speed > 0 ? Math.abs(Math.cos(ph)) * 0.05 : 0;
        if (speed > 0) {
          // strakke ledematen tijdens het lopen: stappen en armzwaai volgen crisp
          this.rig.setBoost([...LIMBS.legL, ...LIMBS.legR], 1.6);
          for (const i of [...LIMBS.armL, ...LIMBS.armR]) this.rig.boost[i] = 1.3;
        }
      }
    }

    computeTargets(pose, this.heading, this.ctrl.x, this.ctrl.z, groundY, this.targets, bob);
    this.rig.step(dt, this.targets, groundY);
    this.position.copy(this.rig.point(P.pelvis));
    // controller volgt het lijf een beetje (geduwd worden werkt dan ook door)
    this.ctrl.x += (this.position.x - this.ctrl.x) * Math.min(1, dt * 3);
    this.ctrl.z += (this.position.z - this.ctrl.z) * Math.min(1, dt * 3);
  }

  strikePoint(out) {
    const m = this.move;
    if (!m?.limb) return null;
    const chain = LIMBS[m.limb];
    return this.rig.point(chain[chain.length - 1], out);
  }

  strikes(target) {
    const m = this.move;
    if (!m || this.hitDone || !m.reach) return false;
    if (this.moveT < m.hitFrom || this.moveT > m.hitTo) return false;
    if (target.invuln > 0 || target.downT !== null) return false;
    if (this.position.distanceTo(target.position) > m.reach + 0.4) return false;
    const sp = this.strikePoint(new THREE.Vector3());
    if (!sp) return false;
    // raak als de slaande hand/voet dicht bij romp of hoofd van het doel komt
    const chest = target.rig.point(P.chest, new THREE.Vector3());
    const head = target.rig.point(P.head, new THREE.Vector3());
    const d = Math.min(sp.distanceTo(chest), sp.distanceTo(head));
    if (d > 0.85) return false;
    this.hitDone = true;
    return true;
  }

  takeHit(m, from) {
    const push = this.position.clone().sub(from.position).setY(0).normalize();
    if (this.blocking) {
      this.rig.impulseAll(push.x * 1.5, 0.3, push.z * 1.5);
      return 'blocked';
    }
    this.hp -= m.dmg;
    this.move = null; this.queued = null;
    const kb = m.knockback ?? 0.5;
    if (this.hp <= 0) {
      this.downT = 0; // spieren uit: echte ragdoll-collapse met impuls mee
      this.rig.impulseAll(push.x * (2.5 + kb * 2.2), 1.6 + kb, push.z * (2.5 + kb * 2.2));
      this.rig.impulse(P.head, push.x * 4, 1.5, push.z * 4);
      return 'down';
    }
    this.stun = m.heavy ? 0.5 : 0.32;
    // hoofd klapt weg, lijf wankelt mee — physics doet de reactie-animatie
    this.rig.impulse(P.head, push.x * (3 + kb * 2), 0.8, push.z * (3 + kb * 2));
    this.rig.impulse(P.chest, push.x * (1.5 + kb), 0.3, push.z * (1.5 + kb));
    this.ctrl.x += push.x * kb * 0.5; this.ctrl.z += push.z * kb * 0.5;
    return 'hit';
  }

  revive() { // dojo: dummy krabbelt overeind (spieren komen terug)
    this.downT = null;
    this.hp = DUMMY_HP;
    this.stun = 0.4;
    this.rig.muscleScale = 0.01; // update-loop trekt hem naar 1
    const p = this.rig.point(P.pelvis, new THREE.Vector3());
    this.ctrl.x = p.x; this.ctrl.z = p.z;
  }

  dispose() { this.rig.dispose(); }
}

export const DUMMY_MAX_HP = DUMMY_HP;

// lijf-tegen-lijf: vechters duwen elkaar opzij i.p.v. door elkaar heen lopen
export function separate(a, b) {
  if (a.downT !== null || b.downT !== null) return;
  const dx = b.position.x - a.position.x;
  const dz = b.position.z - a.position.z;
  const d = Math.hypot(dx, dz);
  if (d > 0.68 || d < 1e-4) return;
  const push = (0.68 - d) / 2;
  const nx = dx / d, nz = dz / d;
  a.ctrl.x -= nx * push; a.ctrl.z -= nz * push;
  b.ctrl.x += nx * push; b.ctrl.z += nz * push;
  a.rig.impulse(P.chest, -nx * 0.6, 0, -nz * 0.6);
  b.rig.impulse(P.chest, nx * 0.6, 0, nz * 0.6);
}

// impact-effect + geluid bij een bevestigde treffer (gedeeld door modi)
export function onHit(engine, result, m, strikePos) {
  impactBurst(engine, strikePos, m.heavy);
  if (result === 'blocked') engine.sfx?.block();
  else engine.sfx?.hit(m.heavy);
  if (result === 'down') engine.sfx?.thud();
}

// --- missie-modus ------------------------------------------------------------------
export function createFightMode(engine) {
  const { state, camera, hud } = engine;
  let player, dummies = [], goal, goalPos, done = false;
  let prevA = false, prevB = false;
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

      const from = player.position;
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

      const a = state.actionA;
      const b = state.actionB;
      player.blocking = (state.actionC || state.keys.has('KeyL')) && !player.move;
      if (state.pressed.has('KeyJ') || (a && !prevA)) player.attack('A');
      if (state.pressed.has('KeyK') || (b && !prevB)) player.attack('B');
      if (state.pressed.has('Space')) {
        player.dodge(move.lengthSq() > 0.01 ? move : new THREE.Vector3(Math.cos(state.yaw), 0, -Math.sin(state.yaw)));
      }
      prevA = a; prevB = b;

      if (player.move && player.move.reach) {
        const near = dummies.filter((f) => f.downT === null)
          .sort((x, y) => x.position.distanceTo(player.position) - y.position.distanceTo(player.position))[0];
        if (near && near.position.distanceTo(player.position) < 3.5 && !player.move.spin) {
          player.heading = Math.atan2(
            near.position.x - player.position.x,
            near.position.z - player.position.z);
        }
      }

      player.update(dt, move, running);
      combo = comboT > 0 ? combo : 0;
      comboT = Math.max(0, comboT - dt);

      for (const dummy of dummies) {
        dummy.update(dt, new THREE.Vector3(), false);
        separate(player, dummy);
        if (player.strikes(dummy)) {
          const m = player.move;
          const result = dummy.takeHit(m, player);
          const sp = player.strikePoint(new THREE.Vector3()) ?? dummy.position.clone();
          onHit(engine, result, m, sp);
          player.hitstop = m.hitstop; dummy.hitstop = m.hitstop;
          camShake = m.heavy ? 0.35 : 0.18;
          combo += 1; comboT = 2.0;

          const standing = dummies.filter((f) => f.downT === null).length;
          if (result === 'down' && standing === 0) {
            timeScale = 0.18; slowmoT = 1.5;
            camera.fov = 44; camera.updateProjectionMatrix();
          }
        }
      }

      goal.rotation.y += dt * 0.6;
      const gd = player.position.distanceTo(new THREE.Vector3(goalPos.x, player.position.y, goalPos.z));
      if (gd < 6) {
        done = true;
        engine.sfx?.jingle(true);
        const downed = dummies.filter((f) => f.downT !== null).length;
        hud('🏆 missie volbracht!', `${downed}/${dummies.length} dummies neergeslagen — terug naar het menu…`);
        setTimeout(() => engine.showMenu(), 3200);
      } else {
        const comboTxt = combo > 1 ? ` · combo x${combo}` : '';
        hud('❤️'.repeat(PLAYER_HP), `🥋 baken: ${Math.round(gd)} m${comboTxt}`);
      }

      camShake = Math.max(0, camShake - rawDt * 1.6);
      const pp = player.position;
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
