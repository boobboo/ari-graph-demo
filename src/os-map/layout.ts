import * as d3 from 'd3';
import { Delaunay } from 'd3-delaunay';
import type { EstateModel, EstateResource, RbacAssignment } from '../estate-model';
import type { ScalarMode, ScaleTier } from '../estate-model';
import { scalarValue, SCALAR_LABELS } from '../estate-model';
import type {
  MapCounty, MapParish, MapResource, MapScene,
  LinearFeature, LandUse, VnetHull, SubnetHull,
  RbacPath, RbacRole, CartoucheData,
} from './types';
import { resourceToSymbol, isTrigPoint } from './catalogue';
import { toGridRef } from './grid-ref';

const MARGIN = 72;

function centroid(poly: Array<[number, number]>): [number, number] {
  return d3.polygonCentroid(poly) as [number, number];
}

function polyBounds(poly: Array<[number, number]>): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0x100000000; };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function seedInPoly(
  poly: Array<[number, number]>,
  rng: () => number,
  attempts = 80,
): [number, number] {
  const [x0, y0, x1, y1] = polyBounds(poly);
  for (let i = 0; i < attempts; i++) {
    const p: [number, number] = [x0 + rng() * (x1 - x0), y0 + rng() * (y1 - y0)];
    if (d3.polygonContains(poly, p)) return p;
  }
  return centroid(poly);
}

function forceSpread(
  points: Array<[number, number]>,
  poly: Array<[number, number]>,
  iterations = 8,
  minDist = 18,
): Array<[number, number]> {
  if (points.length <= 1) return points;
  const pts = points.map(p => [...p] as [number, number]);
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < pts.length; i++) {
      let fx = 0, fy = 0;
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue;
        const dx = pts[i][0] - pts[j][0];
        const dy = pts[i][1] - pts[j][1];
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
        if (dist < minDist) {
          const f = (minDist - dist) / minDist;
          fx += (dx / dist) * f * 4;
          fy += (dy / dist) * f * 4;
        }
      }
      const nx = pts[i][0] + fx;
      const ny = pts[i][1] + fy;
      if (d3.polygonContains(poly, [nx, ny])) {
        pts[i][0] = nx; pts[i][1] = ny;
      }
    }
  }
  return pts;
}

function classifyLandUse(resources: EstateResource[], env: string): LandUse {
  if (!resources.length) return 'moorland';
  const types = resources.map(r => r.type);
  const hasStorage  = types.some(t => ['storage','sql','cosmos'].includes(t));
  const hasCompute  = types.some(t => ['aks','vmss','appservice','apim'].includes(t));
  const hasSecurity = types.some(t => ['defender','keyvault'].includes(t));

  if (hasSecurity && resources.some(r => r.criticalityScore > 7)) return 'marsh';
  if (hasStorage && !hasCompute) return 'water';
  if (hasCompute) return 'builtup';
  if (env.includes('dev') || env.includes('test')) return 'arable';
  if (env.includes('prod') || env.includes('prd')) return 'forest';
  return 'moorland';
}

function vnetColor(name: string): string {
  const h = hashStr(name);
  const hue = (h >>> 0) % 360;
  return `hsl(${hue},55%,50%)`;
}

// Nearest point on the inner map boundary (inside MARGIN) from a given position
function nearestBoundaryPoint(
  pos: [number, number],
  mapW: number,
  mapH: number,
): [number, number] {
  const [x, y] = pos;
  const m = MARGIN;
  const candidates: Array<{ d: number; p: [number, number] }> = [
    { d: x - m,        p: [m,        y] },
    { d: mapW - m - x, p: [mapW - m, y] },
    { d: y - m,        p: [x, m] },
    { d: mapH - m - y, p: [x, mapH - m] },
  ];
  candidates.sort((a, b) => a.d - b.d);
  return candidates[0]!.p;
}

// Map RBAC role name to tier
function classifyRole(roleName: string): RbacRole {
  const r = roleName.toLowerCase();
  if (r.includes('owner') || r.includes('admin') || r.includes('administrator') ||
      r.includes('user access')) return 'owner';
  if (r.includes('contributor')) return 'contributor';
  return 'reader';
}

