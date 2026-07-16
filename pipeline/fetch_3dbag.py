"""Gebouwen ophalen bij api.3dbag.nl (OGC API Features, CityJSONFeatures).

Licentie brondata: CC BY 4.0 — (c) 3DBAG by tudelft3d and 3DGI.
Responses worden per pagina naar cache_dir geschreven zodat een CI-run
debugbaar is (upload als artifact).
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import requests

from .crs import rd_bbox_to_wgs84

log = logging.getLogger(__name__)

API_BASE = "https://api.3dbag.nl"
COLLECTION = "pand"
PAGE_LIMIT = 100
MAX_PAGES = 200  # veiligheidsklep: ~20k gebouwen is ruim genoeg voor 1 wijk
# De API selecteert in de praktijk per interne tegel: een strak bbox-verzoek
# kan hele stukken van de wijk missen. Daarom vragen we ruimer op en clippen
# we client-side op footprint-centroid (zie cityjson.parse_city_objects).
EXPAND_M = 300.0


def _bbox_variants(bbox_rd: list[float]) -> list[tuple[str, dict]]:
    """Kandidaat-queryparams voor de bbox, in volgorde van waarschijnlijkheid.

    De 3D BAG API interpreteert bbox in de praktijk in RD/EPSG:7415 (de
    opslag-CRS), niet in het OGC-default CRS84. We proberen daarom eerst RD,
    dan RD met explicit bbox-crs, en pas dan lon/lat.
    """
    rd = ",".join(f"{v:.2f}" for v in bbox_rd)
    wgs = ",".join(f"{v:.7f}" for v in rd_bbox_to_wgs84(bbox_rd))
    return [
        ("rd-plain", {"bbox": rd, "limit": PAGE_LIMIT}),
        (
            "rd-bbox-crs",
            {
                "bbox": rd,
                "bbox-crs": "http://www.opengis.net/def/crs/EPSG/0/7415",
                "limit": PAGE_LIMIT,
            },
        ),
        ("crs84", {"bbox": wgs, "limit": PAGE_LIMIT}),
    ]


def fetch_buildings(bbox_rd: list[float], cache_dir: str | Path) -> tuple[dict, list[dict]]:
    """Haal alle panden binnen de RD-bbox op. Returnt (metadata, features)."""
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    session.headers["User-Agent"] = "local-damage-pipeline/0.1 (+github.com/falconnt/local-damage)"
    url = f"{API_BASE}/collections/{COLLECTION}/items"

    bbox_rd = [
        bbox_rd[0] - EXPAND_M,
        bbox_rd[1] - EXPAND_M,
        bbox_rd[2] + EXPAND_M,
        bbox_rd[3] + EXPAND_M,
    ]

    # eerste pagina: bbox-varianten proberen tot er features komen
    params: dict | None = None
    first_page: dict | None = None
    for label, candidate in _bbox_variants(bbox_rd):
        try:
            resp = _get_with_retry(session, url, candidate, tries=2)
        except requests.RequestException as exc:
            log.warning("3dbag bbox-variant %s geweigerd (%s), volgende proberen", label, exc)
            continue
        data = resp.json()
        count = len(data.get("features") or ([data] if "CityObjects" in data else []))
        log.info("3dbag bbox-variant %s: %d features", label, count)
        if count > 0:
            params, first_page = candidate, data
            break

    if first_page is None:
        log.error("geen enkele bbox-variant leverde features op voor bbox %s", bbox_rd)
        return {}, []

    metadata: dict = {}
    features: list[dict] = []
    data = first_page
    for page in range(MAX_PAGES):
        if page > 0:
            resp = _get_with_retry(session, url, params)
            data = resp.json()
        (cache / f"3dbag_page_{page:03d}.json").write_text(json.dumps(data))

        metadata = data.get("metadata") or metadata
        page_feats = data.get("features")
        if page_feats is None and "CityObjects" in data:
            # sommige antwoorden zijn 1 CityJSON-document i.p.v. een featurelijst
            page_feats = [data]
        features.extend(page_feats or [])
        log.info("3dbag pagina %d: %d features (totaal %d)", page, len(page_feats or []), len(features))

        next_url = _next_link(data)
        if not next_url:
            break
        url, params = next_url, None  # next-link bevat de query al

    return metadata, features


def _next_link(data: dict) -> str | None:
    for link in data.get("links", []):
        if link.get("rel") == "next" and link.get("href"):
            return link["href"]
    return None


def _get_with_retry(session: requests.Session, url: str, params: dict | None, tries: int = 4):
    delay = 2.0
    for attempt in range(tries):
        try:
            resp = session.get(url, params=params, timeout=120)
            resp.raise_for_status()
            return resp
        except requests.RequestException as exc:
            if attempt == tries - 1:
                raise
            log.warning("3dbag-request mislukt (%s), retry over %.0fs", exc, delay)
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("unreachable")
