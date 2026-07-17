// Auto's voor de racemodus — vier iconische silhouetten, elk als lowpoly-model
// opgebouwd uit een geëxtrudeerd zijprofiel (art of rally-stijl) met eigen
// rijgedrag. Het profiel wordt ook gebruikt voor de SVG-preview in het menu.

import * as THREE from 'three';

export const CARS = [
  {
    id: 'classic',
    name: 'Bosje 600',
    desc: 'rally-klassieker: wendbaar en verrassend vlot op gras',
    color: 0xc23b2e, accent: 0xf2ede2,
    physics: { accel: 9, vmaxRoad: 26, vmaxOff: 16, steer: 3.2, revMax: 6 },
    // zijprofiel: x = lengte (neus = +), y = hoogte
    pts: [[1.55, 0.30], [1.55, 0.72], [1.05, 0.80], [0.62, 0.84], [0.45, 1.38], [-0.60, 1.42], [-1.15, 0.95], [-1.50, 0.88], [-1.55, 0.45], [-1.55, 0.30]],
    width: 1.55,
    wheels: [{ x: 0.74, z: 1.05, r: 0.30 }, { x: 0.74, z: -1.05, r: 0.30 }],
    detail(g, mat) {
      // wit dak + glasband + twee ronde rallylampen op de neus
      g.add(box(mat(this.accent), 1.45, 0.07, 1.05, 0, 1.45, -0.10));
      g.add(box(GLASS(), this.width + 0.14, 0.42, 1.00, 0, 1.06, -0.08));
      for (const x of [-0.28, 0.28]) {
        const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.1, 10), LIGHT());
        lamp.rotation.x = Math.PI / 2;
        lamp.position.set(x, 0.72, 1.58);
        g.add(lamp);
      }
      g.add(taillights(-1.58, 0.62, 0.48));
    },
  },
  {
    id: 'wedge',
    name: 'Strato GT',
    desc: 'lage wig, brute topsnelheid — maar gras is zijn vijand',
    color: 0xe8b21f, accent: 0x22242c,
    physics: { accel: 13, vmaxRoad: 42, vmaxOff: 9, steer: 2.3, revMax: 5 },
    pts: [[2.10, 0.16], [2.10, 0.50], [0.55, 0.72], [-0.15, 1.02], [-1.15, 1.04], [-1.75, 0.86], [-2.10, 0.82], [-2.10, 0.20]],
    width: 1.95,
    wheels: [{ x: 0.96, z: 1.35, r: 0.31 }, { x: 0.96, z: -1.35, r: 0.31 }],
    detail(g, mat) {
      // schuine voorruit + brede achtervleugel op steunen
      const glass = box(GLASS(), this.width + 0.14, 0.30, 0.85, 0, 0.87, -0.30);
      glass.rotation.x = -0.18;
      g.add(glass);
      g.add(box(mat(this.accent), 1.75, 0.06, 0.38, 0, 1.12, -1.90));
      for (const x of [-0.62, 0.62]) g.add(box(mat(this.accent), 0.08, 0.26, 0.10, x, 0.95, -1.92));
      g.add(headlights(2.12, 0.42, 0.65));
      g.add(taillights(-2.12, 0.62, 0.7));
    },
  },
  {
    id: 'muscle',
    name: 'Vento V8',
    desc: 'lange neus, dikke V8 — snel rechtdoor, lui in de bocht',
    color: 0x24356b, accent: 0xf2ede2,
    physics: { accel: 12, vmaxRoad: 36, vmaxOff: 12, steer: 1.9, revMax: 6 },
    pts: [[2.30, 0.30], [2.30, 0.78], [1.90, 0.84], [0.55, 0.88], [0.20, 1.28], [-0.75, 1.30], [-1.90, 0.92], [-2.30, 0.88], [-2.30, 0.34]],
    width: 1.90,
    wheels: [{ x: 0.93, z: 1.50, r: 0.33 }, { x: 0.93, z: -1.50, r: 0.33 }],
    detail(g, mat) {
      // dubbele witte racestrepen over de motorkap + glasband
      for (const x of [-0.24, 0.24]) g.add(box(mat(this.accent), 0.17, 0.02, 1.55, x, 0.90, 1.45));
      g.add(box(GLASS(), this.width + 0.14, 0.36, 0.95, 0, 1.05, -0.25));
      g.add(headlights(2.32, 0.60, 0.72));
      g.add(taillights(-2.32, 0.66, 0.75));
    },
  },
  {
    id: 'van',
    name: 'Kombi',
    desc: 'het busje: traag maar taai — houdt zijn tempo overal vast',
    color: 0xf2ead8, accent: 0x2e6f8e,
    physics: { accel: 6.5, vmaxRoad: 21, vmaxOff: 14, steer: 2.4, revMax: 5 },
    pts: [[1.95, 0.30], [1.95, 1.35], [1.75, 1.90], [-1.80, 1.95], [-1.95, 1.85], [-1.95, 0.30]],
    width: 1.80,
    wheels: [{ x: 0.88, z: 1.28, r: 0.32 }, { x: 0.88, z: -1.28, r: 0.32 }],
    detail(g, mat) {
      // two-tone onderkant + grote voorruit + zijruitband
      g.add(box(mat(this.accent), this.width + 0.14, 0.62, 3.65, 0, 0.62, 0));
      const front = box(GLASS(), 1.5, 0.55, 0.07, 0, 1.58, 1.90);
      front.rotation.x = -0.1;
      g.add(front);
      g.add(box(GLASS(), this.width + 0.14, 0.48, 2.4, 0, 1.55, -0.45));
      g.add(headlights(1.97, 0.75, 0.55));
      g.add(taillights(-1.97, 0.85, 0.6));
    },
  },
];

