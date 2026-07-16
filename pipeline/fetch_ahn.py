"""AHN DTM (maaiveld) ophalen via de PDOK WCS als GeoTIFF.

Licentie brondata: PDOK/AHN open data (CC BY 4.0 / publiek domein).
Als de download mislukt (endpoint gewijzigd, netwerk) geeft de pipeline
None terug en valt build_area terug op vlak terrein op NAP 0 — Nederland
is vlak genoeg om de MVP niet op te laten stranden.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

import requests

log = logging.getLogger(__name__)

WCS_URL = "https://service.pdok.nl/rws/ahn/wcs/v1_0"
COVERAGE = "dtm_05m"


def fetch_dtm(bbox_rd: list[float], cache_dir: str | Path) -> Path | None:
    """Download het DTM voor de bbox (RD New). Returnt pad naar GeoTIFF of None."""
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    out = cache / "ahn_dtm.tif"
    if out.exists() and out.stat().st_size > 0:
        log.info("AHN DTM uit cache: %s", out)
        return out

    minx, miny, maxx, maxy = bbox_rd
    params = {
        "SERVICE": "WCS",
        "VERSION": "2.0.1",
        "REQUEST": "GetCoverage",
        "COVERAGEID": COVERAGE,
        "FORMAT": "image/tiff",
        "SUBSET": [f"x({minx},{maxx})", f"y({miny},{maxy})"],
    }

    delay = 2.0
    for attempt in range(4):
        try:
            resp = requests.get(WCS_URL, params=params, timeout=300)
            resp.raise_for_status()
            ctype = resp.headers.get("content-type", "")
            if "tiff" not in ctype and not resp.content.startswith((b"II*\x00", b"MM\x00*")):
                # XML-foutantwoord van de server
                log.error("WCS gaf geen GeoTIFF terug (content-type %s): %.300s", ctype, resp.text)
                return None
            out.write_bytes(resp.content)
            log.info("AHN DTM gedownload: %s (%.1f MB)", out, len(resp.content) / 1e6)
            return out
        except requests.RequestException as exc:
            if attempt == 3:
                log.error("AHN-download definitief mislukt: %s", exc)
                return None
            log.warning("AHN-request mislukt (%s), retry over %.0fs", exc, delay)
            time.sleep(delay)
            delay *= 2
    return None
