import type { MapResource, HydroFeature, ElevationField } from './types';
import type { AzureResourceType } from '../estate-model';

// §6 Pass 5 — Hydrography: data-flow edges mapped to OS river hierarchy
// Spring (0.8px) → Stream (1.2px) → River (1.8px) → Estuary (2.5px)
const FLOW_GRAPH: [AzureResourceType, AzureResourceType, number][] = [
  // Springs: event/message ingestion points feed processors
  ['eventhub',   'functionapp', 0.8],
  ['eventhub',   'logicapp',    0.8],
  ['servicebus', 'functionapp', 0.8],
  ['servicebus', 'logicapp',    0.8],
  // Streams: processors fan into storage sinks
  ['eventhub',   'storage',     1.2],
  ['servicebus', 'storage',     1.2],
  ['functionapp','storage',     1.2],
  ['functionapp','sql',         1.5],
  ['functionapp','cosmos',      1.5],
  ['logicapp',   'storage',     1.2],
  ['logicapp',   'servicebus',  1.0],
  // Rivers: converged flow from app tier
  ['appservice', 'sql',         1.8],
  ['appservice', 'storage',     1.5],
  ['appservice', 'cosmos',      1.5],
  ['apim',       'appservice',  1.2],
  ['apim',       'functionapp', 1.0],
  ['acr',        'aks',         1.0],
  ['aks',        'sql',         1.5],
  ['aks',        'storage',     1.5],
  // Estuaries: storage converges into analytical sinks
  ['storage',    'sql',         2.0],
  ['storage',    'cosmos',      1.8],
];

function elevAt(
  x: number, y: number,
  elev: ElevationField, mapW: number, mapH: number,
): number {
  const gx = Math.min(elev.gridW - 1, Math.max(0, Math.floor((x / mapW) * elev.gridW)));
  const gy = Math.min(elev.gridH - 1, Math.max(0, Math.floor((y / mapH) * elev.gridH)));
  return elev.values[gy * elev.gridW + gx] ?? 0;
}

// Trace a path that biases toward lower elevation (steepest descent) between two points.
function descendPath(
  from: [number, number],
  to: [number, number],
  elev: ElevationField,
  mapW: number,
  mapH: number,
  steps = 10,
): Array<[number, number]> {
  const pts: Array<[number, number]> = [from];
  const searchR = Math.max(mapW, mapH) * 0.04;

  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const bx = from[0] + t * (to[0] - from[0]);
    const by = from[1] + t * (to[1] - from[1]);

    // Sample 8 candidates around the straight-line point, pick lowest elevation
    let lowX = bx, lowY = by, lowE = elevAt(bx, by, elev, mapW, mapH);
    for (let a = 0; a < 8; a++) {
      const angle = (a / 8) * Math.PI * 2;
      const nx = bx + Math.cos(angle) * searchR * 0.35;
      const ny = by + Math.sin(angle) * searchR * 0.35;
      const e = elevAt(nx, ny, elev, mapW, mapH);
      if (e < lowE) { lowX = nx; lowY = ny; lowE = e; }
    }

    // Blend: mostly follow direct line (70%) + slight bias toward low elevation (30%)
    pts.push([bx + (lowX - bx) * 0.3, by + (lowY - by) * 0.3]);
  }
  pts.push(to);
  return pts;
}

function widthType(w: number): HydroFeature['widthType'] {
  if (w < 1.0) return 'spring';
  if (w < 1.5) return 'stream';
  if (w < 2.0) return 'river';
  return 'estuary';
}

export function buildHydrography(
  resources: MapResource[],
  elevation: ElevationField,
  mapW: number,
  mapH: number,
): HydroFeature[] {
  const features: HydroFeature[] = [];
  if (resources.length === 0) return features;

  // Index resources by type
  const byType = new Map<AzureResourceType, MapResource[]>();
  for (const r of resources) {
    const list = byType.get(r.type) ?? [];
    list.push(r);
    byType.set(r.type, list);
  }

  const used = new Set<string>();
  let idx = 0;
  const maxFlowDist = Math.min(mapW, mapH) * 0.55;

  for (const [srcType, sinkType, baseWidth] of FLOW_GRAPH) {
    const sources = byType.get(srcType) ?? [];
    const sinks   = byType.get(sinkType) ?? [];
    if (!sources.length || !sinks.length) continue;

    for (const src of sources) {
      // Find nearest sink, prefer same parish (RG)
      let best: MapResource | null = null;
      let bestDist = Infinity;

      for (const sink of sinks) {
        if (sink.id === src.id) continue;
        const dx = sink.pos[0] - src.pos[0];
        const dy = sink.pos[1] - src.pos[1];
        const d  = Math.sqrt(dx * dx + dy * dy);
        // Same-parish sinks preferred (half effective distance)
        const eff = sink.parishId === src.parishId ? d * 0.5 : d;
        if (eff < bestDist) { bestDist = eff; best = sink; }
      }

      if (!best) continue;
      const dx = best.pos[0] - src.pos[0];
      const dy = best.pos[1] - src.pos[1];
      if (Math.sqrt(dx * dx + dy * dy) > maxFlowDist) continue;

      const key = `${src.id}→${best.id}`;
      if (used.has(key)) continue;
      used.add(key);

      const path = descendPath(src.pos, best.pos, elevation, mapW, mapH);
      features.push({
        id: `hydro-${idx++}`,
        points: path,
        width: baseWidth,
        widthType: widthType(baseWidth),
      });
    }
  }

  return features;
}
