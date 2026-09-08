# Local Damage → Unreal Engine 5.8 — onderzoek en startinstructies

**Voor wie dit leest:** dit is het overdrachtsdocument voor een Claude Code-sessie die
**lokaal op de Windows-pc** draait, met deze repo als werkmap. Alle onderzoek is al
gedaan; hieronder staat wat er besloten is, wat er klaarstaat en waar je begint.

> **Waarom lokaal?** De Unreal MCP-server luistert op `127.0.0.1:8000` binnen het
> editor-proces. Een Claude-sessie in de cloud kan daar principieel niet bij. Het
> bouwen in de editor gebeurt dus vanaf de pc; de cloud-sessie doet de pijplijn,
> de webviewer en dit plan.

---

## 1. Uitgangspunten

| | |
|---|---|
| **Doelplatform** | Windows-pc (high-end AMD-kaart). Android is een wens voor later, geen doel. |
| **Voorkeur** | Plugins en kant-en-klare assets boven zelfbouw, zeker voor v1. |
| **Handwerk** | Zo min mogelijk. Claude bouwt via MCP; de gebruiker keurt en beslist. |
| **Kern van het spel** | Rijden waar je wilt en stukmaken wat je raakt — de naam is de belofte. |
| **De webversie** | Blijft bestaan zoals hij is. Unreal is een tweede client, geen vervanging. |

De Python-pijplijn verhuist **niet** mee. Die bakt neutrale GLB-tegels met
vertex-kleuren en klasse-metadata; de stijl zat altijd al in de client. Unreal wordt
een tweede client op dezelfde backend.

Belangrijkste gevolg voor de aanpak: in de browser schaalde het werk met het aantal
**objecten**, in Unreal met het aantal **klassen** — en dat zijn er elf.

---

## 2. Wat er nu in de repo staat

```
pipeline/       Python: AHN, 3D BAG, BGT, BAG-adressen, luchtfoto, CBS-buurten → GLB
viewer/         three.js-webclient (blijft bestaan)
dist/tiles/     demo-tegel; de echte tegels staan in de branch `tiles-data`
data-sources/   bbox/geocode-config per gebied
docs/           dit document + attributie
```

**Semantische klassen in elke GLB** (`extras.cls` per mesh, plus materiaalnaam
`class:<klasse>`):

```
grass  roof  wall  trim  ground  road  water  sand  green  tree  trunk
```

`trim` = ramen en deuren. Vertex-kleuren dragen de gebakken kleurvariatie
(bouwperiode, gemeten dakkleur uit luchtfoto, watervilla-wit).

**Coördinaten:** RD New (EPSG:28992), per tegel lokaal genuld op de bbox-min.
GLB is Y-up: `(x, y, z) → (x, z, -y)`. Tegels zijn 500 × 500 m op een vast raster;
de regio is nu 5 × 5 tegels (2,5 × 2,5 km) rond Bosven, Veghel.

### De tegels ophalen

```bash
git fetch origin tiles-data
git worktree add ../local-damage-tiles tiles-data
```

26 GLB's, samen ~186 MB, plus `*-addresses.json` (bordjes), `*-nav.json`
(wegraster) en `index.json` (regio-manifest met tegelposities in RD).

> ⚠️ **Let op:** de tegels in `tiles-data` zijn op dit moment de **kapotte v24-set**
> — zonder wegen, water en bomen. Zie §7 (open punten). Voor de eerste importtest is
> dat geen probleem (gebouwen, daken en terrein zitten erin), maar wacht met het
> importeren van de hele wereld tot de v25-tegels er staan.

---

## 3. Het Unreal-project opzetten

### 3.1 Project aanmaken

| Instelling | Waarde |
|---|---|
| Categorie | **Games** |
| Template | **Blank** |
| Project Defaults | **Blueprint** (geen C++) |
| Target Platform | **Desktop** |
| Quality Preset | **Maximum** |
| Starter Content | **uit** |
| Raytracing | **aan** (nodig voor hardware-Lumen) |
| Naam | `LocalDamage` |

Zet het project **naast** de repo-clone, bijvoorbeeld:

