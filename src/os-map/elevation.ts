import * as d3 from 'd3';
import type { MapResource, ElevationField, ContourFeature } from './types';
import type { ScalarMode } from '../estate-model';

const GRID_W = 600;
const GRID_H = 420;

export function buildElevationField(
  resources: MapResource[],
  mapW: number,
  mapH: number,
  scalarMode: ScalarMode,
  sigmaFraction = 0.14,
): ElevationField {
  const values = new Float32Array(GRID_W * GRID_H);

  if (resources.length === 0) {
    return { gridW: GRID_W, gridH: GRID_H, values, min: 0, max: 0 };
  }

  const sigmaMapPx = Math.min(mapW, mapH) * sigmaFraction;
  const sigmaGX    = (sigmaMapPx / mapW) * GRID_W;
  const sigmaGY    = (sigmaMapPx / mapH) * GRID_H;
  const radius     = Math.ceil(Math.max(sigmaGX, sigmaGY) * 3);

  for (const r of resources) {
    const cx  = (r.pos[0] / mapW) * GRID_W;
    const cy  = (r.pos[1] / mapH) * GRID_H;
    // Use the scalar for the current mode as amplitude
    const amp = r.scalars[scalarMode] ?? r.elevation;
    if (!amp || amp <= 0) continue;

    const x0 = Math.max(0, Math.ceil(cx - radius));
    const x1 = Math.min(GRID_W - 1, Math.floor(cx + radius));
    const y0 = Math.max(0, Math.ceil(cy - radius));
    const y1 = Math.min(GRID_H - 1, Math.floor(cy + radius));

    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const dx = (gx - cx) / sigmaGX;
        const dy = (gy - cy) / sigmaGY;
        values[gy * GRID_W + gx] += amp * Math.exp(-0.5 * (dx * dx + dy * dy));
      }
    }
  }

  let min = Infinity, max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }
  if (min === max) max = min + 1;

  return { gridW: GRID_W, gridH: GRID_H, values, min, max };
}

export function buildContours(
  elevation: ElevationField,
  mapW: number,
  mapH: number,
  numBands = 18,
): ContourFeature[] {
  const { gridW, gridH, values, min, max } = elevation;
  if (max <= min) return [];

  const step       = (max - min) / numBands;
  const thresholds = d3.range(min + step * 0.5, max, step);
  const gen        = d3.contours().size([gridW, gridH]).thresholds(thresholds);
  const raw        = gen(Array.from(values));

  const scaleX = mapW / gridW;
  const scaleY = mapH / gridH;

  return raw.map((c, idx) => ({
    value: c.value,
    isIndex: idx % 5 === 4,
    type: 'MultiPolygon' as const,
    coordinates: c.coordinates.map(ring =>
      ring.map(subring =>
        subring.map(([x, y]) => [x * scaleX, y * scaleY] as [number, number]),
      ),
    ),
  }));
}
