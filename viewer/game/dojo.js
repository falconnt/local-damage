// Dojo — trainingsmodus: een ring dummies rond de speler die na een
// knock-out weer opkrabbelen. Bedoeld om bewegen, rennen en het
// vechtsysteem te testen zonder missie-druk.

import * as THREE from 'three';
import { Fighter, spark, separate } from './stickman.js';
import { MOVES } from './moves.js';

const PLAYER_HP = 99;
const RING = 5.5;      // afstand dummies rond het startpunt
const REVIVE_AFTER = 2.6;

export function createDojoMode(engine) {
  const { state, camera, hud } = engine;
  let player, dummies = [], done = false;
  let prevA = false, prevB = false;
  let combo = 0, comboT = 0, knockdowns = 0;
  let timeScale = 1, slowmoT = 0, camShake = 0, baseFov = camera.fov;

  return {
    enter() {
      const p = camera.position;
      player = new Fighter(engine, 0x20242c, p.x, p.z, PLAYER_HP);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const x = p.x + Math.cos(a) * RING;
        const z = p.z + Math.sin(a) * RING;
        const d = new Fighter(engine, 0x8c2626, x, z, 3);
        d.heading = Math.atan2(p.x - x, p.z - z); // kijk naar het midden
        d.downSince = null;
        dummies.push(d);
      }
      engine.showActions('👊', '🦵', '🛡️');
      hud('🥷 dojo', 'J/👊 = stoot · K/🦵 = trap · L/🛡️ = blok · spatie = rol');
    },

    exit() {
      player?.dispose();
      for (const f of dummies) f.dispose();
      dummies = [];
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

      const now = performance.now();
      for (const dummy of dummies) {
        dummy.update(dt, new THREE.Vector3(), false);
        separate(player, dummy);
        if (dummy.downT !== null) {
          dummy.downSince ??= now;
          if (now - dummy.downSince > REVIVE_AFTER * 1000) {
            dummy.revive();
            dummy.downSince = null;
          }
        }
        if (player.strikes(dummy)) {
          const m = player.move;
          const result = dummy.takeHit(m, player);
          const sp = player.strikePoint(new THREE.Vector3()) ?? dummy.position.clone();
          spark(engine, sp);
          player.hitstop = m.hitstop; dummy.hitstop = m.hitstop;
          camShake = m.heavy ? 0.35 : 0.18;
          combo += 1; comboT = 2.0;
          if (result === 'down') {
            knockdowns += 1;
            if (m.dmg >= 3) { // zware finisher: korte bullet-time als beloning
              timeScale = 0.25; slowmoT = 0.9;
              camera.fov = 46; camera.updateProjectionMatrix();
            }
          }
        }
      }

      const comboTxt = combo > 1 ? ` · combo x${combo}` : '';
      hud('🥷 dojo', `${knockdowns} knock-downs${comboTxt}`);

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