```
D:\projects\local-damage\        <- deze repo (git)
D:\projects\LocalDamage\         <- het Unreal-project (niet in git)
```

Het Unreal-project hoort niet in deze repo: `Binaries/`, `Intermediate/`, `Saved/`
en `DerivedDataCache/` zijn samen tientallen GB. Als je het tóch samen wilt houden,
maak dan eerst een `.gitignore` met die mappen erin.

### 3.2 De MCP-plugin aanzetten

1. **Edit → Plugins**, zoek op `MCP`. De plugin heet **Unreal MCP** in de browser;
   intern (console, `.uplugin`, C++) heet hij `ModelContextProtocol`.
2. Aanvinken. Hij is als **Experimental** gemarkeerd, dus je krijgt een waarschuwing —
   accepteren.
3. **Editor herstarten.**
4. Na de herstart: in de plugin-/projectinstellingen kun je kiezen of de server
   automatisch start. Zet dat aan.
5. Open de console (`~`, of Output Log → Cmd-balk) en draai:
   ```
   ModelContextProtocol.GenerateClientConfig
   ```
   Dat schrijft de clientconfiguratie die Claude Code nodig heeft.
6. **Bekende valkuil:** de server verbindt wel, maar levert geen bruikbare tools tot
   de **toolset-registries** aan staan. Controleer dat in de plugin-instellingen.
   Opnieuw laten pollen kan met:
   ```
   ModelContextProtocol.RefreshTools
   ```
7. Start **Claude Code vanuit de projectmap** (native Windows, niet WSL — anders is
   `localhost` onnodig lastig te bereiken).

De server draait op `http://127.0.0.1:8000/mcp` en biedt honderden tools over 30+
toolsets: actors spawnen, Blueprints bewerken, materialen maken, UMG bouwen,
Sequencer, Niagara, PCG, Control Rig, GAS, automation tests en packagen.

> **Open punt:** één bron stelt dat de plugin een **source build** van de engine
> vereist, een andere beschrijft gewoon aanzetten in de Plugin Browser. Epic's eigen
> documentatie was tijdens het onderzoek niet bereikbaar. Begin met de
> launcher-versie; blijkt een source build nodig, dan komt daar een
> GitHub-koppeling aan je Epic-account bij plus uren compileren.

---

## 4. Beslissing: de visuele richting

**Geen toon-shading.** Die look was een oplossing voor een browserprobleem, geen
artistieke eis.

**Wel: world-aligned (triplanar) materialen, één per semantische klasse.**

Onze meshes hebben **geen UV-mapping** — normaal een blokkade voor fotorealistische
materialen. Triplanar-projectie omzeilt dat volledig: de textuur wordt vanuit de
wereldassen op de geometrie geprojecteerd, zonder UV-layout. Dus:

| Klasse | Materiaal |
|---|---|
| `wall` | baksteen / stucwerk |
| `roof` | dakpan |
| `road` | asfalt |
| `sand` | zand / grind |
| `grass`, `green` | gras, ruigte |
| `water` | wateroppervlak |
| `trim` | glas + donker kozijn |
| `tree`, `trunk` | blad, bast |
| `ground` | erf / bestrating |

Elf materialen instellen en **elk gebouw in Nederland is voor altijd aangekleed**.
Texturen komen uit **Megascans op Fab** — gratis onder de standaardlicentie.
Lumen + MegaLights (in 5.8 production-ready) doen de belichting; Nanite slikt de
geometrie ongewijzigd.

Verwachting eerlijk houden: dit wordt geen fotorealisme. De gebouwen zijn
massa-modellen uit de 3D BAG — blokvormen met een dakvorm. Met echte materialen en
echte belichting krijg je het beeld van een **zeer goed belichte maquette**. Dat past
bij het spel en kost de minste inspanning voor het grootste verschil.

De vertex-kleuren die de pijplijn al bakt (bouwperiode, gemeten dakkleuren) kunnen als
kleurmodulatie over het materiaal blijven meelopen — dan houdt de wijk zijn echte
kleurstelling.

---

## 5. Beslissing: destructie in drie lagen

Alles op één manier kapotmaakbaar maken loopt vast op schaal: 25 tegels ≈ 23.000
panden, die kun je niet allemaal vooraf fractureren.

