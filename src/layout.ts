// SimCity 3000 layout (PRD §6).
//
// Four-pass layout:
//   1. Region rectangles (one per Azure region in use)
//   2. Subscription rectangles within each region
//   3. ResourceGroup district rectangles within each subscription (treemap-ish)
//   4. Buildings within each district, placed by catalogue footprint
//
// Network topology is then overlaid: VNets become avenues threading through
// subnet centroids that we derive from where the buildings ended up. RGs are
// the physical home of every resource; VNets/Subnets are network-only and do
// NOT drive placement in this mode.
//
// v1 uses simple proportional-grid packing rather than full squarified
// treemap or force-directed placement (PRD §6 — deferred).

import type {
  Graph, World,
  Vm, Vnet, Subnet, Peering,
  PlacedRegion, PlacedSubscription, PlacedResourceGroup,
  PlacedVm, PlacedSubnet, PlacedVnet,
  PlacedNic, PlacedNsg, PlacedPublicIp, PlacedStorage, PlacedOther,
} from './types';
import { lookup as lookupCatalogue, ZONE_TINT } from './catalogue';
import {
  carriersForVm, carriersForStorage, carriersForNsg, carriersForPublicIp,
  carriersForOther, coverageFor,
} from './carriers';

// Tile size in world units. A 1x1 building occupies one tile; a 2x2 occupies
// four tiles (a 2x2 square). PRD §5.6 fixes footprints at 1, 2, 3, 4.
const TILE = 3.0;
const TILE_GAP = 0.5;             // a small kerb gap between tiles
const RG_PADDING = 4;
const SUB_PADDING = 6;
const REGION_PADDING = 12;
const RG_GAP = 6;
const SUB_GAP = 12;
const REGION_GAP = 24;

// ---- Helpers -----------------------------------------------------------
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function gridSide(n: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, n))));
}

// FNV-1a-ish hash → 0..1, used for VNet road colours.
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

function vnetColor(name: string): number {
  const hue = hash01(name);
  const h = hue * 360;
  const s = 0.55, l = 0.42;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)        { r = c; g = x; }
  else if (h < 120)  { r = x; g = c; }
  else if (h < 180)  { g = c; b = x; }
  else if (h < 240)  { g = x; b = c; }
  else if (h < 300)  { r = x; b = c; }
  else               { r = c; b = x; }
  return (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
}

const rgIdOf = (sub: string, rg: string) => norm(`${sub || '(no subscription)'}::${rg || '(no rg)'}`);

// ---- Pass 4: building tiles inside one RG -----------------------------
interface Building {
  refType: string;               // catalogue key: 'vm' | 'storage' | 'nsg' | 'publicIp' | 'keyVault' | ...
  refId: string;
  footprint: number;             // 1..4 from catalogue
  storeys: number;
  zone: string;
  building: string;
  /** Sort key so similar zones cluster within the RG. */
  zoneSortKey: number;
}

const ZONE_ORDER: Record<string, number> = {
  'R-Light': 0, 'R-Medium': 1, 'R-Dense': 2,
  'C-Light': 3, 'C-Medium': 4, 'C-Dense': 5,
  'I-Light': 6, 'I-Medium': 7, 'I-Dense': 8,
  'Civic':   9, 'Utility':  10,
};

function buildingFor(refType: string, r: { sku?: string; vCPU?: number; ramGB?: number; kind?: string; tier?: 'hot'|'cool'|'archive'|'unknown' }): Omit<Building, 'refId'> | null {
  const entry = lookupCatalogue(refType);
  if (!entry) return null;
  return {
    refType,
    footprint: entry.footprint,
    storeys: entry.storeysFor(r),
    zone: entry.zone,
    building: entry.building,
    zoneSortKey: ZONE_ORDER[entry.zone] ?? 99,
  };
}

interface RgPlacement {
  width: number;               // X extent of the RG (world units)
  depth: number;               // Z extent
  slots: Map<string, [number, number, number]>;  // refId -> [x, z, footprintTiles]
}

