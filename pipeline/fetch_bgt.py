"""BGT-vlakken ophalen (PDOK OGC API Features): wegen, water, onverhard.

Licentie brondata: BGT via PDOK, CC BY 4.0.
De vlakken worden gebruikt om het terreingrid in te kleuren per ondergrond
(road/water/sand); begroeid terrein blijft de standaard grasklasse.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import numpy as np
import requests

from .crs import rd_bbox_to_wgs84, wgs84_to_rd

log = logging.getLogger(__name__)

API_BASE = "https://api.pdok.nl/lv/bgt/ogc/v1"

# BGT-collectie -> onze render-klasse
COLLECTIONS = {
    "wegdeel": "road",
    "waterdeel": "water",
    "onbegroeidterreindeel": "sand",
    "begroeidterreindeel": "green",  # parken/plantsoenen: iets dieper groen + bomen
}
PAGE_LIMIT = 1000
MAX_PAGES = 20


def fetch_surfaces(bbox_rd: list[float], cache_dir: str | Path) -> dict[str, list[np.ndarray]]:
    """Per klasse een lijst ringen (elke ring (N,2) in RD; gaten inbegrepen).

    Gaten worden als aparte ringen teruggegeven: de even-odd puntentest in
    terrain.classify werkt correct met buiten- en binnenringen samen.
    """
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers["User-Agent"] = "local-damage-pipeline/0.1"

    bbox_wgs = ",".join(f"{v:.7f}" for v in rd_bbox_to_wgs84(bbox_rd))
    result: dict[str, list[np.ndarray]] = {}

    for collection, cls in COLLECTIONS.items():
        rings: list[np.ndarray] = []
        url = f"{API_BASE}/collections/{collection}/items"
        params: dict | None = {"bbox": bbox_wgs, "limit": PAGE_LIMIT, "f": "json"}
        for page in range(MAX_PAGES):
            data = _get_json(session, url, params)
            (cache / f"bgt_{collection}_{page:02d}.json").write_text(json.dumps(data))
            for feat in data.get("features", []):
                props = feat.get("properties") or {}
                # bruggen/tunnels (relatieve hoogteligging != 0) niet op maaiveld verven
                rel = props.get("relatieve_hoogteligging", props.get("relatieveHoogteligging", 0))
                if rel not in (0, "0", None):
                    continue
                rings.extend(_geometry_rings(feat.get("geometry") or {}))
            next_url = _next_link(data)
            if not next_url:
                break
            url, params = next_url, None
        log.info("bgt %s: %d ringen", collection, len(rings))
        result[cls] = rings

    return result


def _geometry_rings(geometry: dict) -> list[np.ndarray]:
    gtype = geometry.get("type")
    coords = geometry.get("coordinates") or []
    polygons = []
    if gtype == "Polygon":
        polygons = [coords]
    elif gtype == "MultiPolygon":
        polygons = coords
    rings = []
    for poly in polygons:
        for ring in poly:  # buitenring + gaten
            arr = np.asarray([c[:2] for c in ring], dtype=np.float64)
            if len(arr) < 3:
                continue
            rings.append(_to_rd(arr))
    return rings


def _to_rd(ring: np.ndarray) -> np.ndarray:
    """Detecteer lon/lat vs RD aan de orde van grootte en converteer indien nodig."""
    if np.abs(ring).max() <= 360.0:
        out = np.empty_like(ring)
        for i, (lon, lat) in enumerate(ring):
            out[i] = wgs84_to_rd(lat, lon)
        return out
    return ring


def _next_link(data: dict) -> str | None:
    for link in data.get("links", []):
        if link.get("rel") == "next" and link.get("href"):
            return link["href"]
    return None


def _get_json(session: requests.Session, url: str, params: dict | None, tries: int = 4) -> dict:
    delay = 2.0
    for attempt in range(tries):
        try:
            resp = session.get(url, params=params, timeout=120, headers={"Accept": "application/geo+json, application/json"})
            resp.raise_for_status()
            return resp.json()
        except (requests.RequestException, ValueError) as exc:
            if attempt == tries - 1:
                raise
            log.warning("bgt-request mislukt (%s), retry over %.0fs", exc, delay)
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("unreachable")
