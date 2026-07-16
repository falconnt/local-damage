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