### Laag 1 — straatmeubilair (eerst bouwen)

Paaltjes, hekjes, containers, bankjes, verkeersborden, lantaarnpalen. Een handvol
herbruikbare, vooraf gefractureerde Geometry Collections, door **PCG** langs de
wegdata gestrooid die we al hebben. Dit is waar het beuken bevredigend wordt en het
kost bijna niets, want het zijn steeds dezelfde tien assets.

Deze objecten bestaan nu nog **niet** in onze wereld — dit is dus ook zonder schade al
winst voor het straatbeeld.

### Laag 2 — gebouwen (schade op afroep)

Panden blijven gewone Nanite-static-meshes tot ze hard genoeg geraakt worden; pas dan
wisselt dat ene gebouw naar een gefractureerde versie en neemt Chaos het over.

**Kans die specifiek voor dit project geldt:** wij genereren die gebouwen zelf. In
plaats van te leunen op Unreal's Fracture Mode (waarvan batch-automatisering via
Python onduidelijk is) kan `pipeline/cityjson.py` de panden **vóór-gesplitst**
uitleveren — per gevelvlak, per verdieping, per paneel. Dan is de "fractuur" een
extra bak-stap bij ons en hoeft er in de editor niets handmatigs te gebeuren.

### Laag 3 — terrein en blijvende sporen

Remsporen, kraters en puin als decals plus losse actors. Voor schade die blijft staan
zijn **Runtime Data Layers** van World Partition het juiste gereedschap — Epic
beschrijft die functie letterlijk als "een locatie begint intact en toont later
beschadigde gebouwen".

---

## 6. Onderdeel voor onderdeel

| Onderdeel | Aanpak in UE 5.8 | Kosten |
|---|---|---|
| Datapijplijn | Ongewijzigd; levert dezelfde GLB-tegels | hergebruik |
| Terrein | Mesh Terrain (nieuw in 5.8, mesh i.p.v. heightmap) | hergebruik |
| Tile-streaming | World Partition runtime-grid; onze streaming-code vervalt | ingebouwd |
| Materialen | 11 triplanar-materialen, gestuurd door `extras.cls` | eenmalig |
| Belichting | Hardware-Lumen + MegaLights op vol; Lumen Lite is de mobiele stand | ingebouwd |
| Bomen & groen | Megaplants (gratis, Nanite) via PCG op de BGT-groenvlakken | gratis asset |
| Straatmeubilair | PCG-scatter langs de wegdata; Fab-props als bron | asset + graph |
| Auto rijden | Chaos Vehicles of een kant-en-klaar voertuigpakket van Fab | plugin |
| Autoschade | Bestaande deformatie-plugin (Fab, ± €35–50) | plugin |
| Objectschade | Chaos Destruction; vóór-gesplitste meshes uit onze pijplijn | pijplijn-stap |
| Persistente schade | Runtime Data Layers | ingebouwd |
| Navigatie | NavMesh vervangt onze A*-router en het nav-raster | ingebouwd |
| Minimap | SceneCapture2D van bovenaf, of onze plattegrond-aanpak in UMG | klein |
| Stickman-ragdoll | Chaos PhysicsAsset — beter dan onze Verlet-constructie | upgrade |
| Spelmodi | Blueprints; logica opnieuw, ontwerp bekend | herbouw |
| Bordjes & labels | Text render / UMG in wereldruimte, gevoed door onze adres-JSON | klein |
| Android-build | Mogelijk op high-end toestellen (Vulkan SM5), experimenteel | later |

**Belangrijk bij importeren:** zet **Vertex Color Import Option** op **Replace** in de
Common Meshes-sectie, anders gaan onze gebakken kleuren verloren.

---

## 7. Fasering

### Fase 0 — verifiëren (begin hier)
- Werkt de MCP-plugin met de launcher-versie, of is een source build nodig?
- Eén tegel importeren en controleren of de vertex-kleuren goed doorkomen.

**Poort:** draait MCP en staat er een tegel in beeld?

### Fase 1 — de look (het echte go/no-go)
Eén tegel, elf materialen, Lumen aan. Ziet deze ene straat er goed uit, dan is de rest
doorzetten. Zo niet, dan hebben we een dag verloren in plaats van een maand.

