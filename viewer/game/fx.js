// Visuele effecten — impact-burst: flits + uitdijende ring + deeltjes.
// Vervangt het oude "blokje" bij een raakmoment.

import * as THREE from 'three';

const COLORS = { light: 0xfff2c0, heavy: 0xffc37a };

export function impactBurst(engine, pos, heavy = false) {
  const { scene, camera } = engine;
  const group = new THREE.Group();
  group.position.copy(pos);
  scene.add(group);

  const color = heavy ? COLORS.heavy : COLORS.light;

  // 1) korte flits
  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.55, 0.55),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending })
  );
  flash.rotation.z = Math.random() * Math.PI;
  group.add(flash);

  // 2) uitdijende ring
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.5, 24),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
  );
  group.add(ring);

  // 3) deeltjes die uiteenspatten
  const n = heavy ? 14 : 9;
  const parts = [];
  const pgeo = new THREE.PlaneGeometry(0.09, 0.09);
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(
      pgeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    const a = Math.random() * Math.PI * 2;
    const el = (Math.random() - 0.25) * 1.2;
    const sp = (heavy ? 4.5 : 3.2) * (0.6 + Math.random() * 0.7);
    parts.push({
      m,
      v: new THREE.Vector3(Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp + 1.2, Math.sin(a) * Math.cos(el) * sp),
    });
    group.add(m);
  }

  const dur = heavy ? 0.42 : 0.32;
  const t0 = performance.now();
  let last = t0;
  const tick = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const f = (now - t0) / (dur * 1000);
    if (f >= 1) {
      scene.remove(group);
      flash.geometry.dispose(); flash.material.dispose();
      ring.geometry.dispose(); ring.material.dispose();
      pgeo.dispose();
      for (const p of parts) p.m.material.dispose();
      return;
    }
    flash.scale.setScalar(1 + f * 2.5);
    flash.material.opacity = Math.max(0, 1 - f * 4);
    flash.lookAt(camera.position);
    ring.scale.setScalar(0.3 + f * 2.6);
    ring.material.opacity = 0.9 * (1 - f);
    ring.lookAt(camera.position);
    for (const p of parts) {
      p.v.y -= 12 * dt;
      p.m.position.addScaledVector(p.v, dt);
      p.m.material.opacity = 1 - f;
      p.m.lookAt(camera.position);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
