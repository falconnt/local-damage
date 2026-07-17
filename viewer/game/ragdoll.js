// Active-ragdoll stickman — de techniek achter Stick Fight/Stick It To The
// Stickman, vertaald naar de browser: het lichaam is een Verlet-partikelskelet
// (punten + afstandsconstraints, dus ledematen zitten ECHT aan elkaar) en
// "spieren" trekken elk punt naar de animatiedoelpose. Balans-, stand- en
// stapkrachten houden hem overeind (het Landfall-recept). Momentum, naijlen
// en wiebel komen vanzelf uit de physics; een klap is een echte impuls en
// een knock-out is spieren-uit = echte ragdoll.

import * as THREE from 'three';

const GRAV = -24;
const SUBSTEP = 1 / 120;
const ITERS = 4;

// skeletpunten
export const P = {
  pelvis: 0, chest: 1, neck: 2, head: 3,
  shL: 4, shR: 5, elL: 6, elR: 7, haL: 8, haR: 9,
  hiL: 10, hiR: 11, knL: 12, knR: 13, ftL: 14, ftR: 15,
};
const NUM = 16;

// afstandsconstraints [a, b, lengte]
const CONSTRAINTS = [
  [P.pelvis, P.chest, 0.35], [P.chest, P.neck, 0.2], [P.neck, P.head, 0.18],
  [P.pelvis, P.neck, 0.53], // ruggengraat-stabilisator
  [P.neck, P.shL, 0.21], [P.neck, P.shR, 0.21],
  [P.chest, P.shL, 0.26], [P.chest, P.shR, 0.26],
  [P.shL, P.shR, 0.38],
  [P.shL, P.elL, 0.3], [P.elL, P.haL, 0.3],
  [P.shR, P.elR, 0.3], [P.elR, P.haR, 0.3],
  [P.pelvis, P.hiL, 0.12], [P.pelvis, P.hiR, 0.12],
  [P.chest, P.hiL, 0.44], [P.chest, P.hiR, 0.44],
  [P.hiL, P.hiR, 0.22],
  [P.hiL, P.knL, 0.45], [P.knL, P.ftL, 0.45],
  [P.hiR, P.knR, 0.45], [P.knR, P.ftR, 0.45],
];

// "spierkracht" per punt: hoe hard het naar zijn doelpositie wordt getrokken.
// Voeten/bekken sterk (balans), handen/hoofd los (wiebel + follow-through).
// strak genoeg om de pose geloofwaardig te houden (Stick Fight-poppen staan
// stevig); de wiebel komt van impacts, rennen (losse armen) en reacties
const MUSCLE = new Float32Array(NUM);
MUSCLE[P.pelvis] = 320; MUSCLE[P.chest] = 300; MUSCLE[P.neck] = 240; MUSCLE[P.head] = 170;
MUSCLE[P.shL] = MUSCLE[P.shR] = 240;
MUSCLE[P.elL] = MUSCLE[P.elR] = 150;
MUSCLE[P.haL] = MUSCLE[P.haR] = 120;
MUSCLE[P.hiL] = MUSCLE[P.hiR] = 260;
MUSCLE[P.knL] = MUSCLE[P.knR] = 200;
MUSCLE[P.ftL] = MUSCLE[P.ftR] = 340;

// ledemaat-groepen voor strike-versterking (snap in de slag)
export const LIMBS = {
  armL: [P.shL, P.elL, P.haL], armR: [P.shR, P.elR, P.haR],
  legL: [P.hiL, P.knL, P.ftL], legR: [P.hiR, P.knR, P.ftR],
};
const ARMS = [...LIMBS.armL, ...LIMBS.armR];

// weergave-botten: [a, b, straal]
const BONES = [
  [P.pelvis, P.chest, 0.055], [P.chest, P.neck, 0.05],
  [P.shL, P.elL, 0.045], [P.elL, P.haL, 0.04],
  [P.shR, P.elR, 0.045], [P.elR, P.haR, 0.04],
  [P.hiL, P.knL, 0.05], [P.knL, P.ftL, 0.045],
  [P.hiR, P.knR, 0.05], [P.knR, P.ftR, 0.045],
  [P.shL, P.shR, 0.04],
];

