"""Geocoderen via de PDOK Locatieserver (gratis, geen key nodig).

Een gebieds-config mag i.p.v. een vaste bbox_rd een zoekopdracht bevatten
("locatieserver_query"); de pipeline lost die tijdens de build op naar
RD-coordinaten en centreert er een bbox omheen.
"""

from __future__ import annotations

import logging
import re

import requests

log = logging.getLogger(__name__)

SEARCH_URL = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free"


def geocode_rd(query: str) -> tuple[float, float, str]:
    """Zoek een plek en geef (x_rd, y_rd, weergavenaam) terug.

    Voorkeur voor straat/adres-resultaten; die liggen het dichtst bij wat
    iemand bedoelt met bv. "Bosven, Veghel".
    """
    resp = requests.get(
        SEARCH_URL,
        params={
            "q": query,
            "rows": 10,
            "fl": "weergavenaam,type,centroide_rd,score",
        },
        timeout=60,
        headers={"User-Agent": "local-damage-pipeline/0.1"},
    )
    resp.raise_for_status()
    docs = resp.json().get("response", {}).get("docs", [])
    if not docs:
        raise RuntimeError(f"Locatieserver vond niets voor {query!r}")

    preference = ("weg", "adres", "postcode", "woonplaats")
    docs.sort(key=lambda d: preference.index(d["type"]) if d.get("type") in preference else 99)
    doc = docs[0]

    match = re.match(r"POINT\(([\d.]+) ([\d.]+)\)", doc.get("centroide_rd", ""))
    if not match:
        raise RuntimeError(f"geen centroide_rd in Locatieserver-antwoord: {doc}")
    x, y = float(match.group(1)), float(match.group(2))
    log.info("geocode %r -> %s (%s) RD (%.0f, %.0f)", query, doc.get("weergavenaam"), doc.get("type"), x, y)
    return x, y, doc.get("weergavenaam", query)


def bbox_around(x: float, y: float, size_m: float) -> list[float]:
    """Vierkante bbox (RD) gecentreerd op (x, y), afgerond op hele meters."""
    half = size_m / 2
    return [round(x - half), round(y - half), round(x + half), round(y + half)]
