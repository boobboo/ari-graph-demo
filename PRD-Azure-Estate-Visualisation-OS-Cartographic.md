# PRD: Azure Estate Visualisation — Ordnance Survey Cartographic Mode

## 1. Context & Problem

Same source problem as the SimCity PRD: ARI exports are flat and unloved, and earlier attempts at a contour-map visualisation produced a "very local" result that did not flow as a landscape. The diagnosis: a contour map requires a *continuous scalar field*, but resources were being plotted as isolated points without a shared mass-like quantity to interpolate across the plane. There was also no consistent translation between Azure resource types and the cartographic vocabulary (settlements, water, contours, transport, land use), so individual symbols felt arbitrary.

This PRD covers the **Ordnance Survey 1:50 000 (Landranger) metaphor**: a top-down map with named administrative areas, settlement symbology, transport networks, land use shading, and brown contour lines representing a chosen scalar field (default: cost density).

## 2. Goals

1. Convert an ARI export into a legible OS-style map at a glance recognisable as a Landranger sheet.
2. Make the contours actually *flow* across the canvas, not pile up around individual resources.
3. Use a consistent cartographic vocabulary so the same Azure resource type always renders as the same symbol.
4. Allow the elevation field to be reassigned to different scalars (cost, criticality, age, blast radius) without re-laying-out the map.
5. Print well on A3 — the format SWO consultants tend to use in customer workshops.

## 3. Non-Goals

- Real geographic accuracy. The "north" arrow is decorative.
- Real-time. Snapshot-based.
- Interactive editing.
- Full OS symbol parity. We adopt a recognisably Landranger-styled subset.

## 4. Target Users

Same four personas as the SimCity PRD: customer CFO/COO, customer CTO, SWO account lead, SWO engineer. The cartographic mode is preferred for the more analytical end of the audience — architects and senior technical stakeholders who already think in maps and prefer measurement to metaphor.

## 5. The Translation Layer (core IP)

A YAML/JSON catalogue, parallel in structure to the SimCity catalogue. Both modes consume the same `EstateModel`, so this is *one catalogue with two render targets*, not two catalogues.

### 5.1 Administrative hierarchy

| Azure construct | OS construct |
|---|---|
| Tenant | National grid (full sheet frame) |
| Azure Region | Country / large region (e.g. Highland, Lowland) |
| Subscription | County, with name in capitals |
| Resource Group | Parish / settlement, with named label |
| Resource | Point feature (settlement, building, mast, reservoir, etc.) |
| Resource tag (`environment`) | Land use shading variant (production = darker arable, dev = lighter scrub) |

### 5.2 Symbol catalogue (top resource types)

| Azure resource | OS symbol | Size rule |
|---|---|---|
| Virtual Machine | Isolated farmhouse (filled square) | By VM size family |
| VM Scale Set | Hamlet (cluster of squares) | By instance count |
| App Service (B/S) | Village with one church spire | Fixed |
| App Service (P/I) | Town outline | By plan capacity |
| AKS / Container Apps | Built-up area shading | By node count |
| Function App | Isolated building | Fixed |
| Logic App | Footpath junction | Fixed |
| API Management | Market town with market square symbol | By unit |
| Storage Account | Reservoir (blue polygon) | By capacity tier |
| SQL DB / Cosmos / Postgres | Quarry symbol (extractive) | By tier |
| Data Factory / Synapse pipeline | Pumping station + canal junction | By IR count |
| Service Bus / Event Hub / Event Grid | Postal sorting office (PO symbol) | By throughput |
| Key Vault | Castle (fortified) | Fixed |
| Recovery Services Vault | Hospital (H symbol) | Fixed |
| Defender for Cloud | Hilltop fort / lookout | Fixed |
| Azure Monitor / Log Analytics | Triangulation pillar (trig point) | Fixed |
| Container Registry | Granary / silo | Fixed |
| Azure AI / ML | Observatory | Fixed |
| Bastion | Police station (P symbol) | Fixed |
| Application Gateway / Front Door | Toll booth on arterial road | Fixed |
| Public IP | Lighthouse | Fixed |
| Private Endpoint | Bridge (over ravine) | Fixed |

