# PRD: Azure Estate Visualisation — SimCity 3000 Mode

## 1. Context & Problem

Customer Azure estates exported via Azure Resource Inventory (ARI) currently appear as long flat tables and Visio diagrams that no executive reads and no engineer trusts. We want a visualisation that:

- Lets a non-technical stakeholder *see* the estate at a glance and form intuitions about its scale, balance, and health.
- Lets an architect *navigate* it like a map and locate any resource quickly.
- Lets the SWO Managed Services team use the same artefact as a discussion surface in customer reviews.

Two earlier attempts (a contour-map style and an initial SimCity prototype) failed for the same root cause: there was no canonical translation between Azure resource types and the visual vocabulary of the chosen metaphor. Resources became disconnected dots rather than a coherent landscape.

This PRD covers the **SimCity 3000 metaphor**: an isometric city where every Azure resource maps to a building, every Resource Group is a district, every Subscription is a city, and every Region is a state. Connectivity is rendered as roads, rail, power lines, and water mains. Health is rendered as pollution, traffic, and crime overlays.

## 2. Goals

1. Convert an ARI export into a deterministic, legible isometric city scene.
2. Make the metaphor *consistent* — the same Azure resource always maps to the same building class.
3. Make the city *flow* — districts, zones, and networks emerge from data, not from arbitrary placement.
4. Support *overlay toggles* (cost, security findings, traffic, age) the way SimCity 3000 supported its data maps.
5. Render in the browser, no plugins. Export at screenshot quality for customer decks.

## 3. Non-Goals

- Real-time streaming. The input is a point-in-time ARI snapshot.
- A fully playable simulation. SimCity is a metaphor for *legibility*, not a game loop.
- Editing or provisioning. View-only.
- Exhaustive coverage of every Azure resource type at v1. Top ~60 by frequency in SWO customer estates is enough.

## 4. Target Users

- **Customer CFO/COO** at a quarterly review — needs to see scale, cost concentration, sprawl.
- **Customer CTO/Head of Cloud** — needs to see architecture coherence, redundancy, hotspots.
- **SWO Account Lead / Senior Architect** — uses it to drive conversations and proposals.
- **SWO Managed Services Engineer** — uses it as a navigable map of an unfamiliar tenant.

## 5. The Translation Layer (core IP)

This is the load-bearing component of the project. It must be defined as code (a YAML or JSON catalogue) and version-controlled. It maps `(resource_type, sku_tier, classification_tags) → (zone_class, building_class, footprint, height, road_class, utility_dependencies)`.

The catalogue is shared with the OS Cartographic mode — both renderers consume the same `EstateModel`.

### 5.1 Administrative hierarchy

| Azure construct | SimCity construct |
|---|---|
| Tenant | Nation |
| Azure Region | State |
| Subscription | City |
| Resource Group | District / Neighbourhood |
| Resource | Building / Tile |
| Resource tag (`environment`) | Planning overlay (e.g. industrial vs residential bias) |

### 5.2 Zoning catalogue (top resource types)

| Azure resource | Zone | Building class | Height rule |
|---|---|---|---|
| Static Web App | R-Light | Detached house | 1 storey |
| App Service (B/S tier) | R-Medium | Townhouse row | 2–3 storeys by SKU |
| App Service (P/I tier) | R-Dense | Apartment block | 4–8 storeys by SKU |
| Front Door / Application Gateway | Civic | Transit hub | Fixed |
| API Management | Civic | Market hall | By unit count |
| Function App (consumption) | C-Light | Corner shop | 1 storey |
| Function App (premium) | C-Medium | Office (low) | 3 storeys |
| Logic App | C-Light | Workshop | 1 storey |
| Service Bus / Event Grid / Event Hub | C-Medium | Sorting office (with rail siding) | By throughput unit |
| Data Factory / Synapse pipeline | C-Dense | Logistics centre | By IR count |
| Virtual Machine | I-Light → I-Dense | Factory | By VM size family |
| VM Scale Set | I-Medium | Factory complex | By instance count |
| AKS / Container Apps | I-Dense | Refinery / heavy industry | By node count |
| Databricks / Synapse Spark | I-Dense | Steel mill | By node count |
| Storage Account | Utility | Water tower | By capacity tier |
| SQL DB / Cosmos DB / PostgreSQL | Utility | Reservoir | By tier (DTU/RU/vCore) |
| Key Vault | Civic | Police HQ | Fixed |
| Recovery Services Vault | Civic | Hospital | Fixed |
| Defender for Cloud | Civic | Fire station | Fixed |
| Azure Monitor / Log Analytics | Civic | City hall | Fixed |
| Container Registry | Civic | School | Fixed |
| Azure AI / ML Workspace | Civic | University | Fixed |
| Bastion | Civic | Customs / border post | Fixed |
| Public IP / NAT Gateway | Civic | Toll booth | Fixed |

