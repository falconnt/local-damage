// Minimap + navigatie.
// Visualisatie: elke geladen tegel wordt één keer naar een 2D-plattegrondje
// gerasterd (250 px voor 500 m); de minimap stempelt die canvassen rond de
// speler (noord boven). Logica: de pipeline bakt per tegel een 4m-wegraster
// (*-nav.json); daarover loopt een A*-router zodat routes ook door nog niet
// gestreamde tegels kunnen lopen.

const TILE_M = 500;
const NAV_RES = 4;              // m per navigatiecel
const MAP_COLORS = {
  bg: '#9db77e', green: '#8fae6a', sand: '#d9c69a',
  water: '#8fc3d4', road: '#b6b6bc', roof: '#8a8a92',
};

export function createMinimap({ state, camera }) {
  const canvas = document.getElementById('minimap');
  const ctx = canvas.getContext('2d');
  const SIZE = 176;               // css-px; tekenbuffer 2x
  canvas.width = SIZE * 2;
  canvas.height = SIZE * 2;
  const SCALE = 2 * 0.62;         // bufferpx per meter (~142 m zichtstraal)

  const navGrids = new Map();     // "tx,ty" -> {rows, cols, bits}
  let navReady = false;
  let route = null;               // [{x, z}, ...] wereldcoordinaten
  let routeGoal = null;
  let lastRouteAt = 0;

  // --- nav-raster laden ------------------------------------------------------
  async function loadNav() {
    const { region, base, origin } = state.world ?? {};
    if (!region) return;
    await Promise.all(region.tiles.filter((t) => t.nav).map(async (t) => {
      try {
        const nav = await (await fetch(base + t.nav)).json();
        const bin = atob(nav.road);
        const bits = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bits[i] = bin.charCodeAt(i);
        const tx = Math.floor(t.origin_rd[0] / TILE_M);
        const ty = Math.floor(t.origin_rd[1] / TILE_M);
        navGrids.set(`${tx},${ty}`, { rows: nav.rows, cols: nav.cols, bits });
      } catch { /* tegel zonder nav */ }
    }));
    navReady = navGrids.size > 0;
  }

  // wereld (x, z) -> is dit een wegcel? (z = zuidwaarts, rd-noord = -z)
  function isRoad(x, z) {
    const [wox, woy] = worldOrigin();
    const ex = wox + x;
    const ny = woy - z;
    const tx = Math.floor(ex / TILE_M);
    const ty = Math.floor(ny / TILE_M);
    const g = navGrids.get(`${tx},${ty}`);
    if (!g) return false;
    const col = Math.floor((ex - tx * TILE_M) / NAV_RES);
    const row = Math.floor((ny - ty * TILE_M) / NAV_RES);
    if (row < 0 || col < 0 || row >= g.rows || col >= g.cols) return false;
    const bit = row * g.cols + col;
    return (g.bits[bit >> 3] >> (7 - (bit & 7)) & 1) === 1;
  }

  function worldOrigin() {
    return state.world?.origin ?? [0, 0];
  }

  function snapToRoad(x, z, maxR = 120) {
    for (let r = 0; r <= maxR; r += NAV_RES) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 10) {
        const sx = x + Math.cos(a) * r;
        const sz = z + Math.sin(a) * r;
        if (isRoad(sx, sz)) return [sx, sz];
      }
    }
    return null;
  }

  // --- A* over het wegraster -------------------------------------------------
  function findRoute(fromX, fromZ, toX, toZ) {
    if (!navReady) return null;
    const s = snapToRoad(fromX, fromZ);
    const g = snapToRoad(toX, toZ);
    if (!s || !g) return null;
    const cell = (x, z) => [Math.round(x / NAV_RES), Math.round(z / NAV_RES)];
    const [sx, sz] = cell(s[0], s[1]);
    const [gx, gz] = cell(g[0], g[1]);
    const key = (cx, cz) => (cx + 131072) * 262144 + (cz + 131072);

    const open = [[0, sx, sz]];  // simpele binaire heap
    const came = new Map();
    const cost = new Map([[key(sx, sz), 0]]);
    const H = (cx, cz) => {
      const dx = Math.abs(cx - gx), dz = Math.abs(cz - gz);
      return Math.max(dx, dz) + 0.41 * Math.min(dx, dz);
    };
    const push = (item) => {
      open.push(item);
      let i = open.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (open[p][0] <= open[i][0]) break;
        [open[p], open[i]] = [open[i], open[p]];
        i = p;
      }
    };
    const pop = () => {
      const top = open[0];
      const last = open.pop();
      if (open.length) {
        open[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < open.length && open[l][0] < open[m][0]) m = l;
          if (r < open.length && open[r][0] < open[m][0]) m = r;
          if (m === i) break;
          [open[m], open[i]] = [open[i], open[m]];
          i = m;
        }
      }
      return top;
    };

    let found = false;
    let guard = 0;
    let best = [sx, sz];
    let bestH = H(sx, sz);
    while (open.length && guard++ < 150000) {
      const [, cx, cz] = pop();
      if (cx === gx && cz === gz) { found = true; break; }
      const h = H(cx, cz);
      if (h < bestH) { bestH = h; best = [cx, cz]; } // dichtstbij bereikbare punt
      const cBase = cost.get(key(cx, cz));
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dz) continue;
          const nx = cx + dx, nz = cz + dz;
          if (!isRoad(nx * NAV_RES, nz * NAV_RES)) continue;
          const step = dx && dz ? 1.41 : 1;
          const nc = cBase + step;
          const k = key(nx, nz);
          if (nc < (cost.get(k) ?? Infinity)) {
            cost.set(k, nc);
            came.set(k, key(cx, cz));
            push([nc + H(nx, nz), nx, nz]);
          }
        }
      }
    }
    // doel onbereikbaar (bv. nav-data van een buurtegel ontbreekt): route naar
    // het dichtstbij komende bereikbare punt in plaats van helemaal niets
    const [ex2, ez2] = found ? [gx, gz] : best;
    if (!found && bestH >= H(sx, sz) - 2) return null; // geen zinvolle vooruitgang
    const pts = [];
    let k = key(ex2, ez2);
    const decode = (kk) => [Math.floor(kk / 262144) - 131072, (kk % 262144) - 131072];
    while (k !== undefined) {
      const [cx, cz] = decode(k);
      pts.push({ x: cx * NAV_RES, z: cz * NAV_RES });
      k = came.get(k);
    }
    pts.reverse();
    // collineaire punten overslaan: kortere polylijn
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
      if ((b.x - a.x) * (c.z - a.z) !== (b.z - a.z) * (c.x - a.x)) out.push(b);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  // --- plattegrond per tegel -------------------------------------------------
  const tileCanvases = new Map(); // rec -> canvas
  function rasterizeTile(rec) {
    if (tileCanvases.has(rec) || !rec.group) return;
    const c = document.createElement('canvas');
    c.width = 250; c.height = 250; // 2 m per px
    const g2 = c.getContext('2d');
    g2.fillStyle = MAP_COLORS.bg;
    g2.fillRect(0, 0, 250, 250);
    const ox = rec.group.position.x;
    const oz = rec.group.position.z;
    const order = ['green', 'sand', 'water', 'road', 'roof'];
    for (const cls of order) {
      const meshes = rec.meshes.filter((m) => m.userData.cls === cls);
      if (!meshes.length) continue;
      g2.fillStyle = MAP_COLORS[cls];
      for (const mesh of meshes) {
        // directe array-toegang + fill in batches: 60k driehoeken zonder freeze
        const arr = mesh.geometry.getAttribute('position').array;
        const iarr = mesh.geometry.getIndex()?.array ?? null;
        const triCount = ((iarr ? iarr.length : arr.length / 3) / 3) | 0;
        let inPath = 0;
        g2.beginPath();
        for (let t = 0; t < triCount; t++) {
          for (let k3 = 0; k3 < 3; k3++) {
            const vi = iarr ? iarr[t * 3 + k3] : t * 3 + k3;
            const px = arr[vi * 3] * 0.5;             // x oost -> px
            const py = (arr[vi * 3 + 2] + TILE_M) * 0.5; // tegel-z loopt 0..-500
            if (k3 === 0) g2.moveTo(px, py);
            else g2.lineTo(px, py);
          }
          g2.closePath();
          if (++inPath >= 2500) { g2.fill(); g2.beginPath(); inPath = 0; }
        }
        g2.fill();
      }
    }
    tileCanvases.set(rec, { canvas: c, ox, oz });
  }

  // --- tekenen ---------------------------------------------------------------
  function draw() {
    const px = camera.position.x;
    const pz = camera.position.z;
    const half = canvas.width / 2;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 4, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(24, 28, 44, 0.85)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const { canvas: tc, ox, oz } of tileCanvases.values()) {
      // tegelcanvas is 2 m/px; op de map: schaal SCALE m->px, dus factor 2*SCALE
      const dx = half + (ox - px) * SCALE;
      const dy = half + (oz - TILE_M - pz) * SCALE; // canvas-rij 0 = noordkant
      ctx.drawImage(tc, dx, dy, TILE_M * SCALE, TILE_M * SCALE);
    }

    if (route && route.length > 1) {
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < route.length; i++) {
        const rx = half + (route[i].x - px) * SCALE;
        const ry = half + (route[i].z - pz) * SCALE;
        if (i === 0) ctx.moveTo(rx, ry);
        else ctx.lineTo(rx, ry);
      }
      ctx.stroke();
    }

    // waypoint (missie/race/navigatie)
    if (state.waypoint) {
      const wx = half + (state.waypoint.x - px) * SCALE;
      const wy = half + (state.waypoint.z - pz) * SCALE;
      const r = half - 14;
      const d = Math.hypot(wx - half, wy - half);
      const cx = d > r ? half + (wx - half) * (r / d) : wx;
      const cy = d > r ? half + (wy - half) * (r / d) : wy;
      ctx.fillStyle = '#ffd166';
      ctx.beginPath();
      ctx.arc(cx, cy, 7, 0, Math.PI * 2);
      ctx.fill();
    }

    // speler: pijl in kijkrichting (noord boven)
    const fx = -Math.sin(state.yaw);
    const fz = -Math.cos(state.yaw);
    const ang = Math.atan2(fx, -fz);
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate(ang);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(8, 9);
    ctx.lineTo(0, 4);
    ctx.lineTo(-8, 9);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.restore();
    // rand
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(half, half, half - 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  let acc = 0;
  return {
    loadNav,
    tileLoaded(rec) { setTimeout(() => rasterizeTile(rec), 60); },
    tileUnloaded(rec) { tileCanvases.delete(rec); },
    navigateTo(x, z) {
      routeGoal = { x, z };
      route = findRoute(camera.position.x, camera.position.z, x, z);
      lastRouteAt = performance.now();
      return route !== null;
    },
    clearRoute() { route = null; routeGoal = null; },
    hasRoute: () => route !== null,
    routeGoal: () => routeGoal,
    navReady: () => navReady,
    update(dt) {
      if (canvas.style.display === 'none') return;
      acc += dt;
      if (acc < 0.12) return; // ~8 Hz is zat voor een minimap
      acc = 0;
      // route levend houden: elke ~4 s herberekenen vanaf de actuele positie
      if (routeGoal && performance.now() - lastRouteAt > 4000) {
        route = findRoute(camera.position.x, camera.position.z, routeGoal.x, routeGoal.z) ?? route;
        lastRouteAt = performance.now();
        if (Math.hypot(camera.position.x - routeGoal.x, camera.position.z - routeGoal.z) < 18) {
          this.clearRoute(); // bestemming bereikt
        }
      }
      draw();
    },
  };
}
