"""Terrein: AHN-GeoTIFF (of synthetisch grid) -> smooth-shaded grid-mesh."""

from __future__ import annotations

import numpy as np

from .meshes import Mesh


def heights_from_geotiff(path: str, bbox_rd: list[float], resolution_m: float) -> np.ndarray:
    """Lees een AHN DTM GeoTIFF en resample naar een regelmatig grid.

    rasterio wordt lazy geimporteerd zodat de synthetische (offline) route
    geen GDAL-dependency nodig heeft.
    """
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds

    minx, miny, maxx, maxy = bbox_rd
    cols = int(round((maxx - minx) / resolution_m)) + 1
    rows = int(round((maxy - miny) / resolution_m)) + 1

    with rasterio.open(path) as src:
        window = from_bounds(minx, miny, maxx, maxy, src.transform)
        data = src.read(
            1,
            window=window,
            out_shape=(rows, cols),
            resampling=Resampling.bilinear,
            boundless=True,
            fill_value=np.nan,
        ).astype(np.float64)
        nodata = src.nodata

    if nodata is not None:
        data[data == nodata] = np.nan
    # AHN gebruikt vaak extreem grote sentinelwaarden voor nodata
    data[np.abs(data) > 1000] = np.nan
    data = fill_nodata(data)
    # rasters lopen van noord naar zuid; ons grid van zuid naar noord
    return np.flipud(data)


def fill_nodata(grid: np.ndarray) -> np.ndarray:
    """Vul gaten (water, geen returns) met een eenvoudige buurman-verspreiding."""
    grid = grid.copy()
    if not np.isnan(grid).any():
        return grid
    if np.isnan(grid).all():
        return np.zeros_like(grid)
    # iteratief uitsmeren vanaf bekende cellen
    for _ in range(max(grid.shape) * 2):
        nan_mask = np.isnan(grid)
        if not nan_mask.any():
            break
        padded = np.pad(grid, 1, constant_values=np.nan)
        neighbors = np.stack(
            [
                padded[:-2, 1:-1],
                padded[2:, 1:-1],
                padded[1:-1, :-2],
                padded[1:-1, 2:],
            ]
        )
        with np.errstate(invalid="ignore"):
            means = np.nanmean(neighbors, axis=0)
        fillable = nan_mask & ~np.isnan(means)
        grid[fillable] = means[fillable]
    grid[np.isnan(grid)] = float(np.nanmean(grid))
    return grid


def smooth_heights(grid: np.ndarray, passes: int = 1) -> np.ndarray:
    """Lichte box-blur: 'smooth terrain' uit de stijlgids en minder lidar-ruis."""
    g = grid.astype(np.float64)
    for _ in range(passes):
        p = np.pad(g, 1, mode="edge")
        g = (
            p[1:-1, 1:-1] * 4
            + p[:-2, 1:-1]
            + p[2:, 1:-1]
            + p[1:-1, :-2]
            + p[1:-1, 2:]
        ) / 8.0
    return g


def grid_to_mesh(heights: np.ndarray, resolution_m: float, cls: str = "grass") -> Mesh:
    """Regelmatig hoogtegrid -> smooth-shaded mesh in lokale coordinaten.

    heights[row, col] met row = zuid->noord (y), col = west->oost (x).
    """
    rows, cols = heights.shape
    xs = np.arange(cols, dtype=np.float64) * resolution_m
    ys = np.arange(rows, dtype=np.float64) * resolution_m
    xx, yy = np.meshgrid(xs, ys)
    positions = np.column_stack([xx.ravel(), yy.ravel(), heights.ravel()]).astype(np.float32)

    # smooth normalen uit de hoogtegradient
    dzdx = np.gradient(heights, resolution_m, axis=1)
    dzdy = np.gradient(heights, resolution_m, axis=0)
    normals = np.column_stack(
        [(-dzdx).ravel(), (-dzdy).ravel(), np.ones(rows * cols)]
    )
    normals /= np.linalg.norm(normals, axis=1, keepdims=True)

    # subtiele per-vertex variatie zodat grote vlakken niet steriel ogen
    rng = np.random.default_rng(42)
    tint = 0.94 + 0.06 * rng.random((rows * cols, 1))
    colors = np.repeat(tint, 3, axis=1).astype(np.float32)

    # twee driehoeken per gridcel
    idx = np.arange(rows * cols, dtype=np.uint32).reshape(rows, cols)
    a = idx[:-1, :-1].ravel()
    b = idx[:-1, 1:].ravel()
    c = idx[1:, :-1].ravel()
    d = idx[1:, 1:].ravel()
    indices = np.column_stack([a, b, c, b, d, c]).ravel().astype(np.uint32)

    return Mesh("class:" + cls, cls, positions, normals.astype(np.float32), colors, indices)