### 5.3 Network and utility catalogue

| Azure construct | SimCity construct |
|---|---|
| VNet | Avenue (district arterial) |
| Subnet | Street (block-level) |
| VNet Peering | Highway interchange |
| ExpressRoute | Interstate |
| VPN Gateway | Border crossing with VPN |
| Private Endpoint / Private Link | Subway tunnel |
| Public Internet egress | Dirt road exit to map edge |
| Identity (Entra) flows | Power grid + power lines |
| Storage / DB access flow | Water mains |
| Diagnostic settings → Log Analytics | Sewage system |

### 5.4 Numeric carriers (for overlays)

Every translated resource must carry the following scalars so overlays render correctly:

- `cost_monthly_gbp` — drives **land value** map
- `utilisation_pct` — drives **traffic** map
- `defender_secure_score_delta` — drives **pollution** map (industrial = severity, commercial = misconfig)
- `unauthorised_attempts_30d` — drives **crime** map
- `age_days` — drives **building wear**
- `change_frequency_30d` — drives **construction/scaffolding** indicator

### 5.6 Design frameworks adopted from SimCity 3000

SimCity 3000 is itself a translation engine — it takes raw tabular state (zone demand, land value, service coverage) and procedurally generates a coherent visual scene from a constrained vocabulary. That is the same shape as our problem, and we get three things by adopting its frameworks rather than inventing our own: a constrained vocabulary that forces deterministic output across runs, a pre-solved aesthetic, and a metaphor most viewers already know how to read.

The catalogue is therefore not a free design exercise. It is a constrained mapping into an existing grammar — new Azure resource types must fit an existing framework slot, not invent a new one.

| SimCity 3000 framework | What it gives us | Azure mapping |
|---|---|---|
| **Tile grid + standardised footprints** (1×1, 2×2, 3×3, 4×4) | Predictable scale, no overlap maths, deterministic placement | SKU family → tile size. VM = 1×1; App Service Plan = 2×2; AKS = 3×3+; Synapse workspace = 4×4 |
| **RCI zone matrix** (Residential / Commercial / Industrial × Light / Medium / Dense) | A nine-cell grammar covering all workloads | Already in §5.2; the *constraint* is the point — every resource must be one of nine, no tenth zone |
| **Stage-based building progression** | Same archetype gets richer as conditions improve | SKU tier = stage. The App Service "shell" grows from cottage → townhouse → tower as B → S → P → I. Removes the need for a separate sprite per SKU |
| **RCI demand graph** | A dashboard idiom every SimCity player recognises | Show estate balance: under-provisioned in integration (commercial) vs presentation (residential)? Real architectural insight in a SimCity-native idiom |
| **Service coverage radii** (police, fire, schools, hospitals) | Visualises *gaps* as well as presence | The killer mapping. Key Vault, Backup, Monitor, Defender each get a coverage radius computed from references. Resources outside the radius render as "underserved" — exactly how SimCity shows neglected neighbourhoods. Ideal Managed Services sales surface |
| **Utility coverage** (power, water) | Foundational dependencies as overlays | Power = identity (Entra / managed identity). No power = blacked-out tile. Water = storage backing. Diegetic representation of fundamental dependencies |
| **Land value heatmap** | Standard colour ramp for "where the value concentrates" | Cost per active unit, biased upward by proximity to civic services and downward by pollution (security findings) |
| **Pollution / crime / traffic overlays** | Toggleable data maps with a shared colour grammar | Defender severity, unauthorised access, network throughput. SimCity supplies the palette |
| **Road hierarchy** (street → road → avenue → highway, with on-ramps) | A graded transport vocabulary already in the viewer's head | Subnet → VNet → peering → ExpressRoute, with NAT / Firewall as on-ramps |
| **Civic buildings with fixed sprites** | Cross-customer recognisability | Key Vault always renders as the *same* police HQ sprite. SWO engineers learn the vocabulary once and it transfers across every customer estate |
| **Landmarks** (Eiffel Tower, Statue of Liberty, etc.) | Special sprites for signature features | Customer-specific signature workloads — SAP S/4HANA, MES, EDW — get bespoke landmark sprites and become navigation anchors |
| **Terrain** (hills, water, trees) | Pre-existing constraints the city must accommodate | Re-render the OS-mode elevation field as terrain. Same `EstateModel`; what is contours in one mode is hills in the other |
| **News ticker / Advisor system** | Diegetic narrative feedback | Auto-generated commentary from Defender, Advisor, Cost Management rendered as in-world news. "Westside Industrial residents complain about congestion" = AKS hitting CPU limits |
| **Ordinances** | Policy levers that visibly modify city behaviour | Azure Policy assignments. Subscription-scoped policy = city-wide ordinance; RG-scoped = district ordinance. Compliance state = ordinance effectiveness |

