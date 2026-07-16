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

    label_data = labels.place_labels(addresses, soup, ground)
    (out_dir / "demo-addresses.json").write_text(json.dumps(label_data))

    trees.plant_trees(soup, synthetic.synthetic_tree_positions(SYNTHETIC_SIZE_M), ground)

    overlays = synthetic.synthetic_overlays(heights, SYNTHETIC_RES_M, SYNTHETIC_SIZE_M)
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


def build_real(config_path: Path, out_dir: Path, cache_dir: Path) -> dict:
    from . import fetch_3dbag, fetch_ahn, fetch_bag, fetch_bgt, labels  # lazy: online route

    config = json.loads(config_path.read_text())
    area_id = config["id"]
    if "bbox_rd" in config:
        bbox = [float(v) for v in config["bbox_rd"]]
    elif "locatieserver_query" in config:
        from . import geocode

        x, y, naam = geocode.geocode_rd(config["locatieserver_query"])
        bbox = geocode.bbox_around(x, y, float(config.get("size_m", 500)))
        log.info("gebied %s gecentreerd op %s", area_id, naam)
    else:
        raise ValueError(f"config {area_id} heeft bbox_rd noch locatieserver_query")
    res = float(config.get("terrain", {}).get("resolution_m", 2.0))
    origin = np.array([bbox[0], bbox[1]], dtype=np.float64)
    size_x, size_y = bbox[2] - bbox[0], bbox[3] - bbox[1]
    log.info("gebied %s: bbox %s (%.0fx%.0f m)", area_id, bbox, size_x, size_y)

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

    # 2) gebouwen (3D BAG LoD2.2), gesnapt op het terrein tegen zwevende huizen
    metadata, features = fetch_3dbag.fetch_buildings(bbox, cache_dir / area_id)
    log.info("3dbag: %d features", len(features))
    soup = cityjson.features_to_soup(
        metadata, features, origin,
        ground_sampler=ground, clip_bounds=(0.0, 0.0, size_x, size_y),
    )
    n_tris = sum(len(v) for v in soup.triangles.values())
    if n_tris == 0:
        # een echte wijk zonder één gebouw is vrijwel zeker een fetch/parse-bug;
        # liever falen (CI valt terug op de demo) dan een lege wereld deployen
        raise RuntimeError(
            f"geen gebouw-geometrie voor {area_id} — controleer cache-JSON in {cache_dir / area_id}"
        )

    # 3) ondergronden uit de BGT (tolerant: zonder BGT blijft alles gras)
    surface_masks = {}
    try:
        surfaces = fetch_bgt.fetch_surfaces(bbox, cache_dir / area_id)
        surface_masks = terrain.classify_cells(heights, res, surfaces, origin)
    except Exception as exc:  # noqa: BLE001 — bewuste fallback, wijk blijft bruikbaar
        log.warning("BGT-ondergronden overgeslagen: %s", exc)

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
            label_data = labels.place_labels(raw_addresses, soup, ground)
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
        "name": config.get("name", area_id),
        "file": f"{area_id}.glb",
        "origin_rd": list(origin),
        "bbox_rd": bbox,
        "attribution": "3DBAG (CC BY 4.0, tudelft3d & 3DGI) · AHN/BGT/BAG via PDOK",
    }
    if addresses_file:
        entry["addresses"] = addresses_file
    return entry


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
        lifts = {"sand": 0.03, "road": 0.06, "water": -0.25, "green": 0.02}
        for cls, mask in surface_masks.items():
            mesh = terrain.overlay_from_mask(
                heights, resolution_m, mask, cls, lifts.get(cls, 0.05), normals
            )
            if mesh is not None:
                meshes.append(mesh)
                log.info("ondergrond %s: %d cellen", cls, int(mask.sum()))

    for cls in ("roof", "wall", "ground", "road", "water", "sand", "tree", "trunk"):
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
    manifest_path = args.out / "index.json"
    if manifest_path.exists():
        areas = json.loads(manifest_path.read_text()).get("areas", [])

    if args.synthetic:
        entry = build_synthetic(args.out)
    elif args.config:
        entry = build_real(args.config, args.out, args.cache)
    else:
        parser.error("geef --config of --synthetic op")
        return 2

    areas = [a for a in areas if a.get("id") != entry["id"]] + [entry]
    glb.write_manifest(args.out, areas)
    log.info("manifest bijgewerkt: %s (%d gebieden)", manifest_path, len(areas))
    return 0


if __name__ == "__main__":
    sys.exit(main())
