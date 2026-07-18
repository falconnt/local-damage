"""CityJSON(Seq)-parser: 3D BAG-gebouwen -> driehoeken per semantische klasse.

Ondersteunt zowel een volledige CityJSON (met "CityObjects" + "vertices")
als de CityJSONFeature-items van api.3dbag.nl. De parser is bewust tolerant:
het API-formaat kan per versie licht verschillen.
"""

from __future__ import annotations

import hashlib
import logging

import numpy as np

from .meshes import TriangleSoup, triangulate_polygon

log = logging.getLogger(__name__)

# CityJSON-semantiek -> onze render-klassen
SEMANTIC_MAP = {
    "RoofSurface": "roof",
    "WallSurface": "wall",
    "GroundSurface": "ground",
    "OuterCeilingSurface": "roof",
    "OuterFloorSurface": "ground",
    "ClosureSurface": "wall",
}

LOD_PREFERENCE = ("2.2", "1.3", "1.2")


def _object_tint(obj_id: str) -> np.ndarray:
    """Stabiele kleurvariatie per gebouw: helderheid + lichte warm/koel-zweem.

    Sterk genoeg om bij rijtjeshuizen de naad tussen twee panden te zien,
    subtiel genoeg om binnen het diorama-palet te blijven.
    """
    digest = hashlib.sha1(obj_id.encode()).digest()
    base = 0.86 + 0.16 * (digest[0] / 255.0)
    warm = (digest[1] / 255.0 - 0.5) * 0.08
    return np.array([base + warm, base, base - warm], dtype=np.float32)


# --- wijkstijl per bouwperiode ----------------------------------------------
# Nederlandse woonwijken hebben per bouwperiode een herkenbaar materiaalbeeld
# (baksteen- en dakpankleur). Het bouwjaar komt uit 3D BAG
# (`oorspronkelijkbouwjaar`), het daktype uit `b3_dak_type`. De kleuren worden
# gebakken als verhouding t.o.v. de paletbasis (viewer: klasse-kleur x
# vertex-kleur), zodat de sfeerpaletten (middag/zonsondergang/mist) blijven
# werken. Varianten worden per "bouwproject" gekozen (ruimtelijk blok van 60 m
# + periode): hele rijen delen dan dezelfde steen, zoals in het echt.
_BASE_WALL = np.array([0xE8, 0xE0, 0xCD], dtype=np.float64) / 255.0
_BASE_ROOF = np.array([0xC2, 0x6B, 0x4E], dtype=np.float64) / 255.0
_FLAT_ROOF = "#55565c"  # bitumen/grind: altijd donkergrijs, ongeacht periode


def _hex(c: str) -> np.ndarray:
    return np.array([int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16)], dtype=np.float64) / 255.0


# (tot-jaar, [(kleur, gewicht), ...]) — doelkleuren bij het middag-palet
_WALL_ERAS = [
    (1945, [("#8a4a3a", 3)]),                                    # vooroorlogs donkerrood
    (1970, [("#9a604a", 3), ("#8a5a46", 1)]),                    # wederopbouw roodbruin
    (1990, [("#8a6a52", 3), ("#96705a", 1)]),                    # jaren 70/80 bruin
    # vinex ('t Ven-stijl, zie Bosven 307): baksteen onder + wit stucwerk boven,
    # daarnaast effen roodbruine en zandgele rijen
    (2005, [({"low": "#b4623f", "high": "#e9e4d8"}, 3), ("#a86048", 2), ("#d5c49c", 2)]),
    (9999, [("#d8caaa", 2), ({"low": "#a8543e", "high": "#ece7dc"}, 2), ("#8f4a3c", 1), ("#a89886", 1)]),  # 2005+
]
_ROOF_ERAS = [
    (1945, [("#b05a38", 1)]),                                    # oud-Hollands oranjerood
    (1970, [("#a85a40", 2), ("#6a5148", 1)]),
    (1990, [("#5e453a", 2), ("#4a4640", 1)]),                    # donkerbruin/antraciet
    (2005, [("#46474f", 3), ("#aa5c3e", 2)]),                    # vinex: antraciet / oranjerood
    (9999, [("#3f4046", 3), ("#9a4f34", 1)]),
]