def normals_grid(heights: np.ndarray, resolution_m: float) -> np.ndarray:
    """(rows, cols, 3) smooth-normalen uit de hoogtegradient."""
    dzdx = np.gradient(heights, resolution_m, axis=1)
    dzdy = np.gradient(heights, resolution_m, axis=0)
    n = np.dstack([-dzdx, -dzdy, np.ones_like(heights)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return n


def _points_in_rings(points: np.ndarray, rings: list[np.ndarray]) -> np.ndarray:
    """Even-odd puntentest over alle ringen samen (gaten werken vanzelf)."""
    inside = np.zeros(len(points), dtype=bool)
    px, py = points[:, 0], points[:, 1]
    for ring in rings:
        # bbox-voorfilter houdt het snel bij veel kleine vlakken
        sel = (
            (px >= ring[:, 0].min()) & (px <= ring[:, 0].max())
            & (py >= ring[:, 1].min()) & (py <= ring[:, 1].max())
        )
        if not sel.any():
            continue
        sx, sy = px[sel], py[sel]
        hit = np.zeros(len(sx), dtype=bool)
        x1s, y1s = ring[:, 0], ring[:, 1]
        x2s, y2s = np.roll(x1s, -1), np.roll(y1s, -1)
        for x1, y1, x2, y2 in zip(x1s, y1s, x2s, y2s):
            if y1 == y2:
                continue
            crosses = (y1 > sy) != (y2 > sy)
            with np.errstate(divide="ignore", invalid="ignore"):
                xcross = (x2 - x1) * (sy - y1) / (y2 - y1) + x1
            hit ^= crosses & (sx < xcross)
        inside[sel] ^= hit
    return inside


def classify_cells(
    heights: np.ndarray, resolution_m: float, surfaces: dict[str, list[np.ndarray]], origin: np.ndarray
) -> dict[str, np.ndarray]:
    """Per klasse een boolmasker (rows-1, cols-1) van gridcellen in die vlakken.

    surfaces: klasse -> ringen in absolute RD-coordinaten. Volgorde van
    prioriteit: water wint van road, road wint van sand.
    """
    rows, cols = heights.shape
    cy, cx = np.mgrid[0 : rows - 1, 0 : cols - 1]
    centers = np.column_stack(
        [
            (cx.ravel() + 0.5) * resolution_m + origin[0],
            (cy.ravel() + 0.5) * resolution_m + origin[1],
        ]
    )
    masks: dict[str, np.ndarray] = {}
    claimed = np.zeros(len(centers), dtype=bool)
    for cls in ("water", "road", "sand", "green"):  # prioriteitsvolgorde
        rings = surfaces.get(cls) or []
        if not rings:
            continue
        inside = _points_in_rings(centers, rings) & ~claimed
        claimed |= inside
        masks[cls] = inside.reshape(rows - 1, cols - 1)
    return masks


def overlay_from_mask(
    heights: np.ndarray,
    resolution_m: float,
    mask: np.ndarray,
    cls: str,
    lift: float,
    normals: np.ndarray | None = None,
) -> Mesh | None:
    """Bouw een gedrapeerde mesh uit de gemaskeerde gridcellen (volgt terrein)."""
    if not mask.any():
        return None
    rows, cols = heights.shape
    if normals is None:
        normals = normals_grid(heights, resolution_m)

    # welke gridknopen zijn in gebruik door de geselecteerde cellen?
    used = np.zeros((rows, cols), dtype=bool)
    cell_r, cell_c = np.nonzero(mask)
    for dr, dc in ((0, 0), (0, 1), (1, 0), (1, 1)):
        used[cell_r + dr, cell_c + dc] = True

    node_index = np.full((rows, cols), -1, dtype=np.int64)
    ur, uc = np.nonzero(used)
    node_index[ur, uc] = np.arange(len(ur))

    positions = np.column_stack(
        [uc * resolution_m, ur * resolution_m, heights[ur, uc] + lift]
    ).astype(np.float32)
    nrm = normals[ur, uc].astype(np.float32)

    rng = np.random.default_rng(hash(cls) % (2**32))
    tint = 0.94 + 0.06 * rng.random((len(ur), 1))
    colors = np.repeat(tint, 3, axis=1).astype(np.float32)

    a = node_index[cell_r, cell_c]
    b = node_index[cell_r, cell_c + 1]
    c = node_index[cell_r + 1, cell_c]
    d = node_index[cell_r + 1, cell_c + 1]
    indices = np.column_stack([a, b, c, b, d, c]).ravel().astype(np.uint32)

    return Mesh("class:" + cls, cls, positions, nrm, colors, indices)


def sample_height(heights: np.ndarray, resolution_m: float, x: float, y: float) -> float:
    """Bilineaire hoogte-sample op lokale (x, y) in meters."""
    rows, cols = heights.shape
    fx = np.clip(x / resolution_m, 0, cols - 1.001)
    fy = np.clip(y / resolution_m, 0, rows - 1.001)
    c0, r0 = int(fx), int(fy)
    tx, ty = fx - c0, fy - r0
    h = (
        heights[r0, c0] * (1 - tx) * (1 - ty)
        + heights[r0, c0 + 1] * tx * (1 - ty)
        + heights[r0 + 1, c0] * (1 - tx) * ty
        + heights[r0 + 1, c0 + 1] * tx * ty
    )
    return float(h)
