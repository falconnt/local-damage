"""CRS-hulpfuncties: RD New (EPSG:28992) <-> WGS84 benadering.

Gebaseerd op de gepubliceerde benaderingsformules van Schreutelkamp &
Strang van Hees ("Benaderingsformules voor de transformatie tussen RD- en
WGS84-kaartcoordinaten"), nauwkeurig tot ~1 m — ruim voldoende voor
bbox-queries op open-data-API's. Zo vermijden we een pyproj/GDAL-dependency
voor alleen een bounding box.
"""

X0 = 155000.0
Y0 = 463000.0
LAT0 = 52.15517440
LON0 = 5.38720621


def rd_to_wgs84(x: float, y: float) -> tuple[float, float]:
    """RD New (m) -> (lat, lon) in graden (WGS84-benadering)."""
    dx = (x - X0) * 1e-5
    dy = (y - Y0) * 1e-5

    sum_n = (
        3235.65389 * dy
        + -32.58297 * dx**2
        + -0.24750 * dy**2
        + -0.84978 * dx**2 * dy
        + -0.06550 * dy**3
        + -0.01709 * dx**2 * dy**2
        + -0.00738 * dx
        + 0.00530 * dx**4
        + -0.00039 * dx**2 * dy**3
        + 0.00033 * dx**4 * dy
        + -0.00012 * dx * dy
    )
    sum_e = (
        5260.52916 * dx
        + 105.94684 * dx * dy
        + 2.45656 * dx * dy**2
        + -0.81885 * dx**3
        + 0.05594 * dx * dy**3
        + -0.05607 * dx**3 * dy
        + 0.01199 * dy
        + -0.00256 * dx**3 * dy**2
        + 0.00128 * dx * dy**4
        + 0.00022 * dy**2
        + -0.00022 * dx**2
        + 0.00026 * dx**5
    )
    return LAT0 + sum_n / 3600.0, LON0 + sum_e / 3600.0


def wgs84_to_rd(lat: float, lon: float) -> tuple[float, float]:
    """(lat, lon) in graden -> RD New (m), zelfde benaderingsfamilie (~1 m)."""
    dlat = 0.36 * (lat - LAT0)
    dlon = 0.36 * (lon - LON0)
    x = (
        X0
        + 190094.945 * dlon
        + -11832.228 * dlat * dlon
        + -114.221 * dlat**2 * dlon
        + -32.391 * dlon**3
        + -0.705 * dlat
        + -2.34 * dlat**3 * dlon
        + -0.608 * dlat * dlon**3
        + -0.008 * dlon**2
        + 0.148 * dlat**2 * dlon**3
    )
    y = (
        Y0
        + 309056.544 * dlat
        + 3638.893 * dlon**2
        + 73.077 * dlat**2
        + -157.984 * dlat * dlon**2
        + 59.788 * dlat**3
        + 0.433 * dlon
        + -6.439 * dlat**2 * dlon**2
        + -0.032 * dlat * dlon
        + 0.092 * dlon**4
        + -0.054 * dlat * dlon**4
    )
    return x, y


def rd_bbox_to_wgs84(bbox_rd: list[float]) -> list[float]:
    """[minx, miny, maxx, maxy] RD -> [minlon, minlat, maxlon, maxlat] WGS84.

    Neemt de omhullende van de vier getransformeerde hoekpunten.
    """
    minx, miny, maxx, maxy = bbox_rd
    corners = [
        rd_to_wgs84(minx, miny),
        rd_to_wgs84(minx, maxy),
        rd_to_wgs84(maxx, miny),
        rd_to_wgs84(maxx, maxy),
    ]
    lats = [c[0] for c in corners]
    lons = [c[1] for c in corners]
    return [min(lons), min(lats), max(lons), max(lats)]