const GLASS = () => new THREE.MeshToonMaterial({ color: 0x1a2028 });
const LIGHT = () => new THREE.MeshBasicMaterial({ color: 0xfff3c4 });
const RLIGHT = () => new THREE.MeshBasicMaterial({ color: 0xd8402a });

function box(material, w, h, d, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

function headlights(z, y, x) {
  const g = new THREE.Group();
  for (const s of [-1, 1]) g.add(box(LIGHT(), 0.22, 0.12, 0.08, s * x, y, z));
  return g;
}

function taillights(z, y, x) {
  const g = new THREE.Group();
  for (const s of [-1, 1]) g.add(box(RLIGHT(), 0.24, 0.10, 0.08, s * x, y, z));
  return g;
}

// zijprofiel → 3D-romp: extrude over de breedte met een kleine facetrand
function bodyMesh(spec, material) {
  const shape = new THREE.Shape();
  shape.moveTo(spec.pts[0][0], spec.pts[0][1]);
  for (let i = 1; i < spec.pts.length; i++) shape.lineTo(spec.pts[i][0], spec.pts[i][1]);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: spec.width, steps: 1,
    bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 1,
  });
  geo.translate(0, 0, -spec.width / 2);
  geo.rotateY(-Math.PI / 2); // profiel-x (lengte) → wereld +z
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  return mesh;
}

export function buildCarModel(spec) {
  const group = new THREE.Group();
  const mat = (c) => new THREE.MeshToonMaterial({ color: c });
  group.add(bodyMesh(spec, mat(spec.color)));
  spec.detail?.(group, mat);

  const tireMat = new THREE.MeshToonMaterial({ color: 0x22242c });
  const hubMat = new THREE.MeshToonMaterial({ color: 0x9aa0aa });
  const wheels = [];
  for (const w of spec.wheels) {
    for (const side of [-1, 1]) {
      const wheel = new THREE.Group();
      const tireGeo = new THREE.CylinderGeometry(w.r, w.r, 0.26, 12);
      const hubGeo = new THREE.CylinderGeometry(w.r * 0.5, w.r * 0.5, 0.28, 8);
      tireGeo.rotateZ(Math.PI / 2); // as van het wiel = x-as, zodat rotation.x = rollen
      hubGeo.rotateZ(Math.PI / 2);
      const tire = new THREE.Mesh(tireGeo, tireMat);
      tire.castShadow = true;
      wheel.add(tire, new THREE.Mesh(hubGeo, hubMat));
      const pivot = new THREE.Group();
      pivot.position.set(side * w.x, w.r, w.z);
      pivot.add(wheel);
      group.add(pivot);
      wheels.push({ pivot, mesh: wheel, front: w.z > 0, r: w.r });
    }
  }
  return { group, wheels };
}

// zijaanzicht als mini-SVG voor het keuzemenu
export function carSvg(spec) {
  const col = `#${spec.color.toString(16).padStart(6, '0')}`;
  const pts = spec.pts.map(([x, y]) => `${x.toFixed(2)},${(-y).toFixed(2)}`).join(' ');
  const wheels = spec.wheels.map((w) =>
    `<circle cx="${w.z}" cy="${-w.r}" r="${w.r}" fill="#181a20"/>` +
    `<circle cx="${w.z}" cy="${-w.r}" r="${(w.r * 0.45).toFixed(2)}" fill="#9aa0aa"/>`
  ).join('');
  return `<svg viewBox="-2.6 -2.25 5.2 2.35" preserveAspectRatio="xMidYMax meet">` +
    `<polygon points="${pts}" fill="${col}"/>${wheels}</svg>`;
}
