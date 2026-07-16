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


def place_labels(
    addresses: list[dict],
    soup: TriangleSoup,
    ground_sampler,
    road_points: np.ndarray | None = None,
) -> dict:
    """Bereken bordposities. addresses hebben lokale x/y (origin al afgetrokken).

    Met road_points (N,2) kiezen we niet de dichtstbijzijnde gevel, maar de
    gevel die het dichtst bij de weg ligt — het huisnummer hangt dan aan de
    straatkant (voordeur) i.p.v. aan een achterpad of zijmuur.
    """
    cents, norms = _wall_data(soup)
    rp = np.asarray(road_points, dtype=np.float64) if road_points is not None and len(road_points) else None
    items = []
    for addr in addresses:
        p = np.array([addr["x"], addr["y"]])
        if cents is not None:
            d2 = (cents[:, 0] - p[0]) ** 2 + (cents[:, 1] - p[1]) ** 2
            cand = np.nonzero(d2 <= MAX_WALL_DIST**2)[0]
            if len(cand):
                # normaal moet van het adrespunt (binnen het pand) af wijzen
                to_out = cents[cand, :2] - p
                flip = np.sign(np.einsum("ij,ij->i", norms[cand], to_out))
                flip[flip == 0] = 1.0
                cand_norms = norms[cand] * flip[:, None]

                if rp is not None:
                    # score: afstand van 'n stap voor de gevel tot de weg,
                    # plus lichte voorkeur voor gevels dicht bij het adres
                    cand = cand[np.argsort(d2[cand])[:120]]
                    to_out = cents[cand, :2] - p
                    flip = np.sign(np.einsum("ij,ij->i", norms[cand], to_out))
                    flip[flip == 0] = 1.0
                    cand_norms = norms[cand] * flip[:, None]
                    outs = cents[cand, :2] + cand_norms * 3.5
                    road_d = np.sqrt(
                        ((outs[:, None, :] - rp[None, :, :]) ** 2).sum(axis=2)
                    ).min(axis=1)
                    score = road_d + 0.35 * np.sqrt(d2[cand])
                    k = int(np.argmin(score))
                else:
                    k = int(np.argmin(d2[cand]))

                n = cand_norms[k]
                pos_xy = cents[cand[k], :2] + n * PLAQUE_OFFSET
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
