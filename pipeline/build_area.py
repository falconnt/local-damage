"""Orchestrator: bbox-config -> GLB-tegel (MVP stap 1: 1 wijk = 1 GLB).

Gebruik:
  python -m pipeline.build_area --config data-sources/delft-centrum.json --out dist/tiles
  python -m pipeline.build_area --synthetic --out dist/tiles          # offline demo

De echte route haalt AHN (terrein) + 3D BAG LoD2.2 (gebouwen) op; de
synthetische route genereert een fixture-wijk en test dezelfde keten.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

import numpy as np

from . import cityjson, glb, synthetic, terrain, trees
from .meshes import TriangleSoup, soup_to_flat_mesh

log = logging.getLogger("build_area")

SYNTHETIC_SIZE_M = 400.0
SYNTHETIC_RES_M = 2.0


def build_synthetic(out_dir: Path) -> dict:
    from . import labels

    log.info("synthetische demo-wijk bouwen…")
    heights = synthetic.synthetic_heights(SYNTHETIC_SIZE_M, SYNTHETIC_RES_M)
    soup, addresses = synthetic.synthetic_buildings(heights, SYNTHETIC_RES_M, SYNTHETIC_SIZE_M)

    def ground(x: float, y: float) -> float:
        return terrain.sample_height(heights, SYNTHETIC_RES_M, x, y)

    overlays = synthetic.synthetic_overlays(heights, SYNTHETIC_RES_M, SYNTHETIC_SIZE_M)
    road_points = np.array([tri.mean(axis=0)[:2] for tri in overlays.triangles.get("road", [])])
    label_data = labels.place_labels(addresses, soup, ground, road_points=road_points)
    (out_dir / "demo-addresses.json").write_text(json.dumps(label_data))

    trees.plant_trees(soup, synthetic.synthetic_tree_positions(SYNTHETIC_SIZE_M), ground)

    for cls, tris in overlays.triangles.items():
        for tri, tint in zip(tris, overlays.tints[cls]):
            soup.add(cls, tri, tint)

    meshes = assemble_meshes(heights, SYNTHETIC_RES_M, soup)
    out = glb.write_glb(
        meshes,
        out_dir / "demo.glb",
        extras={"area": "demo", "synthetic": True, "size_m": SYNTHETIC_SIZE_M},
    )
    log.info("geschreven: %s (%.1f MB)", out, out.stat().st_size / 1e6)
    return {
        "id": "demo",
        "name": "Demo — synthetische wijk",
        "file": "demo.glb",
        "addresses": "demo-addresses.json",
        "synthetic": True,
        "size_m": SYNTHETIC_SIZE_M,
    }


TILE_M = 500.0  # tegelmaat op het vaste RD-raster (streaming, roadmap stap 2)


def build_tile(
    tile_id: str,
    bbox: list[float],
    res: float,
    out_dir: Path,
    cache_dir: Path,
    require_buildings: bool = True,
) -> dict:
    """Bouw één tegel (GLB + bordjes-JSON) voor de gegeven RD-bbox."""
    from . import fetch_3dbag, fetch_ahn, fetch_bag, fetch_bgt, fetch_luchtfoto, labels  # lazy: online route

    area_id = tile_id
    origin = np.array([bbox[0], bbox[1]], dtype=np.float64)
    size_x, size_y = bbox[2] - bbox[0], bbox[3] - bbox[1]
    log.info("tegel %s: bbox %s (%.0fx%.0f m)", area_id, bbox, size_x, size_y)

    # 1) terrein (AHN DTM); vlak op NAP 0 als fallback
    tif = fetch_ahn.fetch_dtm(bbox, cache_dir / area_id)
    if tif is not None:
        heights = terrain.heights_from_geotiff(str(tif), bbox, res)
        heights = terrain.smooth_heights(heights, passes=1)
        log.info("terrein: %s grid, hoogte %.1f..%.1f m NAP", heights.shape, heights.min(), heights.max())
    else:
        log.warning("geen AHN — vlak terrein op NAP 0 als fallback")
        rows = int(round(size_y / res)) + 1
        cols = int(round(size_x / res)) + 1
        heights = np.zeros((rows, cols))

    def ground(x: float, y: float) -> float:
        return terrain.sample_height(heights, res, x, y)

    # 2) ondergronden uit de BGT (tolerant: zonder BGT blijft alles gras);
    # eerst, want het watermasker stuurt ook de watervilla-gevels
    surface_masks = {}
    try:
        surfaces = fetch_bgt.fetch_surfaces(bbox, cache_dir / area_id)
        surface_masks = terrain.classify_cells(heights, res, surfaces, origin)
    except Exception as exc:  # noqa: BLE001 — bewuste fallback, wijk blijft bruikbaar
        log.warning("BGT-ondergronden overgeslagen: %s", exc)

    water_near = None
    if "water" in surface_masks and surface_masks["water"].any():
        dil = surface_masks["water"].copy()
        for _ in range(9):  # ruitvormige dilatatie: ~18 m van de oever
            d2 = dil.copy()
            d2[1:, :] |= dil[:-1, :]
            d2[:-1, :] |= dil[1:, :]
            d2[:, 1:] |= dil[:, :-1]
            d2[:, :-1] |= dil[:, 1:]
            dil = d2

        def water_near(x, y, _dil=dil, _res=res):
            r, c = int(y // _res), int(x // _res)
            if 0 <= r < _dil.shape[0] and 0 <= c < _dil.shape[1]:
                return bool(_dil[r, c])
            return False

    # 3) gebouwen (3D BAG LoD2.2), gesnapt op het terrein tegen zwevende huizen.
    # De PDOK-luchtfoto levert de echte dakkleur per pand (optioneel).
    metadata, features = fetch_3dbag.fetch_buildings(bbox, cache_dir / area_id)
    log.info("3dbag: %d features", len(features))
    roof_sampler = None
    foto = fetch_luchtfoto.fetch_rgb(bbox, cache_dir / area_id)
    if foto is not None:
        try:
            roof_sampler = fetch_luchtfoto.make_roof_sampler(foto, bbox)
        except Exception as exc:  # pillow ontbreekt / corrupt beeld: stijl-fallback
            log.warning("luchtfoto niet bruikbaar (%s) — bouwperiode-palet als dakkleur", exc)
    soup = cityjson.features_to_soup(
        metadata, features, origin,
        ground_sampler=ground, clip_bounds=(0.0, 0.0, size_x, size_y),
        roof_sampler=roof_sampler, water_near=water_near,
    )
    n_tris = sum(len(v) for v in soup.triangles.values())
    if n_tris == 0:
        if require_buildings:
            # een echte wijk zonder één gebouw is vrijwel zeker een fetch/parse-bug;
            # liever falen (CI valt terug op de demo) dan een lege wereld deployen
            raise RuntimeError(
                f"geen gebouw-geometrie voor {area_id} — controleer cache-JSON in {cache_dir / area_id}"
            )
        # randtegels (weiland/bos) mogen leeg zijn: terrein + BGT blijven waardevol
        log.warning("tegel %s heeft geen gebouwen (weiland?) — doorgaan", area_id)

    # 3b) bomen op begroeid terrein (procedureel, geen open bomendataset)
    if "green" in surface_masks:
        rng = np.random.default_rng(21)
        positions = trees.positions_from_mask(surface_masks["green"], res, rng)
        trees.plant_trees(soup, positions, ground)

    # 4) adressen uit de BAG -> bordjes-JSON (tolerant)
    addresses_file = None
    try:
        raw_addresses = fetch_bag.fetch_addresses(bbox, cache_dir / area_id)
        for addr in raw_addresses:  # naar lokale coordinaten
            addr["x"] -= origin[0]
            addr["y"] -= origin[1]
        if raw_addresses:
            road_points = None
            if "road" in surface_masks:
                rr, cc = np.nonzero(surface_masks["road"])
                road_points = np.column_stack([(cc + 0.5) * res, (rr + 0.5) * res])
            label_data = labels.place_labels(raw_addresses, soup, ground, road_points=road_points)
            addresses_file = f"{area_id}-addresses.json"
            (out_dir / addresses_file).write_text(json.dumps(label_data))
    except Exception as exc:  # noqa: BLE001
        log.warning("BAG-adressen overgeslagen: %s", exc)

    meshes = assemble_meshes(heights, res, soup, surface_masks)
    out = glb.write_glb(
        meshes,
        out_dir / f"{area_id}.glb",
        extras={"area": area_id, "origin_rd": list(origin), "bbox_rd": bbox},
    )
    log.info("geschreven: %s (%.1f MB)", out, out.stat().st_size / 1e6)
    entry = {
        "id": area_id,
        "file": f"{area_id}.glb",
        "origin_rd": list(origin),
        "bbox_rd": bbox,
    }
    if addresses_file:
        entry["addresses"] = addresses_file
    return entry


def build_real(config_path: Path, out_dir: Path, cache_dir: Path) -> dict:
    """Legacy: één losse wijk met vaste bbox (bv. delft-centrum)."""
    config = json.loads(config_path.read_text())
    bbox = [float(v) for v in config["bbox_rd"]]
    res = float(config.get("terrain", {}).get("resolution_m", 2.0))
    entry = build_tile(config["id"], bbox, res, out_dir, cache_dir)
    entry["name"] = config.get("name", config["id"])
    entry["attribution"] = "3DBAG (CC BY 4.0, tudelft3d & 3DGI) · AHN/BGT/BAG via PDOK"
    return entry


def build_region(config_path: Path, out_dir: Path, cache_dir: Path) -> dict:
    """Regio: (2r+1)^2 tegels van TILE_M op het vaste RD-raster rond de query.

    Tegels liggen op rasterveelvouden zodat buren exact aansluiten en
    tile-id's stabiel blijven als de regio later groeit.
    """
    from . import geocode

    config = json.loads(config_path.read_text())
    region_id = config["id"]
    res = float(config.get("terrain", {}).get("resolution_m", 2.0))
    radius = int(config.get("tiles_radius", 1))

    x, y, naam = geocode.geocode_rd(config["locatieserver_query"])
    log.info("regio %s gecentreerd op %s (RD %.0f, %.0f)", region_id, naam, x, y)
    tx0, ty0 = int(x // TILE_M), int(y // TILE_M)

    # tegels van binnen naar buiten bouwen: de kern (spawn) eerst, zodat een
    # afgebroken run altijd een bruikbaar centrum heeft
    offsets = sorted(
        ((dx, dy) for dy in range(-radius, radius + 1) for dx in range(-radius, radius + 1)),
        key=lambda o: max(abs(o[0]), abs(o[1])),
    )

    tiles = []
    failed = []
    for dx, dy in offsets:
        tx, ty = tx0 + dx, ty0 + dy
        tile_id = f"{region_id}_x{tx}_y{ty}"
        bbox = [tx * TILE_M, ty * TILE_M, (tx + 1) * TILE_M, (ty + 1) * TILE_M]
        is_center = dx == 0 and dy == 0
        try:
            entry = build_tile(
                tile_id, bbox, res, out_dir, cache_dir,
                require_buildings=is_center,  # alleen de kern moet raak zijn
            )
        except Exception as exc:  # noqa: BLE001 — 1 hapering mag de regio niet slopen
            if is_center:
                raise  # zonder centrum geen zinvolle spawn: dit is wél fataal
            log.warning("tegel %s overgeslagen: %s", tile_id, exc)
            failed.append(tile_id)
            continue
        entry["tx"], entry["ty"] = tx, ty
        tiles.append(entry)

    log.info("regio %s: %d/%d tegels gebouwd, %d overgeslagen",
             region_id, len(tiles), len(offsets), len(failed))
    if failed:
        log.warning("overgeslagen tegels (volgende run vult ze via de cache aan): %s",
                    ", ".join(failed))

    # buurtenlijst (CBS) voor de startlocatie-kiezer; tolerant bij falen
    from . import fetch_buurten
    region_bbox = [
        (tx0 - radius) * TILE_M, (ty0 - radius) * TILE_M,
        (tx0 + radius + 1) * TILE_M, (ty0 + radius + 1) * TILE_M,
    ]
    buurten = fetch_buurten.fetch_buurten(region_bbox, cache_dir / f"_region_{region_id}")

    return {
        "id": region_id,
        "name": config.get("name", region_id),
        "tile_size_m": TILE_M,
        "spawn_rd": [x, y],
        "tiles": tiles,
        "buurten": buurten,
        "attribution": "3DBAG (CC BY 4.0, tudelft3d & 3DGI) · AHN/BGT/BAG · CBS via PDOK",
    }


def assemble_meshes(
    heights: np.ndarray,
    resolution_m: float,
    soup: TriangleSoup,
    surface_masks: dict | None = None,
):
    """Terrein (smooth) + BGT-ondergrondlagen + soup-klassen (flat)."""
    meshes = [terrain.grid_to_mesh(heights, resolution_m, cls="grass")]

    if surface_masks:
        normals = terrain.normals_grid(heights, resolution_m)
        # alles net boven het terrein: het gras-grid tekent er anders overheen
        # (water stond eerst op -0.25 en was daardoor onzichtbaar)
        lifts = {"sand": 0.03, "road": 0.06, "water": 0.05, "green": 0.02}
        for cls, mask in surface_masks.items():
            mesh = terrain.overlay_from_mask(
                heights, resolution_m, mask, cls, lifts.get(cls, 0.05), normals
            )
            if mesh is not None:
                meshes.append(mesh)
                log.info("ondergrond %s: %d cellen", cls, int(mask.sum()))

    for cls in ("roof", "wall", "trim", "ground", "road", "water", "sand", "tree", "trunk"):
        mesh = soup_to_flat_mesh(soup, cls)
        if mesh is not None:
            meshes.append(mesh)
            log.info("mesh %s: %d driehoeken", cls, len(mesh.indices) // 3)
    return meshes


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, help="gebieds-config (data-sources/*.json)")
    parser.add_argument("--synthetic", action="store_true", help="offline demo-wijk bouwen")
    parser.add_argument("--out", type=Path, default=Path("dist/tiles"))
    parser.add_argument("--cache", type=Path, default=Path(".cache"))
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    args.out.mkdir(parents=True, exist_ok=True)

    areas: list[dict] = []
    regions: list[dict] = []
    manifest_path = args.out / "index.json"
    if manifest_path.exists():
        old = json.loads(manifest_path.read_text())
        areas = old.get("areas", [])
        regions = old.get("regions", [])

    if args.synthetic:
        entry = build_synthetic(args.out)
        areas = [a for a in areas if a.get("id") != entry["id"]] + [entry]
    elif args.config:
        config = json.loads(args.config.read_text())
        if "bbox_rd" in config:
            entry = build_real(args.config, args.out, args.cache)
            areas = [a for a in areas if a.get("id") != entry["id"]] + [entry]
        else:
            entry = build_region(args.config, args.out, args.cache)
            regions = [r for r in regions if r.get("id") != entry["id"]] + [entry]
    else:
        parser.error("geef --config of --synthetic op")
        return 2

    glb.write_manifest(args.out, areas, regions)
    log.info(
        "manifest bijgewerkt: %s (%d gebieden, %d regio's)",
        manifest_path, len(areas), len(regions),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