const UP = new THREE.Vector3(0, 1, 0);

export class Ragdoll {
  constructor(scene, color, x, z, groundY) {
    this.scene = scene;
    this.pos = new Float64Array(NUM * 3);
    this.prev = new Float64Array(NUM * 3);
    this.boost = new Float32Array(NUM).fill(1); // tijdelijke spier-multipliers
    this.muscleScale = 1;                        // globaal (0 = ragdoll)
    this.groundY = groundY;
    this.accum = 0;

    // startpose: rechtop
    const init = (i, px, py, pz) => {
      this.pos[i * 3] = x + px; this.pos[i * 3 + 1] = groundY + py; this.pos[i * 3 + 2] = z + pz;
      this.prev[i * 3] = this.pos[i * 3]; this.prev[i * 3 + 1] = this.pos[i * 3 + 1]; this.prev[i * 3 + 2] = this.pos[i * 3 + 2];
    };
    init(P.pelvis, 0, 0.95, 0); init(P.chest, 0, 1.3, 0); init(P.neck, 0, 1.5, 0); init(P.head, 0, 1.68, 0);
    init(P.shL, -0.19, 1.47, 0); init(P.shR, 0.19, 1.47, 0);
    init(P.elL, -0.22, 1.17, 0); init(P.elR, 0.22, 1.17, 0);
    init(P.haL, -0.24, 0.87, 0); init(P.haR, 0.24, 0.87, 0);
    init(P.hiL, -0.11, 0.93, 0); init(P.hiR, 0.11, 0.93, 0);
    init(P.knL, -0.12, 0.5, 0); init(P.knR, 0.12, 0.5, 0);
    init(P.ftL, -0.13, 0.05, 0); init(P.ftR, 0.13, 0.05, 0);

    // meshes
    this.group = new THREE.Group();
    const mat = new THREE.MeshToonMaterial({ color });
    this.bones = BONES.map(([a, b, r]) => {
      const len = Math.max(0.1, CONSTRAINTS.find((c) => (c[0] === a && c[1] === b) || (c[0] === b && c[1] === a))?.[2] ?? 0.3);
      const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 3, 8), mat);
      mesh.castShadow = true;
      this.group.add(mesh);
      return { a, b, mesh };
    });
    this.headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), mat);
    this.headMesh.castShadow = true;
    this.group.add(this.headMesh);
    scene.add(this.group);
    this._v = new THREE.Vector3(); this._w = new THREE.Vector3();
    this._render(); // meteen op z'n plek, ook vóór de eerste physics-stap
  }

  point(i, out = new THREE.Vector3()) {
    return out.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
  }

  // directe impuls (m/s) op een punt: klappen, knockback
  impulse(i, vx, vy, vz) {
    this.prev[i * 3] -= vx * SUBSTEP * 4;
    this.prev[i * 3 + 1] -= vy * SUBSTEP * 4;
    this.prev[i * 3 + 2] -= vz * SUBSTEP * 4;
  }

  impulseAll(vx, vy, vz, scale = 1) {
    for (let i = 0; i < NUM; i++) this.impulse(i, vx * scale, vy * scale, vz * scale);
  }

  // verplaats het hele lijf (spawn/teleport)
  translate(dx, dy, dz) {
    for (let i = 0; i < NUM; i++) {
      this.pos[i * 3] += dx; this.pos[i * 3 + 1] += dy; this.pos[i * 3 + 2] += dz;
      this.prev[i * 3] += dx; this.prev[i * 3 + 1] += dy; this.prev[i * 3 + 2] += dz;
    }
  }

  // physics-stap: targets = Float64Array(NUM*3) doelposities of null (pure ragdoll)
  step(dt, targets, groundY) {
    this.groundY = groundY;
    this.accum = Math.min(this.accum + dt, SUBSTEP * 4);
    while (this.accum >= SUBSTEP) {
      this.accum -= SUBSTEP;
      this._substep(targets);
    }
    this._render();
  }

  _substep(targets) {
    const h2 = SUBSTEP * SUBSTEP;
    for (let i = 0; i < NUM; i++) {
      const ix = i * 3, iy = ix + 1, iz = ix + 2;
      let ax = 0, ay = GRAV, az = 0;
      if (targets && this.muscleScale > 0.001) {
        const k = MUSCLE[i] * this.muscleScale * this.boost[i];
        ax += (targets[ix] - this.pos[ix]) * k;
        ay += (targets[iy] - this.pos[iy]) * k;
        az += (targets[iz] - this.pos[iz]) * k;
        // "standing handler": spieren dragen het eigen gewicht, zodat de
        // veren puur de pose volgen i.p.v. tegen de zwaartekracht te vechten
        ay += -GRAV * Math.min(1, this.muscleScale);
      }
      // verlet-integratie met demping (kritisch-achtig gedempt bij aandrijving)
      const damp = targets && this.muscleScale > 0.5 ? 0.965 : 0.985;
      let nx = this.pos[ix] + (this.pos[ix] - this.prev[ix]) * damp + ax * h2;
      let ny = this.pos[iy] + (this.pos[iy] - this.prev[iy]) * damp + ay * h2;
      let nz = this.pos[iz] + (this.pos[iz] - this.prev[iz]) * damp + az * h2;
      this.prev[ix] = this.pos[ix]; this.prev[iy] = this.pos[iy]; this.prev[iz] = this.pos[iz];
      this.pos[ix] = nx; this.pos[iy] = ny; this.pos[iz] = nz;
    }
    // constraints: het lijf blijft aan elkaar
    for (let it = 0; it < ITERS; it++) {
      for (const [a, b, len] of CONSTRAINTS) {
        const ax = a * 3, bx = b * 3;
        let dx = this.pos[bx] - this.pos[ax];
        let dy = this.pos[bx + 1] - this.pos[ax + 1];
        let dz = this.pos[bx + 2] - this.pos[ax + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const corr = (d - len) / d * 0.5;
        dx *= corr; dy *= corr; dz *= corr;
        this.pos[ax] += dx; this.pos[ax + 1] += dy; this.pos[ax + 2] += dz;
        this.pos[bx] -= dx; this.pos[bx + 1] -= dy; this.pos[bx + 2] -= dz;
      }
      // grond: niet doorheen, met wrijving
      for (let i = 0; i < NUM; i++) {
        const iy = i * 3 + 1;
        const floor = this.groundY + 0.05;
        if (this.pos[iy] < floor) {
          this.pos[iy] = floor;
          const ix = i * 3, iz = ix + 2;
          this.prev[ix] = this.pos[ix] + (this.prev[ix] - this.pos[ix]) * 0.4;
          this.prev[iz] = this.pos[iz] + (this.prev[iz] - this.pos[iz]) * 0.4;
        }
      }
    }
  }

  _render() {
    for (const bone of this.bones) {
      const a = this.point(bone.a, this._v);
      const b = this.point(bone.b, this._w);
      bone.mesh.position.copy(a).add(b).multiplyScalar(0.5);
      const dir = this._w.sub(a);
      const len = dir.length();
      if (len > 1e-5) bone.mesh.quaternion.setFromUnitVectors(UP, dir.divideScalar(len));
    }
    this.point(P.head, this.headMesh.position);
  }

  setBoost(indices, value) {
    this.boost.fill(1);
    if (indices) for (const i of indices) this.boost[i] = value;
  }

  relaxArms(value = 0.35) { // losse armen (bv. tijdens rennen): meer zwaai
    for (const i of ARMS) this.boost[i] = value;
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((n) => { if (n.isMesh) n.geometry.dispose(); });
    this.bones[0]?.mesh.material.dispose();
  }
}

