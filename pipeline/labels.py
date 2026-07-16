"""Bordjes-plaatsing: BAG-adressen -> posities op de dichtstbijzijnde gevel.

Output is een addresses-JSON naast de GLB, al in glTF-assen (x, y=hoogte,
z=-noord) zodat de viewer hem direct kan gebruiken:
  items: huisnummerbordjes  [{street, number, pos [x,y,z], n [nx,nz]}]
  signs: straatnaamborden   [{street, pos, n}]   (eerste+laatste nummer per straat)
"""

from __future__ import annotations

import logging

import numpy as np

from .meshes import TriangleSoup

log = logging.getLogger(__name__)

NUMBER_HEIGHT = 2.0  # m boven maaiveld
SIGN_HEIGHT = 2.7
MAX_WALL_DIST = 20.0  # m: verder weg dan dit = geen gevel gevonden -> overslaan
PLAQUE_OFFSET = 0.15  # m voor de gevel


def _wall_data(soup: TriangleSoup):
    """Centroids + horizontale buitennormalen van (bijna) verticale wanddriehoeken."""
    tris = soup.triangles.get("wall") or []
    cents, norms = [], []
    for tri in tris:
        n = np.cross(tri[1] - tri[0], tri[2] - tri[0])
        ln = np.linalg.norm(n)
        if ln < 1e-9:
            continue
        n = n / ln
        if abs(n[2]) > 0.5:  # geen echte wand
            continue
        h = np.hypot(n[0], n[1])
        if h < 1e-6:
            continue
        cents.append(tri.mean(axis=0))
        norms.append([n[0] / h, n[1] / h])
    if not cents:
        return None, None
    return np.asarray(cents), np.asarray(norms)


def place_labels(addresses: list[dict], soup: TriangleSoup, ground_sampler) -> dict:
    """Bereken bordposities. addresses hebben lokale x/y (origin al afgetrokken)."""
    cents, norms = _wall_data(soup)
    items = []
    for addr in addresses:
        p = np.array([addr["x"], addr["y"]])
        if cents is not None:
            d2 = (cents[:, 0] - p[0]) ** 2 + (cents[:, 1] - p[1]) ** 2
            i = int(np.argmin(d2))
            if d2[i] <= MAX_WALL_DIST**2:
                n = norms[i]
                # normaal moet van het adrespunt (binnen het pand) af wijzen
                to_out = cents[i, :2] - p
                if np.dot(n, to_out) < 0:
                    n = -n
                pos_xy = cents[i, :2] + n * PLAQUE_OFFSET
                items.append(_entry(addr, pos_xy, n, ground_sampler))
                continue
        # geen gevel in de buurt: bordje op het adrespunt zelf, richting noord
        items.append(_entry(addr, p, np.array([0.0, -1.0]), ground_sampler))

    # straatnaamborden bij het laagste en hoogste huisnummer per straat
    by_street: dict[str, list[dict]] = {}
    for item in items:
        by_street.setdefault(item["street"], []).append(item)
    signs = []
    for street, entries in by_street.items():
        entries.sort(key=lambda e: e["numeric"])
        picks = [entries[0]] if len(entries) < 3 else [entries[0], entries[-1]]
        for e in picks:
            signs.append(
                {
                    "street": street,
                    "pos": [e["pos"][0], e["pos"][1] - NUMBER_HEIGHT + SIGN_HEIGHT, e["pos"][2]],
                    "n": e["n"],
                }
            )
    log.info("bordjes: %d huisnummers, %d straatnaamborden (%d straten)", len(items), len(signs), len(by_street))

    for item in items:  # numeric was alleen nodig voor sorteren
        item.pop("numeric", None)
    return {"axes": "gltf", "items": items, "signs": signs}


def _entry(addr: dict, pos_xy: np.ndarray, n: np.ndarray, ground_sampler) -> dict:
    z = ground_sampler(float(pos_xy[0]), float(pos_xy[1])) + NUMBER_HEIGHT
    # lokale (x, y, z-up) -> glTF (x, y=z, z=-y); normaal (nx, ny) -> (nx, -ny)
    return {
        "street": addr["street"],
        "number": addr["number"],
        "numeric": addr.get("numeric", 0),
        "pos": [round(float(pos_xy[0]), 2), round(float(z), 2), round(float(-pos_xy[1]), 2)],
        "n": [round(float(n[0]), 3), round(float(-n[1]), 3)],
    }