/**
 * Place a list of buildings inside a single RG using a row-major grid.
 * Each row's height is the max footprint of buildings in that row.
 * Returns local positions (relative to the RG centre).
 */
function placeBuildings(buildings: Building[]): RgPlacement {
  if (buildings.length === 0) {
    return { width: TILE * 2 + RG_PADDING * 2, depth: TILE * 2 + RG_PADDING * 2, slots: new Map() };
  }
  // Sort so the same zones cluster (R together, I together, civic at the edge).
  const sorted = [...buildings].sort((a, b) =>
    a.zoneSortKey - b.zoneSortKey || b.footprint - a.footprint
  );

  // Decide a target row width in tile units. Aim for ~sqrt(totalTiles).
  const totalTiles = sorted.reduce((s, b) => s + b.footprint * b.footprint, 0);
  const targetCols = Math.max(2, Math.ceil(Math.sqrt(totalTiles) * 1.1));

  // Pack row-by-row left-to-right.
  let row = 0, col = 0, rowHeight = 0, maxRowEnd = 0;
  const placements: Array<{ b: Building; row: number; col: number; rowH: number }> = [];
  for (const b of sorted) {
    if (col + b.footprint > targetCols && col > 0) {
      // wrap to next row
      row += rowHeight;
      col = 0;
      rowHeight = 0;
    }
    rowHeight = Math.max(rowHeight, b.footprint);
    placements.push({ b, row, col, rowH: 0 /* filled after row settles */ });
    col += b.footprint;
    if (col > maxRowEnd) maxRowEnd = col;
  }
  // The last row's height was the active rowHeight.
  let totalRows = row + rowHeight;

  // Convert tile coords to world units.
  const widthTiles = Math.max(maxRowEnd, 1);
  const depthTiles = Math.max(totalRows, 1);
  const tilePitch = TILE + TILE_GAP;
  const width = widthTiles * tilePitch + RG_PADDING * 2;
  const depth = depthTiles * tilePitch + RG_PADDING * 2;
  const originX = -width / 2 + RG_PADDING + tilePitch / 2;
  const originZ = -depth / 2 + RG_PADDING + tilePitch / 2;

  const slots = new Map<string, [number, number, number]>();
  for (const p of placements) {
    // Centre the building's footprint inside its tile span.
    const cx = originX + (p.col + (p.b.footprint - 1) / 2) * tilePitch;
    const cz = originZ + (p.row + (p.b.footprint - 1) / 2) * tilePitch;
    slots.set(p.b.refId, [cx, cz, p.b.footprint]);
  }
  return { width, depth, slots };
}

