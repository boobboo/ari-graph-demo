import type { EstateModel, ScalarMode, ScaleTier } from '../estate-model';
import { buildMapLayout } from './layout';
import { buildElevationField, buildContours } from './elevation';
import { buildHydrography } from './hydro';
import { renderOsMap } from './renderer';
import { exportSvg, exportPng } from './export';
import type { MapScene } from './types';

export function buildOsMapScene(
  estate: EstateModel,
  mapW: number,
  mapH: number,
  scalarMode: ScalarMode,
  scaleTier: ScaleTier,
): MapScene {
  const layout    = buildMapLayout(estate, mapW, mapH, scalarMode, scaleTier);
  const elevation = buildElevationField(layout.resources, mapW, mapH, scalarMode);
  const contours  = buildContours(elevation, mapW, mapH);
  const hydro     = buildHydrography(layout.resources, elevation, mapW, mapH);
  return { ...layout, elevation, contours, hydro };
}

export function mountOsMap(
  estate: EstateModel,
  container: HTMLElement,
  scalarMode: ScalarMode,
  scaleTier: ScaleTier,
  fixedSize?: { w: number; h: number },
): SVGSVGElement {
  const mapW = fixedSize?.w ?? (container.clientWidth  || 1200);
  const mapH = fixedSize?.h ?? (container.clientHeight || 840);

  const scene = buildOsMapScene(estate, mapW, mapH, scalarMode, scaleTier);

  let svg = container.querySelector('svg');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement;
    container.appendChild(svg);
  }

  renderOsMap(svg as SVGSVGElement, scene);
  return svg as SVGSVGElement;
}

export { exportSvg, exportPng };