### 5.3 Linear features

| Azure construct | OS feature |
|---|---|
| VNet | Parish boundary (broken line) |
| Subnet | Field boundary (lighter line) |
| VNet Peering | Bridge / fording point between parishes |
| ExpressRoute | Motorway (M-style blue) |
| VPN Gateway | A-road (red) |
| Private Link | Tunnel (dashed) |
| Public internet egress | Track to map edge |
| Data flow (Storage / DB connection) | River (blue line, flowing in dependency direction) |
| Identity flow (Entra) | Power line (pylons) |

### 5.4 Land use shading rules

Land use is computed per RG (parish) from the resource composition:

- **Forest** — predominantly stable resources (no changes 30d, production tag). Mature, settled.
- **Arable** — actively developed RG (frequent deployments, dev/test tags).
- **Moorland** — orphaned or untagged sprawl. Untended.
- **Water (lake)** — RG dominated by storage and database resources.
- **Built-up shading** — RG dominated by compute (App Service plans, AKS, VMSS).
- **Marsh** — RG with high security findings (boggy, hard to traverse).

### 5.5 Numeric carriers (for the elevation field)

Every translated resource carries scalars used to *generate the contours*:

- `cost_monthly_gbp` — default elevation
- `criticality_score` — alternative elevation
- `blast_radius_score` — alternative elevation
- `age_days` — drives erosion / softening of contours
- `change_frequency_30d` — drives slope (steeper = more volatile)

### 5.6 Design frameworks adopted from UK Ordnance Survey

UK Ordnance Survey has spent two centuries refining a cartographic grammar that compresses extraordinary detail into legible sheets. Like SimCity 3000 it is itself a translation engine — survey data into standardised symbols, contours, typography, and colour. Adopting its frameworks rather than inventing our own gives us a closed visual vocabulary, a pre-solved aesthetic, and a frame that British technical audiences already trust.

The catalogue is therefore a constrained mapping into an existing cartographic grammar. New Azure resource types must fit an existing OS slot, not invent a new symbol family.

