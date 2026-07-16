"""Synthetische testwijk — offline fixture voor de pipeline.

Genereert dezelfde tussenproducten als de echte fetchers (hoogtegrid +
gebouw-driehoeken + wegen/water), zodat de rest van de keten identiek
getest kan worden zonder netwerk. Levert ook de demo-GLB voor de viewer
zolang de echte CI-build nog niet gedraaid heeft.
"""

from __future__ import annotations

import numpy as np

from .meshes import TriangleSoup
from .terrain import sample_height, smooth_heights


def synthetic_heights(size_m: float, resolution_m: float, seed: int = 7) -> np.ndarray:
    """Glooiend polder-achtig terrein met een dijkje en wat ruis."""
    n = int(size_m / resolution_m) + 1
    rng = np.random.default_rng(seed)
    xs = np.linspace(0, size_m, n)
    xx, yy = np.meshgrid(xs, xs)

    z = (
        0.8 * np.sin(xx / 90.0)
        + 0.6 * np.cos(yy / 70.0 + 1.0)
        + 0.4 * np.sin((xx + yy) / 120.0)
    )
    # dijkje langs de oostrand
    z += 2.2 * np.exp(-((xx - size_m * 0.9) ** 2) / (2 * 30.0**2))
    # zachte ruis
    noise = rng.normal(0, 0.35, (n, n))
    z += smooth_heights(noise, passes=4)
    return smooth_heights(z, passes=2) + 1.0  # rond NAP +1


def _gabled_house(x: float, y: float, w: float, d: float, wall_h: float, ridge_h: float, angle: float, soup: TriangleSoup, ground_z: float, tint: float) -> None:
    """Eenvoudig huis met zadeldak, geroteerd om (x, y)."""
    ca, sa = np.cos(angle), np.sin(angle)

    def pt(lx: float, ly: float, z: float) -> np.ndarray:
        return np.array([x + lx * ca - ly * sa, y + lx * sa + ly * ca, ground_z + z])

    hw, hd = w / 2, d / 2
    # hoekpunten onder/boven + nokpunten
    b = [pt(-hw, -hd, 0), pt(hw, -hd, 0), pt(hw, hd, 0), pt(-hw, hd, 0)]
    t = [pt(-hw, -hd, wall_h), pt(hw, -hd, wall_h), pt(hw, hd, wall_h), pt(-hw, hd, wall_h)]
    r0 = pt(-hw, 0, ridge_h)
    r1 = pt(hw, 0, ridge_h)

    # muren (4 zijden), met puntgevels links/rechts
    soup.add_polygon("wall", np.array([b[0], b[1], t[1], t[0]]), tint)
    soup.add_polygon("wall", np.array([b[3], b[2], t[2], t[3]]), tint)
    soup.add_polygon("wall", np.array([b[1], b[2], t[2], r1, t[1]]), tint)
    soup.add_polygon("wall", np.array([b[0], t[0], r0, t[3], b[3]]), tint)
    # dakvlakken
    soup.add_polygon("roof", np.array([t[0], t[1], r1, r0]), tint)
    soup.add_polygon("roof", np.array([t[3], r0, r1, t[2]]), tint)
    # vloer/footprint
    soup.add_polygon("ground", np.array([b[3], b[2], b[1], b[0]]), tint)


def synthetic_buildings(
    heights: np.ndarray, resolution_m: float, size_m: float, seed: int = 11
) -> tuple[TriangleSoup, list[dict]]:
    """Een grid-wijkje met rijtjeshuizen langs straatjes + een kerkje.

    Geeft ook nep-adressen terug (zelfde vorm als fetch_bag) zodat de
    bordjes-keten offline getest kan worden.
    """
    rng = np.random.default_rng(seed)
    soup = TriangleSoup()
    addresses: list[dict] = []

    street_pitch = 60.0
    for row, by in enumerate(np.arange(45.0, size_m - 45.0, street_pitch)):
        street = "Demostraat" if row % 2 == 0 else "Testlaan"
        number = 1
        for bx in np.arange(35.0, size_m - 35.0, 13.0):
            if rng.random() < 0.15:
                continue  # gaatje in het blok
            gz = sample_height(heights, resolution_m, bx, by)
            wall_h = rng.uniform(3.2, 6.5)
            ridge = wall_h + rng.uniform(1.5, 3.5)
            tint = rng.uniform(0.86, 1.0)
            _gabled_house(bx, by, 8.0, rng.uniform(8.0, 12.0), wall_h, ridge, 0.0, soup, gz, tint)
            addresses.append(
                {"street": street, "number": str(number), "numeric": number, "x": bx, "y": by}
            )
            number += 2

    # "kerkje": hoge toren in het midden
    cx = cy = size_m / 2
    gz = sample_height(heights, resolution_m, cx, cy)
    _gabled_house(cx, cy + 14, 14.0, 26.0, 9.0, 15.0, 0.0, soup, gz, 0.95)
    _gabled_house(cx, cy - 8, 9.0, 9.0, 22.0, 30.0, 0.0, soup, gz, 0.9)
    return soup, addresses


def synthetic_overlays(heights: np.ndarray, resolution_m: float, size_m: float) -> TriangleSoup:
    """Wegen als strips + een waterpartij, licht boven het terrein gedrapeerd."""
    soup = TriangleSoup()
    street_pitch = 60.0

    def draped_quad(x0, y0, x1, y1, cls, lift=0.06, step=8.0):
        # strip opdelen zodat hij het terrein volgt
        length = max(abs(x1 - x0), abs(y1 - y0))
        n = max(1, int(length / step))
        for i in range(n):
            f0, f1 = i / n, (i + 1) / n
            ax, ay = x0 + (x1 - x0) * f0, y0 + (y1 - y0) * f0
            bx, by = x0 + (x1 - x0) * f1, y0 + (y1 - y0) * f1
            if abs(x1 - x0) > abs(y1 - y0):  # horizontale strip
                half = (y1 - y0) / 2 or 3.5
                cy = (y0 + y1) / 2
                pts = [(ax, cy - half), (bx, cy - half), (bx, cy + half), (ax, cy + half)]
            else:
                half = (x1 - x0) / 2 or 3.5
                cx = (x0 + x1) / 2
                pts = [(cx - half, ay), (cx - half, by), (cx + half, by), (cx + half, ay)]
            ring = np.array(
                [[px, py, sample_height(heights, resolution_m, px, py) + lift] for px, py in pts]
            )
            soup.add_polygon(cls, ring)

    # oost-west straten tussen de huizenblokken
    for by in np.arange(45.0 + 30.0, size_m - 45.0, street_pitch):
        draped_quad(10.0, by - 3.5, size_m - 10.0, by + 3.5, "road")
    # een noord-zuid hoofdstraat
    draped_quad(size_m * 0.18 - 4, 10.0, size_m * 0.18 + 4, size_m - 10.0, "road")

    # waterpartij (vijver) linksonder
    cx, cy, r = size_m * 0.78, size_m * 0.2, 42.0
    wz = sample_height(heights, resolution_m, cx, cy) - 0.4
    ring = np.array(
        [[cx + r * np.cos(a), cy + r * np.sin(a), wz] for a in np.linspace(0, 2 * np.pi, 24, endpoint=False)]
    )
    soup.add_polygon("water", ring)
    return soup
