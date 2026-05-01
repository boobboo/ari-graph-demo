// SimCity 3000 translation catalogue.
//
// Implements PRD §5.2 (zoning catalogue) and §5.6 (constrained vocabulary).
// Each Azure resource type maps to exactly one zone class and one building
// archetype. New Azure types must fit an existing slot — no novel shapes.
//
// v1 covers what the parser surfaces today (vm, storage, nsg, publicIp).
// Stubs are listed so the next pass (parser extension for Key Vault,
// Recovery Vault, App Service, etc.) can drop straight in.

export type RciClass =
  | 'R-Light' | 'R-Medium' | 'R-Dense'
  | 'C-Light' | 'C-Medium' | 'C-Dense'
  | 'I-Light' | 'I-Medium' | 'I-Dense'
  | 'Civic'   | 'Utility';

export type BuildingArchetype =
  // Residential (R)
  | 'detached_house' | 'townhouse_row' | 'apartment_block'
  // Commercial (C)
  | 'corner_shop' | 'office_low' | 'workshop'
  | 'sorting_office' | 'logistics_centre' | 'market_hall'
  // Industrial (I)
  | 'factory' | 'factory_complex' | 'refinery' | 'steel_mill'
  // Utility
  | 'water_tower' | 'reservoir'
  // Civic (fixed sprites — instantly recognisable across customers)
  | 'transit_hub' | 'police_hq' | 'hospital' | 'fire_station'
  | 'city_hall' | 'school' | 'university' | 'customs' | 'toll_booth';

// Footprint in tile units. PRD §5.6: 1×1, 2×2, 3×3, 4×4 only.
export type Footprint = 1 | 2 | 3 | 4;

export interface CatalogueEntry {
  /** Resource-type discriminator used by the layout/world. Lowercase canonical. */
  type: string;
  zone: RciClass;
  building: BuildingArchetype;
  footprint: Footprint;
  /** Storey-count rule. Receives the resource's raw fields; returns 1..N. */
  storeysFor: (r: ResourceForCatalogue) => number;
  /** Long-form description for tooltips / stats. */
  description: string;
}

/** Subset of a placed resource that catalogue rules can read. */
export interface ResourceForCatalogue {
  vCPU?: number;
  ramGB?: number;
  sku?: string;
  kind?: string;
  tier?: 'hot' | 'cool' | 'archive' | 'unknown';
}

// Stage-progression rule per PRD §5.6: tier letters bias storeys.
// B/Basic = 1 storey, S/Standard = 2, P/Premium = 3, I/Isolated = 4+.
function stageStoreys(sku: string | undefined, base = 1): number {
  if (!sku) return base;
  const s = sku.toLowerCase();
  if (s.startsWith('i') || s.includes('isolated')) return base + 3;
  if (s.startsWith('p') || s.includes('premium'))  return base + 2;
  if (s.startsWith('s') || s.includes('standard')) return base + 1;
  return base;
}

// VM size -> rough industrial scale. The composite vCPU+RAM "tower height"
// the layout already computes is a fine cheap proxy; we re-derive locally
// because the catalogue should not depend on layout state.
function vmStoreys(r: ResourceForCatalogue): number {
  const cpu = r.vCPU ?? 1;
  const ram = r.ramGB ?? 1;
  // Larger of cpu/ram tier wins. Matches "factory grows with size family".
  const score = Math.log2(Math.max(cpu, ram / 4, 1));   // 0 (B1s) → ~6 (M-series)
  return Math.max(2, Math.min(10, Math.round(2 + score * 1.4)));
}

function storageStoreys(r: ResourceForCatalogue): number {
  const sku = (r.sku ?? '').toLowerCase();
  let s = 2;
  if (sku.includes('premium'))                 s += 2;
  if (sku.includes('zrs') || sku.includes('grs')) s += 1;
  if ((r.kind ?? '').toLowerCase().includes('blob')) s += 1;
  if (r.tier === 'archive') s = Math.max(1, s - 1);
  return s;
}

// ---- Catalogue -----------------------------------------------------------
//
// Order matters only for documentation. Lookup is by `type`.