export function buildWorld(graph: Graph): World {
  // ---- Build the per-RG building list -----------------------------------
  // Every parsed resource (VM, Storage, NSG, PIP) becomes a building inside
  // its (subscription::rg) district. Resources that lack an RG are pooled
  // into a synthetic "(no rg)" district per subscription.
  const buildingsByRg = new Map<string, Building[]>();
  const pushBuilding = (subName: string, rgName: string, b: Building | null) => {
    if (!b) return;
    const id = rgIdOf(subName, rgName);
    if (!buildingsByRg.has(id)) buildingsByRg.set(id, []);
    buildingsByRg.get(id)!.push(b);
  };
  for (const v of graph.vms) {
    const proto = buildingFor('vm', v);
    if (!proto) continue;
    pushBuilding(v.subscription, v.rg, { ...proto, refId: v.id });
  }
  for (const s of graph.storage) {
    const proto = buildingFor('storage', s);
    if (!proto) continue;
    pushBuilding(/* sub will be inferred from the RG hierarchy */ '', s.rg, { ...proto, refId: s.id });
  }
  for (const n of graph.nsgs) {
    const proto = buildingFor('nsg', {});
    if (!proto) continue;
    pushBuilding('', n.rg, { ...proto, refId: n.id });
  }
  for (const p of graph.publicIps) {
    const proto = buildingFor('publicIp', {});
    if (!proto) continue;
    pushBuilding('', p.rg, { ...proto, refId: p.id });
  }
  // Phase 2: every Other resource gets a building too, looked up by its kind.
  for (const o of graph.others) {
    // Skip kinds we explicitly don't draw (purely metadata):
    // - managedIdentity (intangible identity badge)
    // - availabilitySet (org grouping; future: render as a fence around member VMs)
    // - routeTable (per-RG, too many; future: as a road sign at the gate)
    if (o.kind === 'managedIdentity' || o.kind === 'availabilitySet' || o.kind === 'routeTable') continue;
    const proto = buildingFor(o.kind, { sku: o.sku });
    if (!proto) continue;
    pushBuilding(o.subscription, o.rg, { ...proto, refId: o.id });
  }
  // Resources with no subscription resolve to whatever subscription their RG
  // ended up in (parser already propagates subscription per RG when possible).
  // Re-key buckets that landed under "(no subscription)" but now belong to a
  // resolved RG.
  const rgIdAlias = new Map<string, string>();      // rough → canonical
  for (const rg of graph.resourceGroups) {
    rgIdAlias.set(rgIdOf('', rg.name), rg.id);
    rgIdAlias.set(rg.id, rg.id);
  }
  const reKeyed = new Map<string, Building[]>();
  for (const [id, bs] of buildingsByRg) {
    const canonical = rgIdAlias.get(id) ?? id;
    if (!reKeyed.has(canonical)) reKeyed.set(canonical, []);
    reKeyed.get(canonical)!.push(...bs);
  }

  // ---- Pass 4 (per RG): compute placements ------------------------------
  const rgPlacements = new Map<string, RgPlacement>();
  for (const rg of graph.resourceGroups) {
    rgPlacements.set(rg.id, placeBuildings(reKeyed.get(rg.id) ?? []));
  }

  // ---- Pass 3: Squarified treemap of RGs inside each Subscription ------
  // Per PRD §6: districts inside a city laid out as a squarified treemap so
  // RGs of very different sizes still tile cleanly with low aspect-ratio.
  interface SubPlacement { width: number; depth: number; rgs: Array<{ rgId: string; cx: number; cz: number; w: number; d: number }>; }
  const subPlacements = new Map<string, SubPlacement>();
  for (const sub of graph.subscriptions) {
    const rgs = sub.rgIds.map(id => graph.resourceGroups.find(r => r.id === id)).filter((x): x is NonNullable<typeof x> => Boolean(x));
    if (rgs.length === 0) {
      subPlacements.set(sub.id, { width: TILE * 4, depth: TILE * 4, rgs: [] });
      continue;
    }
    // Each RG's natural size from Pass 4. We treat its area as the treemap
    // weight, then squarify into a bounding box whose total area matches the
    // sum (plus padding for kerbs).
    const items = rgs.map(rg => {
      const p = rgPlacements.get(rg.id) ?? { width: TILE * 2, depth: TILE * 2, slots: new Map() };
      return { rgId: rg.id, w: p.width, d: p.depth, area: p.width * p.depth };
    });
    const totalArea = items.reduce((s, it) => s + it.area, 0);
    // Choose an aspect ratio close to 1 by deriving the bounding box dim.
    const sideLen = Math.sqrt(totalArea) * 1.18 + RG_GAP * Math.sqrt(items.length);
    const placed = squarifiedTreemap(items, sideLen, sideLen);
    const usedW = placed.reduce((m, p) => Math.max(m, p.cx + p.w / 2), -Infinity) -
                  placed.reduce((m, p) => Math.min(m, p.cx - p.w / 2),  Infinity);
    const usedD = placed.reduce((m, p) => Math.max(m, p.cz + p.d / 2), -Infinity) -
                  placed.reduce((m, p) => Math.min(m, p.cz - p.d / 2),  Infinity);
    subPlacements.set(sub.id, {
      width: usedW + SUB_PADDING * 2,
      depth: usedD + SUB_PADDING * 2,
      rgs: placed,
    });
  }

  // ---- Pass 2: Subscriptions within Region ------------------------------
  interface RegionPlacement { width: number; depth: number; subs: Array<{ subId: string; cx: number; cz: number }>; }
  const regionPlacements = new Map<string, RegionPlacement>();
  for (const region of graph.regions) {
    const subs = region.subIds.map(id => graph.subscriptions.find(s => s.id === id)).filter((x): x is NonNullable<typeof x> => Boolean(x));
    if (subs.length === 0) {
      regionPlacements.set(region.id, { width: TILE * 4, depth: TILE * 4, subs: [] });
      continue;
    }
    const maxW = Math.max(...subs.map(s => subPlacements.get(s.id)?.width ?? TILE * 4));
    const maxD = Math.max(...subs.map(s => subPlacements.get(s.id)?.depth ?? TILE * 4));
    const cellW = maxW + SUB_GAP;
    const cellD = maxD + SUB_GAP;
    const cols = gridSide(subs.length);
    const rows = Math.ceil(subs.length / cols);
    const innerW = cols * cellW - SUB_GAP;
    const innerD = rows * cellD - SUB_GAP;
    const originX = -innerW / 2 + maxW / 2;
    const originZ = -innerD / 2 + maxD / 2;
    const placed: Array<{ subId: string; cx: number; cz: number }> = [];
    subs.forEach((sub, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      placed.push({ subId: sub.id, cx: originX + c * cellW, cz: originZ + r * cellD });
    });
    regionPlacements.set(region.id, {
      width: innerW + REGION_PADDING * 2,
      depth: innerD + REGION_PADDING * 2,
      subs: placed,
    });
  }

  // ---- Pass 1: Regions in a row -----------------------------------------
  const regionList = graph.regions;
  const regionMaxW = Math.max(...regionList.map(r => regionPlacements.get(r.id)?.width ?? TILE * 4), TILE * 4);
  const regionMaxD = Math.max(...regionList.map(r => regionPlacements.get(r.id)?.depth ?? TILE * 4), TILE * 4);
  const regionCols = gridSide(regionList.length);
  const regionRows = Math.ceil(regionList.length / regionCols);
  const regionPitchX = regionMaxW + REGION_GAP;
  const regionPitchZ = regionMaxD + REGION_GAP;
  const regionInnerW = regionCols * regionPitchX - REGION_GAP;
  const regionInnerD = regionRows * regionPitchZ - REGION_GAP;
  const regionOriginX = -regionInnerW / 2 + regionMaxW / 2;
  const regionOriginZ = -regionInnerD / 2 + regionMaxD / 2;

  // ---- Now compose absolute world positions for everything --------------
  const placedRegions: PlacedRegion[] = [];
  const placedSubs: PlacedSubscription[] = [];
  const placedRgs: PlacedResourceGroup[] = [];

  // Map refId -> its absolute world (x, z) and the RG it belongs to.
  const buildingPos = new Map<string, { x: number; z: number; rgId: string; footprint: number }>();

  regionList.forEach((region, ri) => {
    const rp = regionPlacements.get(region.id);
    if (!rp) return;
    const rcol = ri % regionCols;
    const rrow = Math.floor(ri / regionCols);
    const rcx = regionOriginX + rcol * regionPitchX;
    const rcz = regionOriginZ + rrow * regionPitchZ;
    placedRegions.push({ ...region, center: [rcx, rcz], width: rp.width, depth: rp.depth });

    for (const sp of rp.subs) {
      const sub = graph.subscriptions.find(s => s.id === sp.subId);
      const subPlace = subPlacements.get(sp.subId);
      if (!sub || !subPlace) continue;
      const subCx = rcx + sp.cx;
      const subCz = rcz + sp.cz;
      placedSubs.push({ ...sub, regionId: region.id, center: [subCx, subCz], width: subPlace.width, depth: subPlace.depth });

      for (const rgp of subPlace.rgs) {
        const rg = graph.resourceGroups.find(r => r.id === rgp.rgId);
        const rgPlace = rgPlacements.get(rgp.rgId);
        if (!rg || !rgPlace) continue;
        const rgCx = subCx + rgp.cx;
        const rgCz = subCz + rgp.cz;
        placedRgs.push({ ...rg, center: [rgCx, rgCz], width: rgPlace.width, depth: rgPlace.depth });

        // Place each building in this RG.
        for (const [refId, [lx, lz, fp]] of rgPlace.slots) {
          buildingPos.set(refId, { x: rgCx + lx, z: rgCz + lz, rgId: rg.id, footprint: fp });
        }
      }
    }
  });

  // ---- Convert building positions to placed resource arrays --------------
  const placedVms: PlacedVm[] = [];
  for (const v of graph.vms) {
    const slot = buildingPos.get(v.id);
    if (!slot) continue;
    const entry = lookupCatalogue('vm');
    if (!entry) continue;
    placedVms.push({
      ...v,
      pos: [slot.x, 0, slot.z],
      height: entry.storeysFor(v),
      rgId: slot.rgId,
      zone: entry.zone,
      building: entry.building,
      storeys: entry.storeysFor(v),
      footprint: slot.footprint,
      carriers: carriersForVm(v),
    });
  }

  const placedStorage: PlacedStorage[] = [];
  for (const s of graph.storage) {
    const slot = buildingPos.get(s.id);
    if (!slot) continue;
    const entry = lookupCatalogue('storage');
    if (!entry) continue;
    placedStorage.push({
      ...s,
      pos: [slot.x, slot.z],
      storeys: entry.storeysFor(s),
      rgId: slot.rgId,
      zone: entry.zone,
      building: entry.building,
      footprint: slot.footprint,
      carriers: carriersForStorage(s),
    });
  }

  const placedOthers: PlacedOther[] = [];
  for (const o of graph.others) {
    const slot = buildingPos.get(o.id);
    if (!slot) continue;
    const entry = lookupCatalogue(o.kind);
    if (!entry) continue;
    placedOthers.push({
      ...o,
      pos: [slot.x, slot.z],
      rgId: slot.rgId,
      zone: entry.zone,
      building: entry.building,
      storeys: entry.storeysFor({ sku: o.sku }),
      footprint: slot.footprint,
      carriers: carriersForOther(o),
      emitsCoverage: coverageFor(o),
    });
  }

  // ---- Network overlay --------------------------------------------------
  // Subnet centroids: average position of VMs whose nicLink lands in this
  // subnet. If a subnet has no buildings, fall back to the centre of its
  // VNet's home RG (just to keep the road from disappearing entirely).
  const placedSubnets: PlacedSubnet[] = [];
  const subnetCentroidById = new Map<string, [number, number]>();
  for (const subnet of graph.subnets) {
    const memberVms = placedVms.filter(v => v.subnetId === subnet.id);
    if (memberVms.length > 0) {
      const cx = memberVms.reduce((s, v) => s + v.pos[0], 0) / memberVms.length;
      const cz = memberVms.reduce((s, v) => s + v.pos[2], 0) / memberVms.length;
      subnetCentroidById.set(subnet.id, [cx, cz]);
    } else {
      // No buildings reference this subnet — derive from its VNet's RG centre.
      // VNet's RG is unknown to us in v1; just stash at world origin and skip
      // road drawing for it.
      subnetCentroidById.set(subnet.id, [0, 0]);
    }
  }
  for (const subnet of graph.subnets) {
    const c = subnetCentroidById.get(subnet.id)!;
    placedSubnets.push({
      ...subnet,
      center: c,
      size: 4,                         // small marker
      vnetCenter: c,                   // for back-compat (unused in new mode)
    });
  }

  // VNets: centroid + member subnets. Color is hashed from name; the avenue
  // mesh in world.ts uses this to draw a polyline through the subnets.
  const placedVnets: PlacedVnet[] = [];
  for (const vn of graph.vnets) {
    const memberSubs = placedSubnets.filter(s => s.vnetId === vn.id);
    let cx = 0, cz = 0;
    if (memberSubs.length > 0) {
      cx = memberSubs.reduce((sum, s) => sum + s.center[0], 0) / memberSubs.length;
      cz = memberSubs.reduce((sum, s) => sum + s.center[1], 0) / memberSubs.length;
    }
    placedVnets.push({
      ...vn,
      center: [cx, cz],
      size: 4,
      color: vnetColor(vn.name),
    });
  }
  // Synthetic VNets for orphan VMs (not attached to any subnet) get skipped —
  // the building still renders inside its RG; it just doesn't appear on the
  // road network.

  const vnetById = new Map(placedVnets.map(v => [v.id, v]));
  const subnetById = new Map(placedSubnets.map(s => [s.id, s]));
  const rgById = new Map(placedRgs.map(r => [r.id, r]));

  // ---- NIC shopfronts ---------------------------------------------------
  // Each NIC is a small storefront flush against the VM, facing the
  // direction of its subnet's centroid (i.e. the road).
  const placedNics: PlacedNic[] = [];
  const vmIdByNicName = new Map<string, string>();
  for (const v of placedVms) {
    if (v.nicName) vmIdByNicName.set(norm(v.nicName), v.id);
    if (!v.subnetId) continue;
    const sc = subnetCentroidById.get(v.subnetId);
    if (!sc) continue;
    const dx = sc[0] - v.pos[0];
    const dz = sc[1] - v.pos[2];
    const len = Math.hypot(dx, dz) || 1;
    const fx = dx / len, fz = dz / len;
    placedNics.push({
      vmId: v.id,
      subnetId: v.subnetId,
      privateIp: v.privateIp ?? '',
      pos: [v.pos[0] + fx * (TILE * 0.4), v.pos[2] + fz * (TILE * 0.4)],
      facing: [fx, fz],
    });
  }

  // ---- NSG placements --------------------------------------------------
  // NSGs are buildings inside their RG (placed in Pass 4). We fill in the
  // placedNsgs array by reading the building positions and noting what they
  // protect (for later coverage-radius rendering).
  const placedNsgs: PlacedNsg[] = [];
  for (const nsg of graph.nsgs) {
    const slot = buildingPos.get(nsg.id);
    if (!slot) continue;
    // Facing: orient the barrier arm toward the subnet it protects (if any),
    // otherwise toward the RG centre.
    let fx = 0, fz = 1;
    if (nsg.subnetId) {
      const sc = subnetCentroidById.get(nsg.subnetId);
      if (sc) {
        const dx = sc[0] - slot.x;
        const dz = sc[1] - slot.z;
        const len = Math.hypot(dx, dz) || 1;
        fx = dx / len; fz = dz / len;
      }
    }
    placedNsgs.push({
      ...nsg,
      pos: [slot.x, slot.z],
      facing: [fx, fz],
      attachedSubnetId: nsg.subnetId,
      attachedVmId: null,
      carriers: carriersForNsg(nsg),
    });
  }

  // ---- Public IPs ------------------------------------------------------
  // Public IPs are now civic toll-booth buildings inside their RG. We keep
  // attachedVmId resolution so the tooltip can still link back to a NIC.
  const placedPublicIps: PlacedPublicIp[] = [];
  for (const pip of graph.publicIps) {
    const slot = buildingPos.get(pip.id);
    if (!slot) continue;
    let attachedVmId: string | null = null;
    if (pip.attachedNic) {
      const vid = vmIdByNicName.get(norm(pip.attachedNic));
      if (vid) attachedVmId = vid;
    }
    placedPublicIps.push({
      ...pip,
      pos: [slot.x, slot.z],
      attachedVmId,
      carriers: carriersForPublicIp(pip),
    });
  }

  // ---- World bounds ----------------------------------------------------
  const allXs = placedRegions.flatMap(r => [r.center[0] - r.width / 2, r.center[0] + r.width / 2]);
  const allZs = placedRegions.flatMap(r => [r.center[1] - r.depth / 2, r.center[1] + r.depth / 2]);
  const bounds = {
    min: [Math.min(...allXs, -10), Math.min(...allZs, -10)] as [number, number],
    max: [Math.max(...allXs,  10), Math.max(...allZs,  10)] as [number, number],
  };

  // Suppress unused-import warnings for types still imported for back-compat.
  void (null as unknown as Vm | Vnet | Subnet | Peering);

  return {
    regions: placedRegions,
    subscriptions: placedSubs,
    resourceGroups: placedRgs,
    vms: placedVms,
    storage: placedStorage,
    nsgs: placedNsgs,
    publicIps: placedPublicIps,
    others: placedOthers,
    subnets: placedSubnets,
    vnets: placedVnets,
    peerings: graph.peerings,
    nics: placedNics,
    bounds,
    vnetById,
    subnetById,
    rgById,
  };
}

