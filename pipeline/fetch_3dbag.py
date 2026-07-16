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


def fetch_buildings(bbox_rd: list[float], cache_dir: str | Path) -> tuple[dict, list[dict]]:
    """Haal alle panden binnen de RD-bbox op. Returnt (metadata, features)."""
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    session.headers["User-Agent"] = "local-damage-pipeline/0.1 (+github.com/falconnt/local-damage)"

    # De API accepteert bbox in CRS84 (lon/lat); RD-bbox eerst omrekenen.
    bbox_wgs = rd_bbox_to_wgs84(bbox_rd)
    url = f"{API_BASE}/collections/{COLLECTION}/items"
    params: dict | None = {
        "bbox": ",".join(f"{v:.7f}" for v in bbox_wgs),
        "limit": PAGE_LIMIT,
    }

    metadata: dict = {}
    features: list[dict] = []
    for page in range(MAX_PAGES):
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