export const CATALOGUE: Record<string, CatalogueEntry> = {
  vm: {
    type: 'vm',
    // PRD says VM = Industrial. Light/Medium/Dense by VM size family —
    // we resolve at render time via storey count, not via separate zones.
    zone: 'I-Medium',
    building: 'factory',
    footprint: 1,
    storeysFor: vmStoreys,
    description: 'Virtual Machine — runs persistent workload (factory)',
  },
  storage: {
    type: 'storage',
    zone: 'Utility',
    building: 'water_tower',
    footprint: 1,
    storeysFor: storageStoreys,
    description: 'Storage Account — bulk state (water tower)',
  },
  nsg: {
    type: 'nsg',
    zone: 'Civic',
    building: 'police_hq',
    footprint: 1,
    storeysFor: () => 2,
    description: 'Network Security Group — checkpoint at the subnet gate',
  },
  publicIp: {
    type: 'publicIp',
    zone: 'Civic',
    building: 'toll_booth',
    footprint: 1,
    storeysFor: () => 1,
    description: 'Public IP — externally routable address (toll booth)',
  },

  // ---- Stubs: parser doesn't surface these yet, but the catalogue is
  // ready so the rendering pass after parser-extension is mechanical.

  appService: {
    type: 'appService',
    zone: 'R-Medium',
    building: 'townhouse_row',
    footprint: 2,
    storeysFor: r => stageStoreys(r.sku, 2),
    description: 'App Service Plan — managed app hosting',
  },
  functionApp: {
    type: 'functionApp',
    zone: 'C-Light',
    building: 'corner_shop',
    footprint: 1,
    storeysFor: r => stageStoreys(r.sku, 1),
    description: 'Function App — event-driven compute',
  },
  logicApp: {
    type: 'logicApp',
    zone: 'C-Light',
    building: 'workshop',
    footprint: 1,
    storeysFor: () => 1,
    description: 'Logic App — workflow automation',
  },
  serviceBus: {
    type: 'serviceBus',
    zone: 'C-Medium',
    building: 'sorting_office',
    footprint: 2,
    storeysFor: r => stageStoreys(r.sku, 2),
    description: 'Service Bus — message broker',
  },
  aks: {
    type: 'aks',
    zone: 'I-Dense',
    building: 'refinery',
    footprint: 3,
    storeysFor: () => 6,
    description: 'AKS / Container Apps — orchestrated containers',
  },
  vmss: {
    type: 'vmss',
    zone: 'I-Medium',
    building: 'factory_complex',
    footprint: 2,
    storeysFor: vmStoreys,
    description: 'VM Scale Set — identical worker fleet',
  },
  databricks: {
    type: 'databricks',
    zone: 'I-Dense',
    building: 'steel_mill',
    footprint: 3,
    storeysFor: () => 5,
    description: 'Databricks / Synapse Spark — heavy data processing',
  },
  sqlDb: {
    type: 'sqlDb',
    zone: 'Utility',
    building: 'reservoir',
    footprint: 2,
    storeysFor: r => stageStoreys(r.sku, 2),
    description: 'SQL DB / Cosmos DB / PostgreSQL — managed database',
  },
  appGateway: {
    type: 'appGateway',
    zone: 'Civic',
    building: 'transit_hub',
    footprint: 2,
    storeysFor: () => 3,
    description: 'Front Door / Application Gateway — public traffic hub',
  },
  apim: {
    type: 'apim',
    zone: 'Civic',
    building: 'market_hall',
    footprint: 2,
    storeysFor: () => 2,
    description: 'API Management — managed API surface',
  },
  keyVault: {
    type: 'keyVault',
    zone: 'Civic',
    building: 'police_hq',
    footprint: 1,
    storeysFor: () => 3,
    description: 'Key Vault — secrets store (police HQ)',
  },
  recoveryVault: {
    type: 'recoveryVault',
    zone: 'Civic',
    building: 'hospital',
    footprint: 2,
    storeysFor: () => 3,
    description: 'Recovery Services Vault — backup & DR (hospital)',
  },
  defender: {
    type: 'defender',
    zone: 'Civic',
    building: 'fire_station',
    footprint: 1,
    storeysFor: () => 2,
    description: 'Defender for Cloud — security response (fire station)',
  },
  logAnalytics: {
    type: 'logAnalytics',
    zone: 'Civic',
    building: 'city_hall',
    footprint: 2,
    storeysFor: () => 3,
    description: 'Azure Monitor / Log Analytics — telemetry (city hall)',
  },
  acr: {
    type: 'acr',
    zone: 'Civic',
    building: 'school',
    footprint: 1,
    storeysFor: () => 2,
    description: 'Container Registry — image library (school)',
  },
  bastion: {
    type: 'bastion',
    zone: 'Civic',
    building: 'customs',
    footprint: 1,
    storeysFor: () => 2,
    description: 'Bastion — secure jump-box (customs)',
  },
};

/** Look up a catalogue entry by canonical resource type. */
export function lookup(type: string): CatalogueEntry | undefined {
  return CATALOGUE[type];
}

// ---- RCI bias for districts ---------------------------------------------
// A district's R/C/I bias is computed from the resources within it. Used by
// the layout to tint the district floor and (later) to drive demand-graph
// dashboards.

export interface RciBias {
  R: number; C: number; I: number;
  /** Dominant zone — used for the district floor tint. */
  primary: 'R' | 'C' | 'I' | 'Mixed';
}

export function computeRciBias(types: string[]): RciBias {
  let R = 0, C = 0, I = 0;
  for (const t of types) {
    const entry = CATALOGUE[t];
    if (!entry) continue;
    const z = entry.zone[0];     // 'R' | 'C' | 'I' | 'C' (Civic) | 'U' (Utility)
    if (z === 'R') R++;
    else if (z === 'I') I++;
    else if (entry.zone.startsWith('C-')) C++;
    // Civic / Utility don't bias the district character.
  }
  const total = R + C + I;
  if (total === 0) return { R: 0, C: 0, I: 0, primary: 'Mixed' };
  const max = Math.max(R, C, I);
  const primary = (max / total) >= 0.55
    ? (max === R ? 'R' : max === C ? 'C' : 'I')
    : 'Mixed';
  return { R: R / total, C: C / total, I: I / total, primary };
}

/** District floor tint by primary zone. */
export const ZONE_TINT: Record<RciBias['primary'], number> = {
  R: 0xc6deb1,   // soft green
  C: 0xb9d4dc,   // soft blue
  I: 0xd6c79a,   // ochre / sandy
  Mixed: 0xc8c8b8,
};