| OS framework | What it gives us | Azure mapping |
|---|---|---|
| **National Grid (OSGB36) — hierarchical lettered squares** | Every point has an addressable, nestable coordinate; the grid is a *language*, not just a layout | Tenant → 100 km square; Region → 10 km square; Subscription → 1 km square; RG → 100 m square; Resource → point. Render faint blue grid lines; tooltips give each resource's grid reference |
| **Categorised symbol library with consistent treatment within category** | Forces every Azure resource type into an existing visual category; the catalogue can't invent rogue symbols | The *constraint* is the value. You pick from settlement / antiquity / tourist / general / water / vegetation / relief — you do not create a new category |
| **Typography as data** (settlement hierarchy) | Place name *style* tells you what kind of place it is before you read the word | Subscription = bold all-caps serif; RG = caps regular; resource label = title case; environment tag = italic. No legend needed for hierarchy — typography carries it |
| **Transport hierarchy with strict colour + line-weight grammar** | Six-level connection vocabulary, battle-tested for legibility at any scale | Motorway blue = ExpressRoute; primary green = VNet peering; A-road red = VPN gateway; B-road orange = VNet; yellow minor = subnet; white track = same-RG implicit |
| **Rights of way as a separate layer from roads** | A *permissions and access* vocabulary distinct from physical paths — solves a problem network-only diagrams cannot | RBAC and identity flows render as footpaths / bridleways / byways overlaid on the road network. Public footpath (pink dashed) = Reader; bridleway = Contributor; BOAT = Owner. Open Access (mauve overlay) = public-facing endpoints |
| **Trig point / triangulation network** | A spine of named, well-known anchor points that everyone navigates by | Designate spine resources — Hub VNet, central Key Vault, identity tenant root, Log Analytics workspace — and render as numbered trig points. They become the navigation aid for unfamiliar estates |
| **Cartouche / margin information** | The map presents itself as a self-documenting *document* with provenance, not a picture | Sheet number, edition date (snapshot timestamp), survey date, projection (subscription scope), magnetic variation (drift indicator), adjoining sheets (other subscriptions), legend, copyright. The frame matters as much as the face |
| **Scale-tier products** (Road / Landranger / Explorer) | Different zoom levels for different audiences, generated from the *same* survey data | Three pre-set views from one `EstateModel`: 1:250 000 *Road* (executive — Subs and major resources only), 1:50 000 *Landranger* (architect — all RGs and resources), 1:25 000 *Explorer* (engineer — every peering, private endpoint, NSG rule). Resolves the executive-vs-engineer tension |
| **Land cover shading conventions** | A pre-existing palette for ground-state classification, with cross-customer recognisability | Adopt Landranger swatches directly: woodland #B5D4A4, open #FFFFFF, built-up #FFC0B5, water #B5D4F0, open access #C8B5D4. Locks in the exact colour values referenced in §5.4 |
| **Hydrography hierarchy** (spring → stream → river → estuary) | A graded data-flow vocabulary with implied directionality | Spring = data source (event, IoT ingest); stream = single-pipeline flow; river = converged Data Factory; estuary = data warehouse / lake. Width carries volume; tributaries always join the mainstem |
| **Conventional signs and abbreviations** | A terse labelling protocol that survives at small scale | Standardise abbreviations: KV (Key Vault), LA (Log Analytics), AGW (App Gateway), FD (Front Door), AKS, ACR (Container Registry). Same vocabulary across every customer map |
| **Magnetic variation diagram** | A standard idiom for showing drift between three reference frames over time | An inset diagram showing drift between IaC-declared / portal-deployed / actually-running state. Three "norths", just like the original |
| **Boundary line conventions** (national, county, district, parish, field) | A graded administrative-boundary vocabulary that nests cleanly | National = tenant; county = subscription; district = management group; parish = RG; field = subnet. Heavier line for higher level |
| **Spot heights and named features** | The map calls out specific noteworthy points for the eye | Highest-cost resources get labelled *spot heights*; named features get pulled out of the legend onto the face — the SAP S/4 system, the Sentinel workspace, the central Hub VNet |
| **Legend grouped by category** | Self-documenting — every symbol on the sheet appears in the legend | The legend is generated from the catalogue automatically; it cannot drift out of sync with the map |
| **Romer / grid-reference protocol** | A standard way to convert visual position to coordinate | Hover-tooltip gives the grid reference of any point, plus the matching ARM resource ID. The grid reference becomes a *citable* identifier ("the AGW at NJ234567") |

Five of these are disproportionately high-leverage and warrant specific implementation focus:

1. **National Grid** — turns coordinates into a language. "The Front Door at NJ234567 in the Production county" is dramatically more memorable than a UUID, and it becomes a stable reference customers and SWO consultants can use in conversation.
2. **Scale-tier products (Road / Landranger / Explorer)** — same survey data, three pre-built audience views. Resolves the executive-vs-engineer tension that plagues these tools without forcing a redesign per audience.
3. **Rights of way overlaid on roads** — RBAC layer distinct from network layer, on the same map. Killer feature for a Managed Services audience, because access governance is rarely visualised at all in conventional Azure diagrams.
4. **Trig point spine** — a small set of named anchors that orient any viewer immediately on any unfamiliar customer estate.
5. **Cartouche** — frames the map as a *document* with provenance. SWO consultants get a printed sheet that is clearly a report, not a picture, which materially changes how clients receive it.

## 6. Topology Generation Algorithm — making the map *flow*

This is the answer to the "very local" problem. The map must be generated as continuous fields, not assembled from local symbols.

