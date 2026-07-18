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


def _points_in_polygon(points: np.ndarray, rings: list[np.ndarray]) -> np.ndarray:
    """Even-odd puntentest binnen EEN polygoon (buitenring + gaten).

    Alleen binnen een polygoon mag even-odd over de ringen XOR'en (zo werken
    gaten); over verschillende polygonen heen moet de UNIE genomen worden,
    anders vallen overlappende vlakken tegen elkaar weg.
    """
    inside = np.zeros(len(points), dtype=bool)
    px, py = points[:, 0], points[:, 1]
    # bbox-voorfilter op de buitenring houdt het snel bij veel kleine vlakken
    outer = rings[0]
    sel = (
        (px >= outer[:, 0].min()) & (px <= outer[:, 0].max())
        & (py >= outer[:, 1].min()) & (py <= outer[:, 1].max())
    )
    if not sel.any():
        return inside
    sx, sy = px[sel], py[sel]
    hit = np.zeros(len(sx), dtype=bool)
    for ring in rings:
        x1s, y1s = ring[:, 0], ring[:, 1]
        x2s, y2s = np.roll(x1s, -1), np.roll(y1s, -1)
        for x1, y1, x2, y2 in zip(x1s, y1s, x2s, y2s):
            if y1 == y2:
                continue
            crosses = (y1 > sy) != (y2 > sy)
            with np.errstate(divide="ignore", invalid="ignore"):
                xcross = (x2 - x1) * (sy - y1) / (y2 - y1) + x1
            hit ^= crosses & (sx < xcross)
    inside[sel] = hit
    return inside


def classify_cells(
    heights: np.ndarray,
    resolution_m: float,
    surfaces: dict[str, list[list[np.ndarray]]],
    origin: np.ndarray,
) -> dict[str, np.ndarray]:
    """Per klasse een boolmasker (rows-1, cols-1) van gridcellen in die vlakken.

    surfaces: klasse -> lijst polygonen ([buitenring, gat, ...]) in absolute
    RD-coordinaten. Binnen een klasse geldt de unie over de polygonen;
    tussen klassen prioriteit: water > road > sand > green.
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
        polygons = surfaces.get(cls) or []
        if not polygons:
            continue
        inside = np.zeros(len(centers), dtype=bool)
        for rings in polygons:
            inside |= _points_in_polygon(centers, rings)
        inside &= ~claimed
        claimed |= inside
        masks[cls] = inside.reshape(rows - 1, cols - 1)
    return masks


# marching-squares vulpolygonen: hoekpunten (x, y) in blok-lokale eenheden.
# hoeken: p00=(0,0) p10=(1,0) p11=(1,1) p01=(0,1); randmiddens mb/mr/mt/ml.
_P00, _P10, _P11, _P01 = (0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)
_MB, _MR, _MT, _ML = (0.5, 0.0), (1.0, 0.5), (0.5, 1.0), (0.0, 0.5)
_MS_POLY = {
    1: [_P00, _MB, _ML],
    2: [_P10, _MR, _MB],
    3: [_P00, _P10, _MR, _ML],
    4: [_P11, _MT, _MR],
    5: [_P00, _MB, _MR, _P11, _MT, _ML],
    6: [_P10, _P11, _MT, _MB],
    7: [_P00, _P10, _P11, _MT, _ML],
    8: [_P01, _ML, _MT],
    9: [_P00, _MB, _MT, _P01],
    10: [_P10, _MR, _MT, _P01, _ML, _MB],
    11: [_P00, _P10, _MR, _MT, _P01],
    12: [_ML, _MR, _P11, _P01],
    13: [_P00, _MB, _MR, _P11, _P01],
    14: [_MB, _P10, _P11, _P01, _ML],
}


def overlay_from_mask(
    heights: np.ndarray,
    resolution_m: float,
    mask: np.ndarray,
    cls: str,
    lift: float,
    normals: np.ndarray | None = None,
) -> Mesh | None:
    """Gedrapeerde mesh uit de gemaskeerde cellen, met gladde randen.

    Marching squares over de celmiddens: de rand ligt op de oude celgrens,
    maar hoeken worden op 45 graden afgesneden — paden en groenvlakken ogen
    als vectorvormen in plaats van blokjes. De maskerrand wordt gerepliceerd
    zodat vlakken tot aan de tegelrand doorlopen (geen naden tussen tegels).
    """
    if not mask.any():
        return None
    if normals is None:
        normals = normals_grid(heights, resolution_m)
    res = resolution_m
    rows, cols = heights.shape
    max_x, max_y = (cols - 1) * res, (rows - 1) * res

    m = np.pad(mask.astype(np.int8), 1, mode="edge")
    r_, c_ = m.shape
    case = (m[:-1, :-1] + 2 * m[:-1, 1:] + 4 * m[1:, 1:] + 8 * m[1:, :-1])

    rng = np.random.default_rng(hash(cls) % (2**32))
    positions, nrm_list, colors, indices = [], [], [], []
    vert_cache: dict[tuple[int, int], int] = {}

    def vertex(x: float, y: float) -> int:
        x = min(max(x, 0.0), max_x)
        y = min(max(y, 0.0), max_y)
        key = (int(round(x * 4)), int(round(y * 4)))  # dedupe op kwartmeters
        idx = vert_cache.get(key)
        if idx is not None:
            return idx
        z = sample_height(heights, res, x, y) + lift
        rr = min(int(round(y / res)), rows - 1)
        cc = min(int(round(x / res)), cols - 1)
        idx = len(positions)
        positions.append((x, y, z))
        nrm_list.append(normals[rr, cc])
        t = 0.94 + 0.06 * rng.random()
        colors.append((t, t, t))
        vert_cache[key] = idx
        return idx

    br, bc = np.nonzero(case)
    for r, c in zip(br, bc):
        poly = _MS_POLY.get(int(case[r, c]))
        if poly is None:  # case 15: vol blok
            poly = [_P00, _P10, _P11, _P01]
        # blok-oorsprong: celmidden (c-1, r-1) van het ongepadde masker
        ox = (c - 0.5) * res
        oy = (r - 0.5) * res
        ids = [vertex(ox + px * res, oy + py * res) for px, py in poly]
        for k in range(1, len(ids) - 1):  # waaier-triangulatie (convex)
            indices.extend((ids[0], ids[k], ids[k + 1]))

    if not indices:
        return None
    return Mesh(
        "class:" + cls, cls,
        np.asarray(positions, dtype=np.float32),
        np.asarray(nrm_list, dtype=np.float32),
        np.asarray(colors, dtype=np.float32),
        np.asarray(indices, dtype=np.uint32),
    )


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
