# Local Damage

Een wandelbare 3D-wereld, gegenereerd uit echte Nederlandse open data
(AHN-hoogte + 3D BAG-gebouwen), gerenderd in een lowpoly diorama-stijl
geïnspireerd op *art of rally*: toon-shading, gradient-sky, fog, beperkt
pastelpalet per tijd-van-dag.

**Kernprincipe:** de backend bakt *neutrale* GLB-data (vertex colors +
klasse-metadata), de stijl zit volledig in de client (shaders + palet-JSON).
Daardoor kan dezelfde data-backend later ook Unity/Godot/Unreal voeden.

## Status: MVP stap 1 ✅

- [x] **Stap 1 — één wijk, statisch.** Pipeline: AHN DTM (terrein) + 3D BAG
      LoD2.2 (gebouwen met dakvormen) → één GLB met klasse-meshes. Viewer:
      three.js met walk-controls (desktop + mobiel), toon-shading,
      gradient-skybox, fog, drie tijd-van-dag-paletten. CI bouwt en deployt
      naar GitHub Pages; een synthetische demo-wijk is de fallback als de
      open-data-endpoints haperen.
- [x] **Stap 1b — mobile-first PWA.** Installeerbaar op Android (Chrome →
      menu → *App installeren* / *Toevoegen aan startscherm*): manifest,
      service worker (offline na eerste bezoek), app-iconen, touch-first
      besturing (joystick-uitslag = looptempo), laadbalk, safe-area-UI.
      Startwijk instelbaar per config; geocoding via PDOK Locatieserver
      (default: Bosven, Veghel).
- [ ] Stap 2 — quadtree-tiling + preloading; BGT/OSM-wegen en water.
- [ ] Stap 3 — stylering verfijnen (tilt-shift DoF, bloom, grain, bomen);
      evt. overstap op 3D Tiles + `3d-tiles-renderer`.
- [ ] Stap 4 — engine-integratie (Godot/Unity/Unreal op dezelfde backend).
- [ ] Stap 5 — uitbreiden buiten NL (OSM/Overture + Copernicus DEM).

## Snel starten

```bash
# offline demo-wijk bouwen (geen netwerk nodig)
pip install numpy pygltflib
python -m pipeline.build_area --synthetic --out dist/tiles

# viewer lokaal bekijken
python -m http.server 8000
# open http://localhost:8000/viewer/

# echte wijk bouwen (vergt netwerk + rasterio/requests)
pip install -r pipeline/requirements.txt
python -m pipeline.build_area --config data-sources/bosven-veghel.json --out dist/tiles
```

Een nieuw gebied toevoegen = één JSON'etje in `data-sources/` met een
`locatieserver_query` (bv. `"Marktstraat, Uden"`) of een vaste `bbox_rd`,
en de workflow draaien met die area-naam.

```bash
```

## GitHub Pages activeren (eenmalig)

De workflow `.github/workflows/build-and-deploy.yml` bouwt de wijk en
deployt viewer + tiles. Zet daarvoor in de repo-instellingen
**Settings → Pages → Source: GitHub Actions**. Daarna deployt elke push
(of handmatige run via *Actions → build-and-deploy → Run workflow*).

## Repo-indeling

```
data-sources/   bbox-configs per gebied (RD New / EPSG:28992)
pipeline/       Python: fetch (AHN, 3D BAG) → meshes → GLB + manifest
viewer/         three.js walking-viewer (vendored three.js, geen CDN)
dist/tiles/     gegenereerde GLB's + index.json (demo-fallback gecommit)
docs/           attributie & licenties
```

### Pipeline-conventies

- Coördinaten: RD New, lokaal genuld op de bbox-min; GLB is Y-up
  (conversie `(x, y, z) → (x, z, -y)`).
- Elke mesh heet `class:<klasse>` én draagt `extras.cls`
  (grass/roof/wall/ground/road/water); materialen dragen neutrale
  klasse-kleuren, `COLOR_0` bevat subtiele per-object variatie.
- De viewer herkleurt per klasse via `viewer/palettes/palettes.json`.

## Data & licenties

Gebouwen: [3D BAG](https://3dbag.nl) © tudelft3d & 3DGI (CC BY 4.0) ·
hoogte: [AHN](https://www.ahn.nl) via [PDOK](https://www.pdok.nl).
Zie [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md) voor het volledige overzicht.
De stijl is geïnspireerd op *art of rally* (Funselektor Labs); er is geen
materiaal uit het spel overgenomen.