**Poort:** is dit mooier dan de browserversie?

### Fase 2 — de wereld
Alle tegels in World Partition, streaming afgesteld, groen en straatmeubilair via PCG.

### Fase 3 — rijden
Voertuigpakket, besturing, schade-plugin koppelen.

### Fase 4 — stukmaken
Laag 1 eerst (paaltjes, hekjes), daarna gebouwen met vóór-gesplitste geometrie.

### Fase 5 — spel eromheen
Modi, navigatie, minimap, bordjes.

### Later — Android
Kwaliteitsstanden terugschroeven, texturen verkleinen, destructiebudget beperken.

---

## 8. Open punten en risico's

**De v25-build is gefaald — de tegels zijn nog de kapotte v24-set.**
PDOK's BGT-API geeft 404 op alle geprobeerde adressen
(`/lv/bgt/ogc/v1`, `/v1_0`, `/features/v1`), terwijl de documentatie zegt dat het
adres klopt. Opvallend: onze andere PDOK-bronnen op `service.pdok.nl` werken prima,
alleen `api.pdok.nl` doet dit — dat wijst eerder op een blokkade of verhuizing dan op
een verkeerde URL. Zonder BGT geen wegen, water, zand, groen en bomen.
**Dit moet opgelost voordat de hele wereld geïmporteerd wordt.**

**Source build voor de MCP-plugin?** Zie §3.2. Fase 0, punt één.

**Batch-fractuur via Python.** De Python-API kent `unreal.GeometryCollection`, maar of
Fracture Mode volledig scriptbaar is voor honderden panden is onduidelijk. Daarom
leunt het plan op vóór-splitsen in onze eigen pijplijn — dat omzeilt de vraag.

**Lumen op AMD.** Hardware-Lumen werkt, maar flikkerartefacten zijn een bekend euvel op
AMD-kaarten en raytracing-zware scenes liggen wat achter op NVIDIA. Waarschijnlijk af
te stellen; goed om te weten vóór we het aan onze eigen belichting wijten.

**Schaal van de destructie.** Schade-op-afroep voor 23.000 panden is theorie. Hoeveel
brokstukken er tegelijk mogen leven weten we pas in fase 4.

**Android is nog geen belofte.** Lumen op mobiel is expliciet experimenteel en vereist
Vulkan SM5 via de desktop-renderer. Of Chaos-destructie daar speelbaar blijft is open.

---

## 9. Bronnen

- [Unreal Engine 5.8 — releasenotes](https://www.unrealengine.com/news/unreal-engine-5-8-is-now-available) (uitgebracht 17 juni 2026)
- [Unreal MCP in Unreal Editor](https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor)
- [World Partition](https://dev.epicgames.com/documentation/unreal-engine/world-partition-in-unreal-engine)
- [Geometry Collections](https://dev.epicgames.com/documentation/unreal-engine/geometry-collections-user-guide) · [Dataflow for Destruction](https://dev.epicgames.com/documentation/unreal-engine/dataflow-for-destruction-quickstart)
- [PCG-framework](https://dev.epicgames.com/documentation/en-us/unreal-engine/procedural-content-generation-framework-in-unreal-engine)
- [glTF importeren in Unreal](https://dev.epicgames.com/documentation/en-us/unreal-engine/importing-gltf-files-into-unreal-engine)
- [Megascans & Megaplants op Fab](https://quixel.com/news/quixel-on-fab-new-megascans-and-megaplants) · [Fab — physics-plugins](https://www.fab.com/category/tool-and-plugin/physics)
- [Lumen op mobiel (experimenteel)](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-lumen-global-illumination-on-mobile-in-unreal-engine) · [Lumen-flikkering op AMD](https://bugnet.io/blog/how-to-debug-unreal-lumen-flickering-on-amd-gpus)

> Epic's documentatiedomein was tijdens het onderzoek geblokkeerd door de
> netwerkproxy van de cloud-omgeving. De MCP-details komen daarom uit zoekresultaten
> en secundaire beschrijvingen. Verifieer §3.2 tegen de echte editor.
