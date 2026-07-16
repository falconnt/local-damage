"""Procedurele lowpoly-bomen ("bushy trees" uit de stijlgids).

Er is geen landsdekkende open bomendataset (zie bouwplan), dus we plaatsen
gestileerde bomen op BGT "begroeid terreindeel": willekeurige posities per
groencel, met variatie in hoogte, kruinvorm en tint. Alles komt als losse
driehoeken in de soup (klassen "trunk" en "tree") zodat het één mesh per
klasse wordt.
"""

from __future__ import annotations

import logging

import numpy as np

from .meshes import TriangleSoup

log = logging.getLogger(__name__)

# octaëder-basis voor een kruin-blob (8 vlakken, flat-shaded)
_OCT_TOP = np.array([0.0, 0.0, 1.0])
_OCT_BOT = np.array([0.0, 0.0, -1.0])
_OCT_RING = [
    np.array([1.0, 0.0, 0.0]),
    np.array([0.0, 1.0, 0.0]),
    np.array([-1.0, 0.0, 0.0]),
    np.array([0.0, -1.0, 0.0]),
]


def positions_from_mask(
    mask: np.ndarray,
    resolution_m: float,
    rng: np.random.Generator,
    per_cell_p: float = 0.06,
    max_trees: int = 1800,
) -> np.ndarray:
    """Kies boomposities (lokale x, y) in de 'groene' gridcellen."""
    rows, cols = np.nonzero(mask)
    if len(rows) == 0:
        return np.empty((0, 2))
    pick = rng.random(len(rows)) < per_cell_p
    rows, cols = rows[pick], cols[pick]
    if len(rows) > max_trees:
        keep = rng.choice(len(rows), max_trees, replace=False)
        rows, cols = rows[keep], cols[keep]
        log.info("bomen afgekapt op %d (dichtheidslimiet)", max_trees)
    jitter = rng.uniform(0.15, 0.85, (len(rows), 2))
    return np.column_stack([(cols + jitter[:, 0]) * resolution_m, (rows + jitter[:, 1]) * resolution_m])


def _blob(soup: TriangleSoup, center: np.ndarray, radius: np.ndarray, tint: float, rng) -> None:
    """Eén onregelmatige kruin-blob (gejitterde octaëder)."""
    top = center + _OCT_TOP * radius * rng.uniform(0.85, 1.15)
    bot = center + _OCT_BOT * radius * rng.uniform(0.55, 0.8)
    ring = [center + v * radius * rng.uniform(0.8, 1.2) for v in _OCT_RING]
    for i in range(4):
        a, b = ring[i], ring[(i + 1) % 4]
        soup.add("tree", np.array([a, b, top]), tint)
        soup.add("tree", np.array([b, a, bot]), tint)


def add_tree(soup: TriangleSoup, x: float, y: float, ground_z: float, rng: np.random.Generator) -> None:
    height = rng.uniform(3.0, 7.5)
    crown_r = rng.uniform(1.1, 2.4) * (0.7 + height / 10)
    tint = rng.uniform(0.8, 1.0)

    # stam: vierkante prisma (goedkoop, leest prima op afstand)
    trunk_r = 0.12 + height * 0.03
    trunk_h = height * rng.uniform(0.32, 0.45)
    base = np.array([x, y, ground_z - 0.1])
    corners = [
        np.array([trunk_r, trunk_r, 0]),
        np.array([-trunk_r, trunk_r, 0]),
        np.array([-trunk_r, -trunk_r, 0]),
        np.array([trunk_r, -trunk_r, 0]),
    ]
    up = np.array([0, 0, trunk_h])
    for i in range(4):
        a = base + corners[i]
        b = base + corners[(i + 1) % 4]
        soup.add("trunk", np.array([a, b, b + up]), tint)
        soup.add("trunk", np.array([a, b + up, a + up]), tint)

    # kruin: 2-3 blobs, hoger = smaller
    crown_base = ground_z + trunk_h
    n_blobs = int(rng.integers(2, 4))
    for i in range(n_blobs):
        f = i / max(1, n_blobs - 1)
        cz = crown_base + (height - trunk_h) * (0.25 + 0.6 * f)
        r = crown_r * (1.0 - 0.35 * f)
        offset = rng.uniform(-0.5, 0.5, 2) * (crown_r * 0.4)
        _blob(soup, np.array([x + offset[0], y + offset[1], cz]), r, tint, rng)


def plant_trees(
    soup: TriangleSoup,
    positions: np.ndarray,
    ground_sampler,
    seed: int = 21,
) -> int:
    rng = np.random.default_rng(seed)
    for x, y in positions:
        add_tree(soup, float(x), float(y), ground_sampler(float(x), float(y)), rng)
    log.info("bomen geplant: %d", len(positions))
    return len(positions)