export function buildMapLayout(
  estate: EstateModel,
  mapW: number,
  mapH: number,
  scalarMode: ScalarMode,
  scaleTier: ScaleTier,
): Omit<MapScene, 'elevation' | 'contours' | 'hydro'> {
  const { subscriptions, resourcesByRg, rgsBySubscription, vnets, subnets, peerings } = estate;

  const rng = makePrng(hashStr(subscriptions.join('|')));

  const innerX0 = MARGIN;
  const innerY0 = MARGIN + 30;
  const innerX1 = mapW - MARGIN;
  const innerY1 = mapH - MARGIN - 30;
  const innerW  = innerX1 - innerX0;
  const innerH  = innerY1 - innerY0;

  // ---- Pass 1: County Voronoi (Subscriptions), weighted by total cost ----
  const nsubs = subscriptions.length;
  const subCosts = subscriptions.map(sub =>
    (rgsBySubscription.get(sub) ?? []).reduce((s, rg) => {
      const key = `${sub}||${rg}`;
      return s + (resourcesByRg.get(key) ?? []).reduce((c, r) => c + r.costMonthlyGbp, 0);
    }, 0),
  );
  const totalCost = subCosts.reduce((s, c) => s + c, 0) || 1;

  let countyPolygons: Array<Array<[number, number]>>;

  if (nsubs === 0) {
    countyPolygons = [];
  } else if (nsubs === 1) {
    countyPolygons = [[[innerX0, innerY0],[innerX1, innerY0],[innerX1, innerY1],[innerX0, innerY1]]];
  } else {
    let cx = innerX0;
    const seeds: Array<[number, number]> = subscriptions.map((_, i) => {
      const w = (subCosts[i]! / totalCost) * innerW;
      const sx = cx + w * (0.3 + rng() * 0.4);
      const sy = innerY0 + innerH * (0.3 + rng() * 0.4);
      cx += w;
      return [sx, sy];
    });

    const del = Delaunay.from(seeds);
    const vor = del.voronoi([innerX0, innerY0, innerX1, innerY1]);
    countyPolygons = subscriptions.map((_, i) =>
      (vor.cellPolygon(i) ?? [[innerX0,innerY0],[innerX1,innerY0],[innerX1,innerY1],[innerX0,innerY1]]) as Array<[number, number]>,
    );
  }

  const counties: MapCounty[] = subscriptions.map((sub, i) => ({
    id: sub,
    name: sub,
    polygon: countyPolygons[i] ?? [],
    centroid: countyPolygons[i] ? centroid(countyPolygons[i]!) : [mapW/2, mapH/2],
    totalCost: subCosts[i] ?? 0,
  }));

  // ---- Pass 2: Parish Voronoi (RGs within each Subscription) ----
  const parishes: MapParish[] = [];
  const resources: MapResource[] = [];
  const placedIds = new Set<string>();

  for (const county of counties) {
    const rgs = rgsBySubscription.get(county.id) ?? [];
    const countyPoly = county.polygon;
    const [cx0, cy0, cx1, cy1] = polyBounds(countyPoly);
    const subRng = makePrng(hashStr(county.id));

    if (rgs.length === 0) {
      parishes.push({
        id: county.id + '||?',
        name: county.name,
        subscriptionId: county.id,
        polygon: countyPoly,
        centroid: county.centroid,
        landUse: 'moorland',
        environment: '',
      });
      continue;
    }

    let parishPolygons: Array<Array<[number, number]>>;
    if (rgs.length === 1) {
      parishPolygons = [countyPoly];
    } else {
      const seeds: Array<[number, number]> = rgs.map(() => seedInPoly(countyPoly, subRng));
      const subDel = Delaunay.from(seeds);
      const subVor = subDel.voronoi([cx0, cy0, cx1, cy1]);
      parishPolygons = rgs.map((_, i) =>
        (subVor.cellPolygon(i) ?? countyPoly) as Array<[number, number]>,
      );
    }

    for (let i = 0; i < rgs.length; i++) {
      const rg       = rgs[i]!;
      const key      = `${county.id}||${rg}`;
      const rgRes    = resourcesByRg.get(key) ?? [];
      const poly     = parishPolygons[i] ?? countyPoly;
      const cen      = centroid(poly);

      const env = rgRes[0]?.tags['environment'] ?? rgRes[0]?.tags['env'] ?? '';
      parishes.push({
        id: key,
        name: rg,
        subscriptionId: county.id,
        polygon: poly,
        centroid: cen,
        landUse: classifyLandUse(rgRes, env),
        environment: env,
      });

      const rgRng = makePrng(hashStr(key));
      const rawPositions: Array<[number, number]> = rgRes.map(() => seedInPoly(poly, rgRng, 60));
      const spreadPositions = forceSpread(rawPositions, poly);

      for (let j = 0; j < rgRes.length; j++) {
        const r   = rgRes[j]!;
        const pos = spreadPositions[j] ?? cen;
        placedIds.add(r.id);

        const scalars = {
          cost:        r.costMonthlyGbp,
          criticality: r.criticalityScore,
          age:         r.ageDays / 30,
          blast:       r.blastRadiusScore,
          change:      r.changeFreq30d,
        };

        resources.push({
          id: r.id,
          name: r.name,
          type: r.type,
          parishId: key,
          countyId: county.id,
          pos,
          elevation: scalarValue(r, scalarMode),
          scalars,
          symbol: resourceToSymbol(r),
          tooltip: buildTooltip(r, toGridRef(pos[0], pos[1], mapW, mapH)),
          gridRef: toGridRef(pos[0], pos[1], mapW, mapH),
          isTrigPoint: isTrigPoint(r),
          subnetId: r.subnetId,
        });
      }
    }
  }

  // Orphaned resources
  const orphanRng = makePrng(0xdeadbeef);
  for (const r of estate.resources) {
    if (placedIds.has(r.id)) continue;
    const pos: [number, number] = [innerX0 + orphanRng() * innerW, innerY0 + orphanRng() * innerH];
    const scalars = {
      cost: r.costMonthlyGbp, criticality: r.criticalityScore,
      age: r.ageDays / 30, blast: r.blastRadiusScore, change: r.changeFreq30d,
    };
    resources.push({
      id: r.id, name: r.name, type: r.type,
      parishId: null, countyId: null, pos,
      elevation: scalarValue(r, scalarMode),
      scalars,
      symbol: resourceToSymbol(r),
      tooltip: buildTooltip(r, toGridRef(pos[0], pos[1], mapW, mapH)),
      gridRef: toGridRef(pos[0], pos[1], mapW, mapH),
      isTrigPoint: isTrigPoint(r),
      subnetId: r.subnetId,
    });
  }

  // ---- VNet hulls ----
  const vnetHulls: VnetHull[] = [];
  for (const vnet of vnets) {
    const vnetResources = resources.filter(r =>
      estate.resources.find(er => er.id === r.id)?.vnetId === vnet.id,
    );
    if (vnetResources.length < 2) continue;
    const pts = vnetResources.map(r => r.pos);
    const hull = d3.polygonHull(pts);
    if (!hull || hull.length < 3) continue;
    const hullCen = centroid(hull as Array<[number, number]>);
    const inflated = hull.map(([x, y]) => {
      const dx = x - hullCen[0], dy = y - hullCen[1];
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      return [x + (dx / dist) * 20, y + (dy / dist) * 20] as [number, number];
    });
    vnetHulls.push({
      vnetId: vnet.id,
      name: vnet.name,
      hull: inflated,
      centroid: hullCen,
      color: vnetColor(vnet.id),
    });
  }

  // ---- §5.3 Subnet field boundaries ----
  const subnetHulls: SubnetHull[] = [];
  const bySubnet = new Map<string, MapResource[]>();
  for (const r of resources) {
    if (!r.subnetId) continue;
    const list = bySubnet.get(r.subnetId) ?? [];
    list.push(r);
    bySubnet.set(r.subnetId, list);
  }
  for (const [sId, sRes] of bySubnet) {
    if (sRes.length < 2) continue;
    const pts = sRes.map(r => r.pos);
    const hull = d3.polygonHull(pts);
    if (!hull || hull.length < 3) continue;
    const hullCen = centroid(hull as Array<[number, number]>);
    const inflated = hull.map(([x, y]) => {
      const dx = x - hullCen[0], dy = y - hullCen[1];
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      return [x + (dx / dist) * 10, y + (dy / dist) * 10] as [number, number];
    });
    const subnet = subnets.find(s => s.id === sId);
    subnetHulls.push({
      subnetId: sId,
      name: subnet?.name ?? sId.split('::')[1] ?? sId,
      vnetId: subnet?.vnetId ?? '',
      hull: inflated,
    });
  }

  // ---- Linear features: peerings + §5.3 transport (ER motorway, VPN A-road) ----
  const vnetHullById = new Map(vnetHulls.map(h => [h.vnetId, h]));
  const linear: LinearFeature[] = [];

  // Peering arcs
  for (const p of peerings) {
    const a = vnetHullById.get(p.a);
    const b = vnetHullById.get(p.b);
    const ac = a?.centroid ?? counties[0]?.centroid ?? [mapW/2, mapH/2] as [number, number];
    const bc = b?.centroid ?? counties[1]?.centroid ?? [mapW/2, mapH/2] as [number, number];
    const mid: [number, number] = [
      (ac[0] + bc[0]) / 2 + (rng() - 0.5) * 50,
      (ac[1] + bc[1]) / 2 + (rng() - 0.5) * 50,
    ];
    linear.push({
      id: `${p.a}↔${p.b}`,
      type: 'peering',
      points: [ac as [number,number], mid, bc as [number,number]],
      color: '#8844BB',
      width: 2.5,
      dash: '8,4',
      label: `Peering: ${p.a} ↔ ${p.b}`,
    });
  }

  // §5.3 ExpressRoute → OS motorway (blue, leads to map edge)
  // §5.3 VPN Gateway → OS A-road (red, leads to map edge)
  const transportRng = makePrng(hashStr('transport'));
  for (const r of resources) {
    if (r.type === 'expressroute') {
      const boundary = nearestBoundaryPoint(r.pos, mapW, mapH);
      const mid: [number, number] = [
        (r.pos[0] + boundary[0]) / 2 + (transportRng() - 0.5) * 30,
        (r.pos[1] + boundary[1]) / 2 + (transportRng() - 0.5) * 30,
      ];
      linear.push({
        id: `er-${r.id}`,
        type: 'expressroute',
        points: [r.pos, mid, boundary],
        color: '#0055CC',
        width: 4.5,
        dash: '',
        label: scaleTier === 'explorer' ? `M: ${r.name}` : undefined,
      });
    } else if (r.type === 'vpngateway') {
      const boundary = nearestBoundaryPoint(r.pos, mapW, mapH);
      const mid: [number, number] = [
        (r.pos[0] + boundary[0]) / 2 + (transportRng() - 0.5) * 30,
        (r.pos[1] + boundary[1]) / 2 + (transportRng() - 0.5) * 30,
      ];
      linear.push({
        id: `vpn-${r.id}`,
        type: 'vpn',
        points: [r.pos, mid, boundary],
        color: '#CC2222',
        width: 3,
        dash: '',
        label: scaleTier === 'explorer' ? `A: ${r.name}` : undefined,
      });
    }
  }

  // ---- §5.6 RBAC rights-of-way paths ----
  const rbacPaths: RbacPath[] = [];

  // Aggregate: highest role wins per scope
  const countyRoles = new Map<string, RbacRole>();
  const parishRoles = new Map<string, RbacRole>();

  const roleRank = (role: RbacRole): number =>
    role === 'owner' ? 3 : role === 'contributor' ? 2 : 1;
  const mergeRole = (existing: RbacRole | undefined, next: RbacRole): RbacRole =>
    !existing || roleRank(next) > roleRank(existing) ? next : existing;

  for (const a of estate.rbacAssignments) {
    const role = classifyRole(a.roleName);
    if (a.rgName) {
      const key = `${a.subscriptionName}||${a.rgName}`;
      parishRoles.set(key, mergeRole(parishRoles.get(key), role));
    } else {
      countyRoles.set(a.subscriptionName, mergeRole(countyRoles.get(a.subscriptionName), role));
    }
  }

  let rbacIdx = 0;
  for (const [subName, role] of countyRoles) {
    const county = counties.find(c => c.id === subName || c.name === subName);
    if (!county || !county.polygon.length) continue;
    rbacPaths.push({ id: `rbac-${rbacIdx++}`, polygon: county.polygon, role, scope: 'subscription' });
  }
  for (const [key, role] of parishRoles) {
    const parish = parishes.find(p => p.id === key);
    if (!parish || !parish.polygon.length) continue;
    rbacPaths.push({ id: `rbac-${rbacIdx++}`, polygon: parish.polygon, role, scope: 'rg' });
  }

  // ---- Cartouche data ----
  const totalResources  = estate.resources.length;
  const totalSubCount   = subscriptions.length;
  const totalRgCount    = [...rgsBySubscription.values()].reduce((s, a) => s + a.length, 0);
  const totalMonthly    = estate.resources.reduce((s, r) => s + r.costMonthlyGbp, 0);
  const scaleLabel      = `Elevation: ${SCALAR_LABELS[scalarMode]}`;
  const tierLabel       = scaleTier === 'road' ? '1:250 000 Road' : scaleTier === 'explorer' ? '1:25 000 Explorer' : '1:50 000 Landranger';

  const cartouche: CartoucheData = {
    title: 'Azure Estate — Ordnance Survey Cartographic View',
    subtitle: `${tierLabel} · ${totalSubCount} Subscription${totalSubCount !== 1 ? 's' : ''} · ${totalRgCount} Resource Group${totalRgCount !== 1 ? 's' : ''} · ${totalResources} Resources`,
    date: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }),
    scaleLabel,
    estateStats: `Est. £${Math.round(totalMonthly).toLocaleString()}/month`,
    sheetRef: 'Sheet 1 of 1',
  };

  return {
    mapW, mapH, counties, parishes, resources, vnetHulls, subnetHulls,
    linear, rbacPaths, cartouche, scalarMode, scaleTier,
  };
}

function buildTooltip(r: EstateResource, gridRef: string): string {
  const lines = [
    `${r.name} [${r.type.toUpperCase()}]`,
    `Grid ref: ${gridRef}`,
    `RG: ${r.rg} · Sub: ${r.subscription}`,
    `Cost: ~£${r.costMonthlyGbp}/mo · Criticality: ${r.criticalityScore.toFixed(1)}/10`,
  ];
  if (r.sku)     lines.push(`SKU: ${r.sku}`);
  if (r.location) lines.push(`Region: ${r.location}`);
  const env = r.tags['environment'] ?? r.tags['env'];
  if (env)       lines.push(`Env: ${env}`);
  return lines.join('\n');
}