// --- doelpose-berekening (virtueel FK-skelet uit de keyframe-pose) --------------
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();
const _root = new THREE.Quaternion(), _t = new THREE.Vector3(), _s = new THREE.Vector3();

export function computeTargets(pose, heading, cx, cz, groundY, out, bob = 0) {
  const set = (i, v) => { out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z; };
  _root.setFromAxisAngle(UP, heading);

  const pelvis = _t.set(cx, groundY + 0.95 + bob, cz).clone();
  set(P.pelvis, pelvis);

  // romp
  const tp = pose.torso ?? [0, 0, 0];
  _e.set(tp[0], tp[1], tp[2], 'YXZ');
  const qTorso = _q.copy(_root).multiply(_q2.setFromEuler(_e));
  const torsoUp = _s.set(0, 1, 0).applyQuaternion(qTorso).clone();
  const side = new THREE.Vector3(1, 0, 0).applyQuaternion(qTorso);
  const chest = pelvis.clone().addScaledVector(torsoUp, 0.35); set(P.chest, chest);
  const neck = pelvis.clone().addScaledVector(torsoUp, 0.55); set(P.neck, neck);
  const hp = pose.head ?? [0, 0, 0];
  const headDir = _s.set(hp[1] * 0.3, 1, -hp[0] * 0.3).normalize().applyQuaternion(qTorso).clone();
  set(P.head, neck.clone().addScaledVector(headDir, 0.18));

  // armen: schouder -> elleboog -> hand
  for (const [S, E, H, sKey, eKey, sgn] of [
    [P.shL, P.elL, P.haL, 'sL', 'eL', -1],
    [P.shR, P.elR, P.haR, 'sR', 'eR', 1],
  ]) {
    const sh = neck.clone().addScaledVector(side, sgn * 0.2).addScaledVector(torsoUp, -0.04);
    set(S, sh);
    const sp = pose[sKey] ?? [0, 0, 0];
    _e.set(sp[0], sp[1], sp[2], 'XYZ');
    const qArm = _q2.setFromEuler(_e).premultiply(qTorso);
    const upperDir = _s.set(0, -1, 0).applyQuaternion(qArm).clone();
    const el = sh.clone().addScaledVector(upperDir, 0.3); set(E, el);
    const ep = pose[eKey] ?? [0, 0, 0];
    _e.set(ep[0], 0, 0, 'XYZ');
    const qFore = _q2.setFromEuler(_e).premultiply(qArm);
    set(H, el.clone().addScaledVector(_s.set(0, -1, 0).applyQuaternion(qFore), 0.3));
  }

  // benen: heup -> knie -> voet (aan het bekken, root-orientatie)
  const sideRoot = new THREE.Vector3(1, 0, 0).applyQuaternion(_root);
  for (const [HI, K, F, hKey, kKey, sgn] of [
    [P.hiL, P.knL, P.ftL, 'hL', 'kL', -1],
    [P.hiR, P.knR, P.ftR, 'hR', 'kR', 1],
  ]) {
    const hi = pelvis.clone().addScaledVector(sideRoot, sgn * 0.11).addScaledVector(UP, -0.02);
    set(HI, hi);
    const hpp = pose[hKey] ?? [0, 0, 0];
    _e.set(hpp[0], hpp[1], hpp[2], 'XYZ');
    const qThigh = _q2.setFromEuler(_e).premultiply(_root);
    const thighDir = _s.set(0, -1, 0).applyQuaternion(qThigh).clone();
    const kn = hi.clone().addScaledVector(thighDir, 0.45); set(K, kn);
    const kp = pose[kKey] ?? [0, 0, 0];
    _e.set(kp[0], 0, 0, 'XYZ');
    const qShin = _q2.setFromEuler(_e).premultiply(qThigh);
    set(F, kn.clone().addScaledVector(_s.set(0, -1, 0).applyQuaternion(qShin), 0.45));
  }
  return out;
}
