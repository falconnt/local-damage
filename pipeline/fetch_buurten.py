"""CBS Wijken en Buurten (via PDOK WFS): buurtnamen + middelpunt per regio.

Gebruikt voor de startlocatie-kiezer in free roam: de speler kan een buurt
('t Ven, De Bunders, Centrum, ...) of straat kiezen om te starten.
Licentie brondata: CBS/PDOK, CC BY 4.0. Mislukt de fetch, dan mist de
manifest simpelweg de buurtenlijst en verbergt de viewer de kiezer.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import requests

log = logging.getLogger(__name__)

WFS_URL = "https://service.pdok.nl/cbs/wijkenbuurten/2024/wfs/v1_0"
TYPENAME = "wijkenbuurten:buurten"


def _centroid(geom: dict):
    """Zwaartepunt van (Multi)Polygon-coordinaten (grofweg: alle buitenringen)."""
    coords = geom.get("coordinates") or []
    if geom.get("type") == "Polygon":
        coords = [coords]
    xs, ys, n = 0.0, 0.0, 0
    for poly in coords:
        if not poly:
            continue
        for x, y in poly[0]:  # buitenring
            xs += x
            ys += y
            n += 1
    if n == 0:
        return None
    return xs / n, ys / n


def fetch_buurten(bbox_rd: list[float], cache_dir: str | Path) -> list[dict]:
    """Buurten die de bbox raken: [{naam, wijk, rd: [x, y]}]. Leeg bij falen."""
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    out = cache / "buurten.json"
    if out.exists():
        return json.loads(out.read_text())

    minx, miny, maxx, maxy = bbox_rd
    params = {
        "service": "WFS",
        "version": "2.0.0",
        "request": "GetFeature",
        "typeName": TYPENAME,
        "outputFormat": "application/json",
        "srsName": "urn:ogc:def:crs:EPSG::28992",
        "bbox": f"{minx},{miny},{maxx},{maxy},urn:ogc:def:crs:EPSG::28992",
        "count": "200",
    }

    delay = 2.0
    for attempt in range(4):
        try:
            resp = requests.get(WFS_URL, params=params, timeout=120)
            resp.raise_for_status()
            data = resp.json()
            buurten = []
            for feat in data.get("features", []):
                props = feat.get("properties", {})
                if str(props.get("water", "NEE")).upper() == "JA":
                    continue  # waterbuurten niet als startplek
                naam = props.get("buurtnaam") or props.get("naam")
                if not naam:
                    continue
                c = _centroid(feat.get("geometry") or {})
                if c is None:
                    continue
                buurten.append({
                    "naam": naam.strip(),
                    "wijk": (props.get("wijknaam") or "").strip() or None,
                    "rd": [round(c[0], 1), round(c[1], 1)],
                })
            buurten.sort(key=lambda b: b["naam"])
            out.write_text(json.dumps(buurten))
            log.info("buurten opgehaald: %d (%s)", len(buurten),
                     ", ".join(b["naam"] for b in buurten[:8]))
            return buurten
        except (requests.RequestException, ValueError) as exc:
            if attempt == 3:
                log.error("buurten-download definitief mislukt: %s", exc)
                return []
            log.warning("buurten-request mislukt (%s), retry over %.0fs", exc, delay)
            time.sleep(delay)
            delay *= 2
    return []