1. **Pass 1 — Boundary layout.** Tessellate the canvas into Subscription areas using a weighted Voronoi partition (weight = total cost). Within each Subscription area, do the same for Resource Groups. This gives parish-shaped polygons that already feel like a map, not a chart.
2. **Pass 2 — Resource placement within parish.** Place each resource at a point inside its RG polygon using a force-directed layout with mild repulsion, then jitter slightly to avoid grid-feel.
3. **Pass 3 — Elevation field.** Build a fine grid (e.g. 1000 × 700 cells) over the canvas. For each resource, deposit its `cost_monthly_gbp` (or whichever scalar is selected) as a 2-D Gaussian kernel centred on its point, with sigma proportional to a chosen smoothing radius. Sum across resources. The result is a continuous elevation field that *flows* — with hills where money concentrates and valleys between them.
4. **Pass 4 — Contour generation.** Apply marching squares (`d3-contour`) to the elevation field at regular intervals. Render contour lines in OS brown, with index contours every 5th line drawn thicker and labelled with the scalar value. A spot height label is placed at each local maximum (typically a Front Door, AKS cluster, or Synapse environment).
5. **Pass 5 — Hydrography.** Trace rivers along data-flow edges, snapping to the steepest descent path on the elevation field where possible. This gives the comforting OS effect of rivers flowing from highland to lowland.
6. **Pass 6 — Land use.** Fill each parish polygon with its land-use shading, computed in §5.4.
7. **Pass 7 — Symbology.** Render point symbols on top, with their OS-style labels in the appropriate font.
8. **Pass 8 — Cartouche.** Add the OS-style border, scale bar (e.g. "1 cm = £1 000/month"), legend, north arrow, and sheet title (`{TenantName} — Sheet 1 of 1`).

The choice of smoothing sigma in Pass 3 is the single most important parameter for "flow". Too small → discrete hummocks around each resource, the original failure mode. Too large → featureless plateau. A sigma of roughly one quarter of the median RG diameter works as a starting heuristic and should be tunable.

## 7. Data Model

Input: ARI Excel + Resource Graph JSON (same as SimCity mode).
Intermediate: shared `EstateModel`.
Output: `MapScene` — polygons (parishes, land use), elevation grid, contour line set, hydrography polylines, point features, linear features, cartouche metadata.

## 8. Rendering

- **Stack:** SVG generated by D3 (`d3-contour`, `d3-geo`, `d3-force`, `d3-voronoi`). Pure SVG keeps it printable, accessible, and easy to embed in PDFs and customer decks.
- **Typography:** A font family that evokes Gill Sans / OS Transport without infringing — Source Sans 3 with adjusted tracking is a workable substitute.
- **Colour:** OS Landranger palette — pink/orange A-roads, blue motorways and water, brown contours, soft greens for forest, ochre for arable, mauve for moor.
- **Output formats:** SVG primary, PNG and PDF derived. A4 and A3 page presets.

## 9. Phases

1. **Translation catalogue v1** (parallel to SimCity catalogue, single source). *2 weeks, overlapping with SimCity catalogue work.*
2. **Boundary and elevation engine** (Voronoi + KDE + marching squares) producing a no-symbol contour map. The deliverable from this phase already proves the "flow" problem is solved. *3 weeks.*
3. **Symbology and land use rendering.** *2 weeks.*
4. **Cartouche, legend, scale bar, print formats.** *1 week.*
5. **Customer pilot** on three SWO accounts, calibrate sigma and palette. *3 weeks.*

## 10. Success Criteria

- A printed A3 sheet given to a customer CTO produces unprompted comments about specific hills or rivers within the first 30 seconds (i.e. the map *reads* without explanation).
- The elevation field has at least 10 distinguishable contour bands across the canvas, with no single resource creating an isolated cone (the "very local" failure mode is gone).
- The translation catalogue is 100 % shared with SimCity mode — no resource type is in one catalogue and not the other.
- The same `EstateModel` produces both the OS map and the SimCity scene with no per-mode preprocessing.

## 11. Open Questions

- Should the elevation default be cost or a composite "importance" score (cost × criticality × traffic)? Defaulting to cost matches the executive narrative, but composite is arguably more useful to architects.
- Do we want a `1:25 000` (Explorer) variant for very small estates that would otherwise look sparse on a Landranger sheet?
- How do we handle estates that span many Azure regions — multiple sheets in a folio, or a single sheet with tinted region backgrounds?
