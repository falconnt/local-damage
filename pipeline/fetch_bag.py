"""BAG-adressen ophalen (PDOK WFS, verblijfsobjecten): straat + huisnummer.

Licentie brondata: BAG via PDOK (CC0/publiek domein met bronvermelding).
Gebruikt voor huisnummerbordjes op gevels en straatnaamborden in de viewer.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path

import requests

log = logging.getLogger(__name__)

WFS_URL = "https://service.pdok.nl/lv/bag/wfs/v2_0"
TYPE_NAME = "bag:verblijfsobject"
PAGE_SIZE = 1000
MAX_PAGES = 5


def fetch_addresses(bbox_rd: list[float], cache_dir: str | Path) -> list[dict]:
    """Adressen in de bbox: [{street, number, x, y}] in RD-coordinaten."""
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers["User-Agent"] = "local-damage-pipeline/0.1"

    minx, miny, maxx, maxy = bbox_rd
    addresses: list[dict] = []
    for page in range(MAX_PAGES):
        params = {
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeName": TYPE_NAME,
            "outputFormat": "application/json",
            "srsName": "urn:ogc:def:crs:EPSG::28992",
            "bbox": f"{minx},{miny},{maxx},{maxy},urn:ogc:def:crs:EPSG::28992",
            "count": PAGE_SIZE,
            "startIndex": page * PAGE_SIZE,
        }
        data = _get_json(session, params)
        (cache / f"bag_vbo_{page:02d}.json").write_text(json.dumps(data))
        features = data.get("features", [])
        for feat in features:
            props = feat.get("properties") or {}
            geom = feat.get("geometry") or {}
            if geom.get("type") != "Point":
                continue
            street = (
                props.get("openbare_ruimte")
                or props.get("openbareruimtenaam")
                or props.get("straatnaam")
            )
            number = props.get("huisnummer")
            if not street or number is None:
                continue
            label = str(number)
            if props.get("huisletter"):
                label += str(props["huisletter"])
            if props.get("toevoeging"):
                label += f"-{props['toevoeging']}"
            x, y = geom["coordinates"][:2]
            addresses.append(
                {"street": str(street), "number": label, "numeric": int(number), "x": float(x), "y": float(y)}
            )
        log.info("bag pagina %d: %d features (totaal %d adressen)", page, len(features), len(addresses))
        if len(features) < PAGE_SIZE:
            break

    return addresses


def _get_json(session: requests.Session, params: dict, tries: int = 4) -> dict:
    delay = 2.0
    for attempt in range(tries):
        try:
            resp = session.get(WFS_URL, params=params, timeout=120)
            resp.raise_for_status()
            return resp.json()
        except (requests.RequestException, ValueError) as exc:
            if attempt == tries - 1:
                raise
            log.warning("bag-request mislukt (%s), retry over %.0fs", exc, delay)
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("unreachable")