def _pick_weighted(options, seed: str):
    total = sum(w for _, w in options)
    r = int.from_bytes(hashlib.sha1(seed.encode()).digest()[:2], "big") % total
    for color, w in options:
        r -= w
        if r < 0:
            return color
    return options[0][0]


def _era_style(year, dak_type, cx: float, cy: float):
    """(muur-, dak-)stijl voor dit pand: periode + projectblok bepalen.

    Muurstijl is een kleurfactor, of een dict {low, high} voor het
    twee-lagen-beeld (baksteen onder, stucwerk boven).
    """
    y = int(year) if year else 1995  # onbekend: aanname nieuwbouwwijk
    era_i = next(i for i, (until, _) in enumerate(_WALL_ERAS) if y < until)
    block = f"{int(cx // 60)}_{int(cy // 60)}_{era_i}"
    picked = _pick_weighted(_WALL_ERAS[era_i][1], block + "w")
    if isinstance(picked, dict):
        wall = {k: (_hex(v) / _BASE_WALL).astype(np.float32) for k, v in picked.items()}
    else:
        wall = (_hex(picked) / _BASE_WALL).astype(np.float32)
    if dak_type in ("horizontal", "multiple horizontal"):
        roof = _hex(_FLAT_ROOF)
    else:
        roof = _hex(_pick_weighted(_ROOF_ERAS[era_i][1], block + "r"))
    return wall, (roof / _BASE_ROOF).astype(np.float32)


def _clip_tri_z(tri: np.ndarray, z: float):
    """Splits een driehoek op het vlak z: levert (subdriehoek, onder?) paren.

    Winding blijft behouden zodat de flat-shading-normalen kloppen.
    """
    d = tri[:, 2] - z
    below = d < 0
    n_below = int(below.sum())
    if n_below in (0, 3):
        yield tri, n_below == 3
        return
    lone_below = n_below == 1
    lone_i = int(np.where(below == lone_below)[0][0])
    v = np.roll(tri, -lone_i, axis=0)
    dd = np.roll(d, -lone_i)
    i01 = v[0] + (v[1] - v[0]) * (dd[0] / (dd[0] - dd[1]))
    i02 = v[0] + (v[2] - v[0]) * (dd[0] / (dd[0] - dd[2]))
    yield np.array([v[0], i01, i02]), lone_below
    yield np.array([v[1], v[2], i02]), not lone_below
    yield np.array([v[1], i02, i01]), not lone_below


def _transform_vertices(vertices, transform) -> np.ndarray:
    verts = np.asarray(vertices, dtype=np.float64)
    if verts.size == 0:
        return verts.reshape(0, 3)
    if transform:
        scale = np.asarray(transform.get("scale", [1, 1, 1]), dtype=np.float64)
        translate = np.asarray(transform.get("translate", [0, 0, 0]), dtype=np.float64)
        verts = verts * scale + translate
    return verts


def _pick_geometry(geometries: list[dict]) -> dict | None:
    for lod in LOD_PREFERENCE:
        for geom in geometries:
            if str(geom.get("lod")) == lod:
                return geom
    return geometries[0] if geometries else None


