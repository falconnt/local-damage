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

# PDOK verhuist OGC-endpoints af en toe (juli 2026: /ogc/v1 gaf ineens 404 op
# items). Daarom: kandidaat-bases proberen en de collectienamen zelf ontdekken
# via de /collections-lijst in plaats van ze hard te coderen.
API_BASES = [
    "https://api.pdok.nl/lv/bgt/ogc/v1",
    "https://api.pdok.nl/lv/bgt/ogc/v1_0",
    "https://api.pdok.nl/lv/bgt/ogc/features/v1",
]

# BGT-collectie -> onze render-klasse
COLLECTIONS = {
    "wegdeel": "road",
    "waterdeel": "water",
    "onbegroeidterreindeel": "sand",
    "begroeidterreindeel": "green",  # parken/plantsoenen: iets dieper groen + bomen
}
PAGE_LIMIT = 1000
MAX_PAGES = 20

_resolved: dict | None = None  # {"base": url, "ids": {gewenst -> echt collection-id}}


def _resolve_api(session: requests.Session) -> dict:
    """Vind een werkende API-basis + de echte collection-id's (bv. hernoemd)."""
    global _resolved
    if _resolved is not None:
        return _resolved
    last_exc: Exception | None = None
    for base in API_BASES:
        try:
            data = _get_json(session, f"{base}/collections", {"f": "json"}, tries=2)
            ids = [c.get("id") for c in data.get("collections", []) if c.get("id")]
            mapping = {}
            for wanted in COLLECTIONS:
                exact = wanted if wanted in ids else None
                fuzzy = next((i for i in ids if wanted in i), None)
                if exact or fuzzy:
                    mapping[wanted] = exact or fuzzy
            if mapping:
                _resolved = {"base": base, "ids": mapping}
                log.info("bgt-api gevonden: %s — collecties %s", base, mapping)
                return _resolved
            log.warning("bgt-basis %s heeft geen passende collecties (ids: %s)", base, ids[:12])
        except Exception as exc:  # noqa: BLE001 — volgende kandidaat proberen
            last_exc = exc
            log.warning("bgt-basis %s niet bruikbaar (%s)", base, exc)
    raise RuntimeError(f"geen werkende BGT OGC API gevonden: {last_exc}")


def fetch_surfaces(bbox_rd: list[float], cache_dir: str | Path) -> dict[str, list[list[np.ndarray]]]:
    """Per klasse een lijst POLYGONEN; elke polygoon is [buitenring, gat, ...].

    De polygoonstructuur blijft behouden: de classificatie neemt de UNIE over
    polygonen (met even-odd alleen binnen een polygoon voor gaten). Ringen
    plat samengooien zou overlappende/dubbele vlakken tegen elkaar laten
    wegvallen — dan verdwijnen hele vijvers.
    """
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers["User-Agent"] = "local-damage-pipeline/0.1"

    bbox_wgs = ",".join(f"{v:.7f}" for v in rd_bbox_to_wgs84(bbox_rd))
    result: dict[str, list[list[np.ndarray]]] = {}

    for collection, cls in COLLECTIONS.items():
        polygons: list[list[np.ndarray]] = []
        n_feats = 0
        marker = cache / f"_bgt_{collection}_complete.json"
        cached_pages = json.loads(marker.read_text())["pages"] if marker.exists() else None
        url: str | None = None  # netwerk-URL wordt pas gezet na API-resolutie
        params: dict | None = {"bbox": bbox_wgs, "limit": PAGE_LIMIT, "f": "json"}
        fetched = 0
        for page in range(cached_pages if cached_pages is not None else MAX_PAGES):
            if cached_pages is not None:
                data = json.loads((cache / f"bgt_{collection}_{page:02d}.json").read_text())
            else:
                if url is None:
                    api = _resolve_api(session)
                    coll_id = api["ids"].get(collection)
                    if coll_id is None:
                        log.warning("bgt-collectie %s ontbreekt in de API — overgeslagen", collection)
                        break
                    url = f"{api['base']}/collections/{coll_id}/items"
                data = _get_json(session, url, params)
                (cache / f"bgt_{collection}_{page:02d}.json").write_text(json.dumps(data))
                fetched += 1
            for feat in data.get("features", []):
                props = feat.get("properties") or {}
                # bruggen/tunnels (relatieve hoogteligging != 0) niet op maaiveld verven
                rel = props.get("relatieve_hoogteligging", props.get("relatieveHoogteligging", 0))
                if rel not in (0, "0", None):
                    continue
                n_feats += 1
                polygons.extend(_geometry_polygons(feat.get("geometry") or {}))
            next_url = _next_link(data)
            if not next_url:
                break
            url, params = next_url, None
        if cached_pages is None and fetched > 0:
            marker.write_text(json.dumps({"pages": fetched}))
        elif cached_pages is not None:
            log.info("bgt %s uit cache", collection)
        log.info("bgt %s: %d features, %d polygonen", collection, n_feats, len(polygons))
        result[cls] = polygons

    return result


def _geometry_polygons(geometry: dict) -> list[list[np.ndarray]]:
    gtype = geometry.get("type")
    coords = geometry.get("coordinates") or []
    raw_polys = []
    if gtype == "Polygon":
        raw_polys = [coords]
    elif gtype == "MultiPolygon":
        raw_polys = coords
    polygons = []
    for poly in raw_polys:
        rings = []
        for ring in poly:  # buitenring + gaten
            arr = np.asarray([c[:2] for c in ring], dtype=np.float64)
            if len(arr) < 3:
                continue
            rings.append(_to_rd(arr))
        if rings:
            polygons.append(rings)
    return polygons


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
