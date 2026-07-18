"""PDOK Luchtfoto (Actueel_ortho25) ophalen als JPEG voor een tegel-bbox.

Gebruikt om per pand de echte dakkleur te meten, zodat wijken automatisch
hun eigen materiaalbeeld krijgen zonder handmatige referentiefoto's.
Licentie brondata: Beeldmateriaal Nederland via PDOK, CC BY 4.0.
Mislukt de download, dan valt de stijl terug op het bouwperiode-palet.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

import requests

log = logging.getLogger(__name__)

WMS_URL = "https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0"
LAYER = "Actueel_ortho25"
RES_M = 0.25  # meter per pixel (25 cm-laag)
MAX_PX = 2048


def fetch_rgb(bbox_rd: list[float], cache_dir: str | Path) -> Path | None:
    """Download de luchtfoto voor de bbox (RD New). Returnt pad naar JPEG of None."""
    cache = Path(cache_dir)
    cache.mkdir(parents=True, exist_ok=True)
    out = cache / "luchtfoto.jpg"
    if out.exists() and out.stat().st_size > 0:
        log.info("luchtfoto uit cache: %s", out)
        return out

    minx, miny, maxx, maxy = bbox_rd
    width = min(MAX_PX, int(round((maxx - minx) / RES_M)))
    height = min(MAX_PX, int(round((maxy - miny) / RES_M)))
    params = {
        "SERVICE": "WMS",
        "VERSION": "1.3.0",
        "REQUEST": "GetMap",
        "LAYERS": LAYER,
        "STYLES": "",
        "CRS": "EPSG:28992",
        "BBOX": f"{minx},{miny},{maxx},{maxy}",
        "WIDTH": str(width),
        "HEIGHT": str(height),
        "FORMAT": "image/jpeg",
    }

    delay = 2.0
    for attempt in range(4):
        try:
            resp = requests.get(WMS_URL, params=params, timeout=180)
            resp.raise_for_status()
            ctype = resp.headers.get("content-type", "")
            if "image" not in ctype:
                log.error("WMS gaf geen beeld terug (content-type %s): %.300s", ctype, resp.text)
                return None
            out.write_bytes(resp.content)
            log.info("luchtfoto gedownload: %s (%.1f MB, %dx%d px)",
                     out, len(resp.content) / 1e6, width, height)
            return out
        except requests.RequestException as exc:
            if attempt == 3:
                log.error("luchtfoto-download definitief mislukt: %s", exc)
                return None
            log.warning("luchtfoto-request mislukt (%s), retry over %.0fs", exc, delay)
            time.sleep(delay)
            delay *= 2
    return None


def make_roof_sampler(image_path: Path, bbox_rd: list[float]):
    """Sampler(x_local, y_local) -> (r, g, b) in 0..1, of None buiten beeld.

    x/y lokaal = meters t.o.v. de bbox-linksonder (zoals de tegel-coordinaten).
    """
    from PIL import Image
    import numpy as np

    img = np.asarray(Image.open(image_path).convert("RGB"), dtype=np.float32) / 255.0
    h, w = img.shape[:2]
    minx, miny, maxx, maxy = bbox_rd
    sx = w / (maxx - minx)
    sy = h / (maxy - miny)

    def sample(x: float, y: float):
        px = int(x * sx)
        py = int((maxy - miny - y) * sy)  # beeld-y loopt van noord naar zuid
        if 0 <= px < w and 0 <= py < h:
            return img[py, px]
        return None

    return sample
