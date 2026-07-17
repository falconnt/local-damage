"""Mesh-bouwstenen: triangle-soup per klasse, normalen en triangulatie.

Coordinaten in de pipeline zijn "lokaal RD": x = oost, y = noord, z = hoogte
(NAP), in meters, t.o.v. een lokale oorsprong (bbox-min). De conversie naar
glTF (Y-up) gebeurt pas in glb.py.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# Klassen die we semantisch onderscheiden; de client kleurt per klasse.
CLASSES = ("grass", "roof", "wall", "ground", "road", "water", "sand", "green", "tree", "trunk")


@dataclass
class TriangleSoup:
    """Losse driehoeken per klasse; wordt aan het eind gededupliceerd tot een mesh."""

    # per klasse: lijst van (3,3) float arrays (driehoek) + per-driehoek kleurfactor
    # (tint mag een scalar zijn, of een RGB-drietal voor kleurzweem per gebouw)
    triangles: dict[str, list[np.ndarray]] = field(default_factory=dict)
    tints: dict[str, list[np.ndarray]] = field(default_factory=dict)

    def add(self, cls: str, tri: np.ndarray, tint=1.0) -> None:
        self.triangles.setdefault(cls, []).append(np.asarray(tri, dtype=np.float64))
        t = np.asarray(tint, dtype=np.float32)
        if t.ndim == 0:
            t = np.full(3, float(t), dtype=np.float32)
        self.tints.setdefault(cls, []).append(t)

    def add_polygon(self, cls: str, ring: np.ndarray, tint=1.0) -> None:
        for tri in triangulate_polygon(ring):
            self.add(cls, tri, tint)


@dataclass
class Mesh:
    """Uiteindelijke render-mesh voor 1 klasse (flat- of smooth-shaded)."""

    name: str
    cls: str
    positions: np.ndarray  # (N,3) float32
    normals: np.ndarray  # (N,3) float32
    colors: np.ndarray  # (N,3) float32, per-vertex variatie (bijna wit)
    indices: np.ndarray  # (M,) uint32


def newell_normal(ring: np.ndarray) -> np.ndarray:
    """Robuuste polygon-normaal (Newell's methode)."""
    n = np.zeros(3)
    pts = np.asarray(ring, dtype=np.float64)
    for i in range(len(pts)):
        a = pts[i]
        b = pts[(i + 1) % len(pts)]
        n[0] += (a[1] - b[1]) * (a[2] + b[2])
        n[1] += (a[2] - b[2]) * (a[0] + b[0])
        n[2] += (a[0] - b[0]) * (a[1] + b[1])
    norm = np.linalg.norm(n)
    return n / norm if norm > 1e-12 else np.array([0.0, 0.0, 1.0])


def _project_2d(ring: np.ndarray, normal: np.ndarray) -> np.ndarray:
    """Projecteer een (bijna) vlakke 3D-ring op 2D voor ear clipping."""
    # kies twee assen loodrecht op de normaal
    a = np.array([1.0, 0.0, 0.0])
    if abs(normal[0]) > 0.9:
        a = np.array([0.0, 1.0, 0.0])
    u = np.cross(normal, a)
    u /= np.linalg.norm(u)
    v = np.cross(normal, u)
    return np.column_stack([ring @ u, ring @ v])


def triangulate_polygon(ring: np.ndarray) -> list[np.ndarray]:
    """Trianguleer een simpele (mogelijk concave) 3D-polygon.

    Ear clipping op de 2D-projectie; valt terug op fan-triangulatie als het
    clippen vastloopt (degenerate input). Gaten worden niet ondersteund (MVP).
    """
    ring = np.asarray(ring, dtype=np.float64)
    if len(ring) < 3:
        return []
    if len(ring) == 3:
        return [ring.copy()]

    normal = newell_normal(ring)
    pts2 = _project_2d(ring, normal)

    # zorg voor CCW-orientatie in 2D
    area2 = 0.0
    for i in range(len(pts2)):
        j = (i + 1) % len(pts2)
        area2 += pts2[i, 0] * pts2[j, 1] - pts2[j, 0] * pts2[i, 1]
    idx = list(range(len(ring)))
    if area2 < 0:
        idx.reverse()

    def cross_z(o, a, b):
        return (pts2[a, 0] - pts2[o, 0]) * (pts2[b, 1] - pts2[o, 1]) - (
            pts2[a, 1] - pts2[o, 1]
        ) * (pts2[b, 0] - pts2[o, 0])

    def point_in_tri(p, a, b, c):
        d1 = cross_z(a, b, p)
        d2 = cross_z(b, c, p)
        d3 = cross_z(c, a, p)
        has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
        has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
        return not (has_neg and has_pos)

    tris: list[np.ndarray] = []
    guard = 0
    while len(idx) > 3 and guard < 10000:
        guard += 1
        ear_found = False
        for k in range(len(idx)):
            prev_i = idx[(k - 1) % len(idx)]
            cur_i = idx[k]
            next_i = idx[(k + 1) % len(idx)]
            if cross_z(prev_i, cur_i, next_i) <= 1e-12:
                continue  # reflex of degenerate
            # geen ander punt binnen de kandidaat-ear?
            contains = False
            for other in idx:
                if other in (prev_i, cur_i, next_i):
                    continue
                if point_in_tri(other, prev_i, cur_i, next_i):
                    contains = True
                    break
            if not contains:
                tris.append(ring[[prev_i, cur_i, next_i]].copy())
                idx.pop(k)
                ear_found = True
                break
        if not ear_found:
            break  # degenerate -> fan fallback voor de rest

    if len(idx) == 3:
        tris.append(ring[idx].copy())
    elif len(idx) > 3:
        # fan-fallback op de resterende punten
        for k in range(1, len(idx) - 1):
            tris.append(ring[[idx[0], idx[k], idx[k + 1]]].copy())

    return [t for t in tris if _tri_area(t) > 1e-9]


def _tri_area(tri: np.ndarray) -> float:
    return 0.5 * np.linalg.norm(np.cross(tri[1] - tri[0], tri[2] - tri[0]))


def soup_to_flat_mesh(soup: TriangleSoup, cls: str, name: str | None = None) -> Mesh | None:
    """Zet losse driehoeken om in een flat-shaded mesh (per-face normalen).

    Vertices worden per driehoek gedupliceerd zodat elke face zijn eigen
    normaal houdt — de low-poly look uit het plan.
    """
    tris = soup.triangles.get(cls)
    if not tris:
        return None
    tints = soup.tints.get(cls, [1.0] * len(tris))

    positions = np.concatenate([t.reshape(3, 3) for t in tris]).astype(np.float32)
    normals = np.empty_like(positions)
    colors = np.empty_like(positions)
    for i, (tri, tint) in enumerate(zip(tris, tints)):
        n = np.cross(tri[1] - tri[0], tri[2] - tri[0])
        ln = np.linalg.norm(n)
        n = n / ln if ln > 1e-12 else np.array([0.0, 0.0, 1.0])
        normals[3 * i : 3 * i + 3] = n
        colors[3 * i : 3 * i + 3] = tint

    indices = np.arange(len(positions), dtype=np.uint32)
    return Mesh(name or f"class:{cls}", cls, positions, normals.astype(np.float32), colors, indices)