Four of these are disproportionately high-leverage and warrant specific implementation focus:

1. **Service coverage radii** — best-in-class way to visualise what Managed Services actually does. Coverage gaps become the obvious customer conversation and the obvious sales opportunity.
2. **Stage-based progression** — collapses the SKU explosion into a gradient, not a sprite library. Materially reduces asset-library cost.
3. **Ordinances ↔ Azure Policy** — almost suspiciously well-aligned. Worth a dedicated demo moment.
4. **Demand graph** — gives architects a one-glance read on whether the estate is balanced. Cheap to compute, expensive-looking to show.

## 6. Topology Generation Algorithm

The reason the previous prototype felt "very local" is that it placed buildings independently. The fix is a four-pass layout:

1. **Pass 1 — Region/State frame.** Allocate one rectangular region of the canvas per Azure region in use, sized proportionally to its total cost.
2. **Pass 2 — Subscription/City layout.** Within each region, pack subscriptions as cities using a circle-packing or treemap layout, sized by resource count.
3. **Pass 3 — RG/District layout.** Within each city, lay out resource groups as districts using a squarified treemap. Compute each district's *zoning bias* (R/C/I proportions) from the resource catalogue, and assign a primary character (residential / commercial / industrial / mixed). This single step fixes most of the "local" feel — instead of a building salad you get neighbourhoods with character.
4. **Pass 4 — Building placement within district.** Use a force-directed layout constrained to the district polygon, with edges weighted by network connectivity. Snap to the isometric grid as a final step.

Roads, rails, and pipes are then traced over the connection graph using A* on the grid, with road class chosen by the connection class (peering → highway, private endpoint → subway, etc.).

## 7. Data Model

Input: ARI Excel export + optional Resource Graph JSON for relationships.

Intermediate: `EstateModel` — a normalised graph with nodes (resources, RGs, Subs, Regions) and edges (network, identity, data flow, diagnostic). Shared with OS Cartographic mode.

Output: `CityScene` — list of zoned tiles, buildings, roads, utilities, plus overlay scalar fields per tile.

## 8. Rendering

- **Stack:** Three.js with an orthographic isometric camera. Low-poly building meshes from a fixed library. Tile size ~32px equivalent.
- **Why Three.js over a 2D canvas:** building height encodes SKU and is the easiest way to make scale legible at a glance.
- **Asset library:** ~40 building meshes, hand-modelled or sourced from a CC0 low-poly city pack and re-skinned. One-time investment.
- **Overlay maps:** toggleable as in SimCity 3000 — Cost, Traffic, Pollution, Crime, Land Value, Age, Drift.

## 9. Phases

1. **Translation catalogue v1** as YAML, top 60 resource types, peer-reviewed by two SWO architects. *2 weeks.*
2. **Layout engine** producing a static SVG isometric scene, no overlays. *2 weeks.*
3. **Three.js renderer** with building library and base overlays (cost, traffic). *3 weeks.*
4. **Remaining overlays** (pollution, crime, age, drift) and PNG export. *2 weeks.*
5. **Customer pilot** on three SWO accounts, refine catalogue. *4 weeks.*

## 10. Success Criteria

- A customer CTO who has never seen the tool can correctly identify their three highest-cost districts within 60 seconds.
- A SWO architect can locate any specific named resource within 30 seconds.
- The translation catalogue covers ≥ 95 % of resources by count in the pilot estates.
- The isometric scene renders smoothly (≥ 30 fps) for an estate of up to 5 000 resources on a mid-spec laptop.

## 11. Open Questions

- Do we want building visual style to differentiate by *workload type tag* or only by resource type? (Adds richness but also catalogue burden.)
- Should the catalogue be a SWO product asset, or open-sourced under riverdale/mycroft-agents to encourage community contribution and lock the schema in as a quasi-standard?
- For estates with many regions, is a single canvas enough, or do we need a region-switcher?
