"""CityJSON(Seq)-parser: 3D BAG-gebouwen -> driehoeken per semantische klasse.

Ondersteunt zowel een volledige CityJSON (met "CityObjects" + "vertices")
als de CityJSONFeature-items van api.3dbag.nl. De parser is bewust tolerant:
het API-formaat kan per versie licht verschillen.
"""

from __future__ import annotations

import hashlib
import logging

import numpy as np

from .meshes import TriangleSoup

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


def _object_tint(obj_id: str) -> float:
    """Stabiele, subtiele helderheid-variatie per gebouw (0.88-1.0)."""
    digest = hashlib.sha1(obj_id.encode()).digest()
    return 0.88 + 0.12 * (digest[0] / 255.0)


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

        for cls, ring in faces:
            soup.add_polygon(cls, ring, tint)
            faces_added += 1
    return faces_added


def features_to_soup(
    metadata: dict,
    features: list[dict],
    origin_rd: np.ndarray,
    ground_sampler=None,
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
        transform = node.get("transform") or meta_transform
        vertices = _transform_vertices(node.get("vertices", []), transform)
        if vertices.size == 0:
            continue
        total_faces += parse_city_objects(
            city_objects, vertices, soup, origin, ground_sampler=ground_sampler
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