// ---- Squarified treemap (PRD §6) ---------------------------------------
// Bruls/Huijbregts/van Wijk (2000) — squarify items into rectangles of
// minimal aspect ratio inside a bounding box. We pre-sort by area desc.
//
// Returns one rect per input { cx, cz, w, d }; cx/cz centred relative to
// the bounding-box origin (0,0) so the caller can offset to subscription centre.
interface TmItem { rgId: string; area: number; w: number; d: number; }
function squarifiedTreemap(
  items: TmItem[], boxW: number, boxD: number,
): Array<{ rgId: string; cx: number; cz: number; w: number; d: number }> {
  if (items.length === 0) return [];
  const totalArea = items.reduce((s, it) => s + it.area, 0);
  const scale = (boxW * boxD) / Math.max(totalArea, 1e-6);
  const scaled = items.map(it => ({ ...it, area: it.area * scale }))
    .sort((a, b) => b.area - a.area);
  const out: Array<{ rgId: string; cx: number; cz: number; w: number; d: number }> = [];

  let x = 0, y = 0, remW = boxW, remD = boxD;
  let row: Array<TmItem & { area: number }> = [];

  const worst = (rowItems: typeof row, shortSide: number) => {
    if (rowItems.length === 0) return Infinity;
    const sumA = rowItems.reduce((s, r) => s + r.area, 0);
    const maxA = Math.max(...rowItems.map(r => r.area));
    const minA = Math.min(...rowItems.map(r => r.area));
    const s2 = shortSide * shortSide;
    return Math.max((s2 * maxA) / (sumA * sumA), (sumA * sumA) / (s2 * minA));
  };

  const layoutRow = (rowItems: typeof row, horizontal: boolean) => {
    const sumA = rowItems.reduce((s, r) => s + r.area, 0);
    if (horizontal) {
      // Lay along width (rowH = sumA / remW)
      const rowH = sumA / remW;
      let cx = x;
      for (const it of rowItems) {
        const w = it.area / rowH;
        out.push({ rgId: it.rgId, cx: cx + w / 2 - boxW / 2, cz: y + rowH / 2 - boxD / 2, w, d: rowH });
        cx += w;
      }
      y += rowH;
      remD -= rowH;
    } else {
      const rowW = sumA / remD;
      let cz = y;
      for (const it of rowItems) {
        const d = it.area / rowW;
        out.push({ rgId: it.rgId, cx: x + rowW / 2 - boxW / 2, cz: cz + d / 2 - boxD / 2, w: rowW, d });
        cz += d;
      }
      x += rowW;
      remW -= rowW;
    }
  };

  for (const it of scaled) {
    const horizontal = remW <= remD;
    const shortSide = Math.min(remW, remD);
    const candidate = [...row, it];
    if (worst(candidate, shortSide) <= worst(row, shortSide)) {
      row.push(it);
    } else {
      layoutRow(row, horizontal);
      row = [it];
    }
  }
  if (row.length > 0) layoutRow(row, remW <= remD);
  return out;
}

// Re-export the zone tint table so world.ts can use the same source-of-truth.
export { ZONE_TINT };