def _iter_faces(geom: dict):
    """Yield (ring_indices, semantic_index) per face, voor Solid en MultiSurface.

    Alleen de buitenring per face; gaten worden in de MVP genegeerd.
    """
    boundaries = geom.get("boundaries", [])
    semantics = geom.get("semantics") or {}
    values = semantics.get("values")

    gtype = geom.get("type")
    if gtype == "Solid":
        for si, shell in enumerate(boundaries):
            for fi, face in enumerate(shell):
                sem = None
                if values is not None:
                    try:
                        sem = values[si][fi]
                    except (IndexError, TypeError):
                        sem = None
                yield face[0], sem
    elif gtype in ("MultiSurface", "CompositeSurface"):
        for fi, face in enumerate(boundaries):
            sem = None
            if values is not None:
                try:
                    sem = values[fi]
                except (IndexError, TypeError):
                    sem = None
            yield face[0], sem
    elif gtype in ("MultiSolid", "CompositeSolid"):
        for oi, solid in enumerate(boundaries):
            for si, shell in enumerate(solid):
                for fi, face in enumerate(shell):
                    sem = None
                    if values is not None:
                        try:
                            sem = values[oi][si][fi]
                        except (IndexError, TypeError):
                            sem = None
                    yield face[0], sem


def parse_city_objects(
    city_objects: dict,
    vertices: np.ndarray,
    soup: TriangleSoup,
    origin: np.ndarray,
    surface_types: list[dict] | None = None,
    ground_sampler=None,
    clip_bounds: tuple[float, float, float, float] | None = None,
) -> int:
    """Voeg alle Building(Part)-geometrie toe aan de soup. Returnt #faces.

    ground_sampler(x, y) -> terreinhoogte (lokale coords). Als die meegegeven
    is, wordt elk gebouw verticaal gesnapt: de onderkant komt op de laagste
    terreinhoogte onder de footprint. Dat voorkomt zwevende huizen doordat
    3D BAG-maaiveld en ons gladgestreken AHN-grid net verschillen.
    """
    faces_added = 0
    for obj_id, obj in city_objects.items():
        if obj.get("type") not in ("Building", "BuildingPart"):
            continue
        geometries = obj.get("geometry") or []
        geom = _pick_geometry(geometries)
        if not geom:
            continue
        # attributen (bouwjaar, daktype) staan op het Building-object; de
        # geometrie meestal op de BuildingPart — kijk dan bij de ouder
        attrs = obj.get("attributes") or {}
        if not attrs.get("oorspronkelijkbouwjaar"):
            for parent_id in obj.get("parents") or []:
                pattrs = (city_objects.get(parent_id) or {}).get("attributes") or {}
                if pattrs.get("oorspronkelijkbouwjaar"):
                    attrs = pattrs
                    break
        tint = _object_tint(obj_id)
        sem_surfaces = (geom.get("semantics") or {}).get("surfaces") or surface_types or []

        faces: list[tuple[str, np.ndarray]] = []
        for ring_idx, sem in _iter_faces(geom):
            if len(ring_idx) < 3:
                continue
            cls = "wall"
            if sem is not None and 0 <= int(sem) < len(sem_surfaces):
                sem_type = sem_surfaces[int(sem)].get("type", "")
                cls = SEMANTIC_MAP.get(sem_type, "wall")
            try:
                ring = vertices[np.asarray(ring_idx, dtype=np.int64)] - origin
            except IndexError:
                log.warning("vertex-index buiten bereik in %s, face overgeslagen", obj_id)
                continue
            faces.append((cls, ring))

        if not faces:
            continue

        pts2d = np.concatenate([ring for _, ring in faces])[:, :2]
        cx, cy = pts2d.mean(axis=0)
        if clip_bounds is not None:
            # de API levert per tegel (ruimer dan gevraagd): clip op centroid
            minx, miny, maxx, maxy = clip_bounds
            if not (minx - 2 <= cx <= maxx + 2 and miny - 2 <= cy <= maxy + 2):
                continue

        # wijkstijl: bouwperiode + projectblok -> muur- en dakkleur (globale
        # RD-coordinaten zodat het blok niet op een tegelrand omklapt)
        wall_style, roof_style = _era_style(
            attrs.get("oorspronkelijkbouwjaar"), attrs.get("b3_dak_type"),
            cx + origin[0], cy + origin[1],
        )
        cls_tint = {
            "roof": np.clip(roof_style * tint, 0, 1.6).astype(np.float32),
            "ground": tint,  # losse vloer/terrasvlakken: neutraal, valt weg in het terrein
        }

        if ground_sampler is not None:
            pts = np.concatenate([ring for _, ring in faces])
            base_z = float(pts[:, 2].min())
            # steekproef over de footprint is genoeg (en snel)
            sample = pts[:: max(1, len(pts) // 32)]
            terrain_min = min(ground_sampler(float(p[0]), float(p[1])) for p in sample)
            drop = base_z - (terrain_min - 0.10)
            if drop > 0.01:  # alleen omlaag snappen, nooit gebouwen optillen
                for _, ring in faces:
                    ring[:, 2] -= drop

        # muurkleur: effen, of per hoogte gesplitst (baksteen onder, stuc boven)
        wall_split = None
        if isinstance(wall_style, dict):
            foot_z = min(float(ring[:, 2].min()) for _, ring in faces)
            wall_split = (
                foot_z + 3.05,  # één woonlaag metselwerk, daarboven stucwerk
                np.clip(wall_style["low"] * tint, 0, 1.6).astype(np.float32),
                np.clip(wall_style["high"] * tint, 0, 1.6).astype(np.float32),
            )
            cls_tint["wall"] = wall_split[1]  # fallback voor niet-muurvlakken
        else:
            cls_tint["wall"] = np.clip(wall_style * tint, 0, 1.6).astype(np.float32)

        for cls, ring in faces:
            if cls == "wall" and wall_split is not None:
                split_z, low, high = wall_split
                for tri in triangulate_polygon(ring):
                    for sub, is_below in _clip_tri_z(tri, split_z):
                        soup.add("wall", sub, low if is_below else high)
                        faces_added += 1
                continue
            soup.add_polygon(cls, ring, cls_tint.get(cls, cls_tint["wall"]))
            faces_added += 1
    return faces_added


def features_to_soup(
    metadata: dict,
    features: list[dict],
    origin_rd: np.ndarray,
    ground_sampler=None,
    clip_bounds: tuple[float, float, float, float] | None = None,
) -> TriangleSoup:
    """CityJSONFeatures van api.3dbag.nl -> TriangleSoup in lokale coordinaten."""
    soup = TriangleSoup()
    meta_transform = (metadata or {}).get("transform")
    origin = np.asarray([origin_rd[0], origin_rd[1], 0.0], dtype=np.float64)

    total_faces = 0
    for feat in features:
        # tolerant uitpakken: CityJSONFeature direct, of genest onder "feature"
        node = feat.get("feature") if isinstance(feat.get("feature"), dict) else feat
        city_objects = node.get("CityObjects")
        if not city_objects:
            continue
        # transform-prioriteit: feature-eigen > pagina (tegel) > dataset-header
        transform = node.get("transform") or feat.get("_page_transform") or meta_transform
        vertices = _transform_vertices(node.get("vertices", []), transform)
        if vertices.size == 0:
            continue
        total_faces += parse_city_objects(
            city_objects, vertices, soup, origin,
            ground_sampler=ground_sampler, clip_bounds=clip_bounds,
        )

    log.info("gebouwen geparsed: %d faces", total_faces)
    return soup


def cityjson_to_soup(cj: dict, origin_rd: np.ndarray) -> TriangleSoup:
    """Volledige CityJSON (bv. 3D BAG download-tile) -> TriangleSoup."""
    soup = TriangleSoup()
    origin = np.asarray([origin_rd[0], origin_rd[1], 0.0], dtype=np.float64)
    vertices = _transform_vertices(cj.get("vertices", []), cj.get("transform"))
    parse_city_objects(cj.get("CityObjects", {}), vertices, soup, origin)
    return soup
