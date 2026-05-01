import * as d3 from 'd3';
import { OS } from './palette';
import type {
  MapScene, MapResource, MapCounty, MapParish,
  LinearFeature, ContourFeature, VnetHull, SubnetHull,
  HydroFeature, RbacPath, ScaleTier,
} from './types';
import type { AzureResourceType } from '../estate-model';

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function polyPath(poly: Array<[number, number]>): string {
  if (poly.length === 0) return '';
  return `M ${poly.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L ')} Z`;
}

function contourPath(c: ContourFeature): string {
  return c.coordinates.flatMap(ring =>
    ring.map(sub =>
      sub.length < 2 ? '' :
      `M ${sub.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L ')} Z`,
    ),
  ).join(' ');
}

function catmullPath(pts: Array<[number, number]>): string {
  if (pts.length < 2) return '';
  return d3.line<[number, number]>().x(p => p[0]).y(p => p[1])
    .curve(d3.curveCatmullRom.alpha(0.5))(pts) ?? '';
}

type GrpSel = d3.Selection<SVGGElement, unknown, null, undefined>;

// ---------------------------------------------------------------------------
// Symbol drawers — one per SymbolShape
// ---------------------------------------------------------------------------

function drawSquare(g: GrpSel, r: MapResource): void {
  const { size, fill, stroke } = r.symbol;
  g.append('rect').attr('x', -size/2).attr('y', -size/2)
    .attr('width', size).attr('height', size)
    .attr('fill', fill).attr('stroke', stroke).attr('stroke-width', 1.2).attr('rx', 1);
}

function drawSquares(g: GrpSel, r: MapResource): void {
  const s = r.symbol.size * 0.38;
  const offsets: Array<[number,number]> = [[-s,-s/2],[s,-s/2],[0,s*0.8]];
  for (const [ox, oy] of offsets)
    g.append('rect').attr('x', ox-s/2).attr('y', oy-s/2)
      .attr('width', s).attr('height', s)
      .attr('fill', r.symbol.fill).attr('stroke', r.symbol.stroke).attr('stroke-width', 0.8);
}

function drawCircle(g: GrpSel, r: MapResource): void {
  g.append('circle').attr('r', r.symbol.size/2)
    .attr('fill', r.symbol.fill).attr('stroke', r.symbol.stroke).attr('stroke-width', 1.2);
}

function drawDiamond(g: GrpSel, r: MapResource): void {
  const h = r.symbol.size * 0.75, w = r.symbol.size / 2;
  g.append('polygon').attr('points', `0,${-h} ${w},0 0,${h} ${-w},0`)
    .attr('fill', r.symbol.fill).attr('stroke', r.symbol.stroke).attr('stroke-width', 1.2);
}

function drawTrig(g: GrpSel, r: MapResource): void {
  const s = r.symbol.size * 0.7;
  g.append('polygon')
    .attr('points', `0,${-s} ${s*0.866},${s*0.5} ${-s*0.866},${s*0.5}`)
    .attr('fill', 'none').attr('stroke', OS.trigPoint).attr('stroke-width', 1.8);
  g.append('circle').attr('r', 2.5).attr('fill', OS.trigPoint);
  g.append('text').attr('dy', -s - 3).attr('text-anchor', 'middle')
    .attr('font-size', '7px').attr('fill', OS.trigPoint)
    .text(r.symbol.abbrev);
}

function drawReservoir(g: GrpSel, r: MapResource): void {
  g.append('ellipse').attr('rx', r.symbol.size*0.7).attr('ry', r.symbol.size*0.4)
    .attr('fill', '#B5D4F0').attr('stroke', '#3399CC').attr('stroke-width', 1.2);
}

function drawCastle(g: GrpSel, r: MapResource): void {
  const s = r.symbol.size, h = s * 0.7;
  g.append('rect').attr('x', -s/2).attr('y', -h/2)
    .attr('width', s).attr('height', h)
    .attr('fill', r.symbol.fill).attr('stroke', r.symbol.stroke).attr('stroke-width', 1.2);
  const mw = s * 0.18, mh = h * 0.25;
  for (let i = 0; i < 3; i++) {
    const mx = -s/2 + s*0.1 + i * (s*0.28);
    g.append('rect').attr('x', mx).attr('y', -h/2 - mh)
      .attr('width', mw).attr('height', mh)
      .attr('fill', r.symbol.fill).attr('stroke', r.symbol.stroke).attr('stroke-width', 0.8);
  }
}

function drawQuarry(g: GrpSel, r: MapResource): void {
  const s = r.symbol.size, h = s * 0.75;
  const clip = `clip-quarry-${Math.random().toString(36).slice(2)}`;
  const defs = (g.node()?.closest('svg') ? d3.select(g.node()!.closest('svg')!) : g).select('defs');
  defs.append('clipPath').attr('id', clip)
    .append('rect').attr('x', -s/2).attr('y', -h/2).attr('width', s).attr('height', h);
  g.append('rect').attr('x', -s/2).attr('y', -h/2)
    .attr('width', s).attr('height', h)
    .attr('fill', r.symbol.fill).attr('stroke', r.symbol.stroke).attr('stroke-width', 1.2);
  for (let d = -s; d < s + h; d += 4)
    g.append('line').attr('x1', -s/2 + d).attr('y1', -h/2)
      .attr('x2', -s/2 + d - h).attr('y2', h/2)
      .attr('stroke', '#888').attr('stroke-width', 0.6)
      .attr('clip-path', `url(#${clip})`);
}

function drawSpire(g: GrpSel, r: MapResource): void {
  const s = r.symbol.size * 0.45;
  g.append('circle').attr('r', s)
    .attr('fill', r.symbol.fill).attr('stroke', r.symbol.stroke).attr('stroke-width', 1.2);
  g.append('line').attr('x1', 0).attr('y1', -s).attr('x2', 0).attr('y2', -s*2.2)
    .attr('stroke', r.symbol.stroke).attr('stroke-width', 1.5);
  g.append('line').attr('x1', -s*0.6).attr('y1', -s*1.5).attr('x2', s*0.6).attr('y2', -s*1.5)
    .attr('stroke', r.symbol.stroke).attr('stroke-width', 1);
}

function drawBuilding(g: GrpSel, r: MapResource): void {
  const w = r.symbol.size * 0.5, h = r.symbol.size;
  g.append('rect').attr('x', -w/2).attr('y', -h/2)
    .attr('width', w).attr('height', h)
    .attr('fill', r.symbol.fill).attr('stroke', r.symbol.stroke).attr('stroke-width', 1.2);
}

function drawJunction(g: GrpSel, r: MapResource): void {
  const s = r.symbol.size * 0.4;
  g.append('polygon').attr('points', `0,${-s} ${s},0 0,${s} ${-s},0`)
    .attr('fill', r.symbol.fill).attr('stroke', r.symbol.stroke).attr('stroke-width', 1);
  for (const [dx, dy] of [[0,-s*1.8],[s*1.8,0],[0,s*1.8],[-s*1.8,0]] as [number,number][])
    g.append('line').attr('x1', 0).attr('y1', 0).attr('x2', dx).attr('y2', dy)
      .attr('stroke', r.symbol.stroke).attr('stroke-width', 0.8);
}

function drawMarket(g: GrpSel, r: MapResource): void {
  const s = r.symbol.size;
  g.append('rect').attr('x', -s/2).attr('y', -s/2)
    .attr('width', s).attr('height', s)
    .attr('fill', r.symbol.fill).attr('stroke', r.symbol.stroke).attr('stroke-width', 1.2);
  for (let ix = -1; ix <= 1; ix++)
    for (let iy = -1; iy <= 1; iy++)
      g.append('circle').attr('cx', ix * s*0.28).attr('cy', iy * s*0.28)
        .attr('r', 1.2).attr('fill', r.symbol.stroke);
}

function drawBuiltupArea(g: GrpSel, r: MapResource): void {
  const s = r.symbol.size;
  g.append('rect').attr('x', -s/2).attr('y', -s/2)
    .attr('width', s).attr('height', s)
    .attr('fill', '#FFC0B5').attr('stroke', '#CC4444').attr('stroke-width', 1.5);
  for (let d = -s; d < s*1.5; d += 5) {
    g.append('line').attr('x1', Math.max(-s/2, -s/2 + d)).attr('y1', d < 0 ? -s/2 : -s/2 + d - s/2)
      .attr('x2', Math.min(s/2, -s/2 + d + s)).attr('y2', d < s/2 ? s/2 : s/2 - d - s/2)
      .attr('stroke', '#CC4444').attr('stroke-width', 0.5).attr('opacity', 0.4);
  }
}

function drawSilo(g: GrpSel, r: MapResource): void {
  const w = r.symbol.size * 0.55, h = r.symbol.size * 0.7;
  g.append('rect').attr('x', -w/2).attr('y', -h/4)
    .attr('width', w).attr('height', h*0.7)
    .attr('fill', r.symbol.fill).attr('stroke', r.symbol.stroke).attr('stroke-width', 1.2);
  g.append('ellipse').attr('rx', w/2).attr('ry', h*0.2).attr('cy', -h/4)
    .attr('fill', r.symbol.fill).attr('stroke', r.symbol.stroke).attr('stroke-width', 1.2);
}

function drawPost(g: GrpSel, r: MapResource): void {
  const s = r.symbol.size * 0.85;
  g.append('rect').attr('x', -s/2).attr('y', -s/2)
    .attr('width', s).attr('height', s)
    .attr('fill', r.symbol.fill).attr('stroke', r.symbol.stroke).attr('stroke-width', 1.2);
  g.append('text').attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
    .attr('font-size', `${s*0.5}px`).attr('font-weight', 'bold').attr('fill', r.symbol.stroke)
    .text(r.symbol.abbrev.slice(0, 2));
}

function drawTollbooth(g: GrpSel, r: MapResource): void {
  const s = r.symbol.size;
  g.append('rect').attr('x', -s/2).attr('y', -s*0.15)
    .attr('width', s).attr('height', s*0.3)
    .attr('fill', r.symbol.fill).attr('stroke', r.symbol.stroke).attr('stroke-width', 1.2).attr('rx', 2);
  g.append('line').attr('x1', 0).attr('y1', -s*0.6).attr('x2', 0).attr('y2', -s*0.15)
    .attr('stroke', r.symbol.stroke).attr('stroke-width', 2);
}

function drawLighthouse(g: GrpSel, r: MapResource): void {
  const s = r.symbol.size;
  g.append('polygon').attr('points', `0,${-s} ${s*0.3},${s*0.4} ${-s*0.3},${s*0.4}`)
    .attr('fill', '#FFFFD0').attr('stroke', '#888800').attr('stroke-width', 1.2);
  g.append('circle').attr('cy', -s).attr('r', 2.5).attr('fill', '#FFFF00').attr('stroke', '#888800').attr('stroke-width', 0.8);
}

function drawBridge(g: GrpSel, r: MapResource): void {
  const s = r.symbol.size * 0.5;
  g.append('line').attr('x1', -s).attr('y1', 0).attr('x2', s).attr('y2', 0)
    .attr('stroke', r.symbol.stroke).attr('stroke-width', 2);
  g.append('line').attr('x1', -s).attr('y1', -s).attr('x2', -s).attr('y2', s*0.3)
    .attr('stroke', r.symbol.stroke).attr('stroke-width', 2);
  g.append('line').attr('x1', s).attr('y1', -s).attr('x2', s).attr('y2', s*0.3)
    .attr('stroke', r.symbol.stroke).attr('stroke-width', 2);
  g.append('path').attr('d', `M ${-s},0 Q 0,${-s*1.4} ${s},0`)
    .attr('fill', 'none').attr('stroke', r.symbol.stroke).attr('stroke-width', 1);
}

function drawPolice(g: GrpSel, r: MapResource): void {
  const s = r.symbol.size * 0.85;
  g.append('rect').attr('x', -s/2).attr('y', -s/2)
    .attr('width', s).attr('height', s)
    .attr('fill', '#D0D8FF').attr('stroke', '#4444CC').attr('stroke-width', 1.5);
  g.append('text').attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
    .attr('font-size', `${s*0.55}px`).attr('font-weight', 'bold').attr('fill', '#4444CC')
    .text('P');
}

function drawHospital(g: GrpSel, r: MapResource): void {
  const s = r.symbol.size * 0.85;
  g.append('rect').attr('x', -s/2).attr('y', -s/2)
    .attr('width', s).attr('height', s)
    .attr('fill', '#E8FFE8').attr('stroke', '#228822').attr('stroke-width', 1.5);
  g.append('rect').attr('x', -s*0.12).attr('y', -s*0.4).attr('width', s*0.24).attr('height', s*0.8)
    .attr('fill', '#228822');
  g.append('rect').attr('x', -s*0.4).attr('y', -s*0.12).attr('width', s*0.8).attr('height', s*0.24)
    .attr('fill', '#228822');
}

function drawFort(g: GrpSel, r: MapResource): void {
  const s = r.symbol.size * 0.55;
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r2 = i % 2 === 0 ? s : s * 0.45;
    const angle = (i * Math.PI / 5) - Math.PI / 2;
    pts.push(`${(r2 * Math.cos(angle)).toFixed(1)},${(r2 * Math.sin(angle)).toFixed(1)}`);
  }
  g.append('polygon').attr('points', pts.join(' '))
    .attr('fill', '#FFE8E8').attr('stroke', '#CC2222').attr('stroke-width', 1.2);
}

function drawObservatory(g: GrpSel, r: MapResource): void {
  const s = r.symbol.size * 0.5;
  g.append('rect').attr('x', -s*0.5).attr('y', 0).attr('width', s).attr('height', s*0.4)
    .attr('fill', r.symbol.fill).attr('stroke', r.symbol.stroke).attr('stroke-width', 1.2);
  g.append('path').attr('d', `M ${-s},0 A ${s},${s*0.8} 0 0,1 ${s},0 Z`)
    .attr('fill', r.symbol.fill).attr('stroke', r.symbol.stroke).attr('stroke-width', 1.2);
}

const DRAWERS: Record<string, (g: GrpSel, r: MapResource) => void> = {
  square:         drawSquare,
  squares:        drawSquares,
  circle:         drawCircle,
  diamond:        drawDiamond,
  trig:           drawTrig,
  reservoir:      drawReservoir,
  castle:         drawCastle,
  quarry:         drawQuarry,
  spire:          drawSpire,
  building:       drawBuilding,
  junction:       drawJunction,
  market:         drawMarket,
  'builtup-area': drawBuiltupArea,
  silo:           drawSilo,
  post:           drawPost,
  tollbooth:      drawTollbooth,
  lighthouse:     drawLighthouse,
  bridge:         drawBridge,
  police:         drawPolice,
  hospital:       drawHospital,
  fort:           drawFort,
  observatory:    drawObservatory,
};

function drawSymbol(g: GrpSel, r: MapResource): void {
  if (r.isTrigPoint) { drawTrig(g, r); return; }
  const fn = DRAWERS[r.symbol.shape] ?? drawCircle;
  fn(g, r);
}

// ---------------------------------------------------------------------------
// OS Grid lines (OSGB-style faint blue)
// ---------------------------------------------------------------------------

function renderGrid(root: d3.Selection<SVGSVGElement, unknown, null, undefined>, mapW: number, mapH: number, margin: number): void {
  const g = root.append('g').attr('class', 'os-grid');
  const div = 5;
  const stepX = (mapW - 2*margin) / div, stepY = (mapH - 2*margin) / div;

  for (let i = 0; i <= div; i++) {
    const x = margin + i * stepX;
    g.append('line').attr('x1', x).attr('y1', margin).attr('x2', x).attr('y2', mapH - margin)
      .attr('stroke', OS.gridLine).attr('stroke-width', 0.5);
    g.append('text').attr('x', x + 3).attr('y', margin + 10)
      .attr('font-size', '7px').attr('fill', OS.gridText)
      .text(String.fromCharCode(65 + i));

    const y = margin + i * stepY;
    g.append('line').attr('x1', margin).attr('y1', y).attr('x2', mapW - margin).attr('y2', y)
      .attr('stroke', OS.gridLine).attr('stroke-width', 0.5);
    if (i > 0)
      g.append('text').attr('x', margin + 3).attr('y', y - 2)
        .attr('font-size', '7px').attr('fill', OS.gridText)
        .text(String(div - i));
  }
}

// ---------------------------------------------------------------------------
// North arrow
// ---------------------------------------------------------------------------

function renderNorthArrow(root: d3.Selection<SVGSVGElement, unknown, null, undefined>, x: number, y: number): void {
  const g = root.append('g').attr('transform', `translate(${x},${y})`);
  g.append('polygon').attr('points', '0,-20 5,2 -5,2').attr('fill', OS.cartoucheBorder);
  g.append('polygon').attr('points', '0,20 5,2 -5,2').attr('fill', 'white').attr('stroke', OS.cartoucheBorder).attr('stroke-width', 1);
  g.append('text').attr('dy', -24).attr('text-anchor', 'middle')
    .attr('font-size', '10px').attr('font-weight', 'bold').attr('fill', OS.cartoucheBorder).text('N');
}

// ---------------------------------------------------------------------------
// Magnetic variation diagram (§5.6 "three norths")
// ---------------------------------------------------------------------------

function renderMagVarDiagram(
  root: d3.Selection<SVGSVGElement, unknown, null, undefined>,
  x: number, y: number,
): void {
  const g = root.append('g').attr('transform', `translate(${x},${y})`);
  const arrowLen = 30;

  g.append('rect').attr('x', -42).attr('y', -arrowLen - 20)
    .attr('width', 84).attr('height', arrowLen + 36)
    .attr('fill', OS.cartoucheHeader).attr('stroke', OS.cartoucheBorder).attr('stroke-width', 0.5);

  g.append('text').attr('dy', -arrowLen - 10).attr('text-anchor', 'middle')
    .attr('font-size', '6px').attr('fill', OS.cartoucheBorder)
    .text('Variation diagram');

  const svgEl = root.node();
  if (svgEl) {
    const defs = d3.select(svgEl).select('defs');
    if (defs.select('#arr').empty()) {
      defs.append('marker').attr('id', 'arr').attr('markerWidth', 4).attr('markerHeight', 4)
        .attr('refX', 2).attr('refY', 2).attr('orient', 'auto')
        .append('path').attr('d', 'M0,0 L4,2 L0,4 Z').attr('fill', '#666');
    }
  }

  const arrow = (dx: number, angle: number, label: string, color: string, abbrev: string) => {
    const rad = (angle * Math.PI) / 180;
    const ex = Math.sin(rad) * arrowLen;
    const ey = -Math.cos(rad) * arrowLen;
    g.append('line').attr('x1', dx).attr('y1', 0).attr('x2', dx + ex).attr('y2', ey)
      .attr('stroke', color).attr('stroke-width', 1.5)
      .attr('marker-end', 'url(#arr)');
    g.append('text').attr('x', dx + ex + (ex > 0 ? 3 : -3)).attr('y', ey - 2)
      .attr('font-size', '6px').attr('fill', color)
      .attr('text-anchor', ex > 0 ? 'start' : 'end')
      .text(abbrev);
    g.append('text').attr('x', dx).attr('y', 8)
      .attr('font-size', '5.5px').attr('fill', color)
      .attr('text-anchor', 'middle').text(label);
  };

  arrow(-26, -2,  'IaC',    '#2244AA', 'TN');
  arrow(0,    0,  'Portal', '#AA4422', 'MN');
  arrow(26,   4,  'Running','#225533', 'GN');
}

// ---------------------------------------------------------------------------
// Scale bar
// ---------------------------------------------------------------------------

function renderScaleBar(
  root: d3.Selection<SVGSVGElement, unknown, null, undefined>,
  x: number, y: number, scaleLabel: string,
): void {
  const g = root.append('g').attr('transform', `translate(${x},${y})`);
  const barW = 80, barH = 8;
  for (let i = 0; i < 4; i++) {
    g.append('rect').attr('x', i * barW/4).attr('y', 0)
      .attr('width', barW/4).attr('height', barH)
      .attr('fill', i % 2 === 0 ? OS.cartoucheBorder : 'white')
      .attr('stroke', OS.cartoucheBorder).attr('stroke-width', 0.5);
  }
  g.append('text').attr('x', 0).attr('y', -3)
    .attr('font-size', '7px').attr('fill', OS.cartoucheBorder).text('0');
  g.append('text').attr('x', barW).attr('y', -3)
    .attr('text-anchor', 'end').attr('font-size', '7px').attr('fill', OS.cartoucheBorder)
    .text('↑high');
  g.append('text').attr('x', barW/2).attr('y', barH + 10)
    .attr('text-anchor', 'middle').attr('font-size', '7px').attr('fill', OS.cartoucheBorder)
    .text(scaleLabel);
}

// ---------------------------------------------------------------------------
// Legend — auto-generated from visible resource types
// ---------------------------------------------------------------------------

function renderLegend(
  root: d3.Selection<SVGSVGElement, unknown, null, undefined>,
  scene: MapScene,
): void {
  const { mapW, mapH, resources } = scene;

  const visibleTypes = [...new Set(resources.map(r => r.type))] as AzureResourceType[];
  const lineH = 17;
  const headerLines = 2;
  const landUseCount = 6;
  const rbacCount    = 3; // reader, contributor, owner
  const totalLines   = headerLines + landUseCount + 3 + rbacCount + visibleTypes.length;
  const lh = totalLines * lineH + 12;
  const lw = 172;
  const lx = mapW - lw - 12;
  const ly = mapH - lh - 42;

  const g = root.append('g').attr('class', 'os-legend');
  g.append('rect').attr('x', lx).attr('y', ly)
    .attr('width', lw).attr('height', lh)
    .attr('fill', OS.paper).attr('stroke', OS.cartoucheBorder).attr('stroke-width', 1);

  let row = 0;
  const textY = (r: number) => ly + 14 + r * lineH;

  g.append('text').attr('x', lx + lw/2).attr('y', textY(row))
    .attr('text-anchor', 'middle').attr('font-size', '8px').attr('font-weight', 'bold')
    .attr('letter-spacing', '1').attr('fill', OS.cartoucheBorder)
    .text('CONVENTIONAL SIGNS');
  row++;

  // Land use swatches
  g.append('text').attr('x', lx + 6).attr('y', textY(row))
    .attr('font-size', '7px').attr('font-style', 'italic').attr('fill', '#555')
    .text('Land cover');
  row++;

  const luEntries: Array<{ color: string; label: string }> = [
    { color: OS.landUse.forest,  label: 'Forest (stable/prod)' },
    { color: OS.landUse.arable,  label: 'Arable (dev/test)' },
    { color: OS.landUse.moorland, label: 'Moorland (untagged)' },
    { color: OS.landUse.water,   label: 'Water (data/storage)' },
    { color: OS.landUse.builtup, label: 'Built-up (compute)' },
    { color: OS.landUse.marsh,   label: 'Marsh (security risk)' },
  ];
  for (const e of luEntries) {
    g.append('rect').attr('x', lx + 8).attr('y', textY(row) - 8)
      .attr('width', 14).attr('height', 10)
      .attr('fill', e.color).attr('stroke', '#888').attr('stroke-width', 0.4);
    g.append('text').attr('x', lx + 28).attr('y', textY(row))
      .attr('font-size', '7.5px').attr('fill', OS.cartoucheBorder).text(e.label);
    row++;
  }

  // Contour + peering + hydrography
  const lineEntries = [
    { color: OS.contour,      width: 0.8, dash: '',    label: 'Contour' },
    { color: OS.contourIndex, width: 2.0, dash: '',    label: 'Index contour (×5)' },
    { color: '#8844BB',       width: 2.0, dash: '5,3', label: 'VNet Peering' },
  ];
  for (const e of lineEntries) {
    g.append('line').attr('x1', lx + 8).attr('y1', textY(row) - 4)
      .attr('x2', lx + 22).attr('y2', textY(row) - 4)
      .attr('stroke', e.color).attr('stroke-width', e.width)
      .attr('stroke-dasharray', e.dash || null);
    g.append('text').attr('x', lx + 28).attr('y', textY(row))
      .attr('font-size', '7.5px').attr('fill', OS.cartoucheBorder).text(e.label);
    row++;
  }

  // §5.6 Rights-of-way (RBAC layer)
  g.append('text').attr('x', lx + 6).attr('y', textY(row))
    .attr('font-size', '7px').attr('font-style', 'italic').attr('fill', '#555')
    .text('Rights of way (RBAC)');
  row++;

  const rbacEntries = [
    { color: '#E07070', dash: '5,4',   label: 'Reader — footpath' },
    { color: '#D4860A', dash: '8,3,2', label: 'Contributor — bridleway' },
    { color: '#8B4513', dash: '',      label: 'Owner — open track (BOAT)' },
  ];
  for (const e of rbacEntries) {
    g.append('line').attr('x1', lx + 8).attr('y1', textY(row) - 4)
      .attr('x2', lx + 22).attr('y2', textY(row) - 4)
      .attr('stroke', e.color).attr('stroke-width', 1.8)
      .attr('stroke-dasharray', e.dash || null);
    g.append('text').attr('x', lx + 28).attr('y', textY(row))
      .attr('font-size', '7.5px').attr('fill', OS.cartoucheBorder).text(e.label);
    row++;
  }

  // Resource symbols
  for (const type of visibleTypes) {
    const sample = resources.find(r => r.type === type);
    if (!sample) continue;
    const sym = sample.symbol;
    const sx = lx + 15, sy = textY(row) - 4;
    const tinyG = g.append('g').attr('transform', `translate(${sx},${sy}) scale(0.7)`);
    drawSymbol(tinyG as unknown as GrpSel, sample);
    g.append('text').attr('x', lx + 28).attr('y', textY(row))
      .attr('font-size', '7.5px').attr('fill', OS.cartoucheBorder)
      .text(`${sym.abbrev} — ${sym.description.split('(')[0]?.trim()}`);
    row++;
  }
}

// ---------------------------------------------------------------------------
// Cartouche
// ---------------------------------------------------------------------------

function renderCartouche(
  root: d3.Selection<SVGSVGElement, unknown, null, undefined>,
  scene: MapScene,
): void {
  const { mapW, mapH, cartouche } = scene;
  const M = 6, M2 = 10;
  const hdrH = 38, ftrH = 28;

  root.append('rect').attr('x', M).attr('y', M)
    .attr('width', mapW - 2*M).attr('height', mapH - 2*M)
    .attr('fill', 'none').attr('stroke', OS.cartoucheBorder).attr('stroke-width', 3);
  root.append('rect').attr('x', M2).attr('y', M2)
    .attr('width', mapW - 2*M2).attr('height', mapH - 2*M2)
    .attr('fill', 'none').attr('stroke', OS.cartoucheBorder).attr('stroke-width', 1);

  root.append('rect').attr('x', M2).attr('y', M2)
    .attr('width', mapW - 2*M2).attr('height', hdrH).attr('fill', OS.cartoucheHeader);
  root.append('text').attr('x', mapW/2).attr('y', M2 + hdrH/2 + 7)
    .attr('text-anchor', 'middle').attr('font-size', '15px').attr('font-weight', 'bold')
    .attr('letter-spacing', '0.3').attr('fill', OS.cartoucheBorder)
    .text(cartouche.title);

  root.append('text').attr('x', mapW/2).attr('y', M2 + hdrH + 12)
    .attr('text-anchor', 'middle').attr('font-size', '8px').attr('font-style', 'italic')
    .attr('fill', '#555').text(cartouche.subtitle);

  root.append('text').attr('x', mapW - M2 - 10).attr('y', M2 + hdrH - 5)
    .attr('text-anchor', 'end').attr('font-size', '7px').attr('fill', OS.cartoucheBorder)
    .text(cartouche.sheetRef);

  const ftrY = mapH - M2 - ftrH;
  root.append('rect').attr('x', M2).attr('y', ftrY)
    .attr('width', mapW - 2*M2).attr('height', ftrH).attr('fill', OS.cartoucheFooter);
  const ftrMid = ftrY + ftrH/2 + 5;
  root.append('text').attr('x', M2 + 14).attr('y', ftrMid)
    .attr('font-size', '8px').attr('fill', OS.cartoucheBorder)
    .text(`Survey date: ${cartouche.date}`);
  root.append('text').attr('x', mapW/2).attr('y', ftrMid)
    .attr('text-anchor', 'middle').attr('font-size', '8px').attr('fill', OS.cartoucheBorder)
    .text(cartouche.scaleLabel);
  root.append('text').attr('x', mapW - M2 - 10).attr('y', ftrMid)
    .attr('text-anchor', 'end').attr('font-size', '8px').attr('fill', OS.cartoucheBorder)
    .text(cartouche.estateStats);
}

// ---------------------------------------------------------------------------
// Road-tier filter (executive view — counties + major resources only)
// ---------------------------------------------------------------------------

const ROAD_TYPES: AzureResourceType[] = ['appgateway','frontdoor','aks','sql','cosmos','apim','keyvault'];

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

export function renderOsMap(svg: SVGSVGElement, scene: MapScene): void {
  const {
    mapW, mapH, counties, parishes, resources, vnetHulls, subnetHulls,
    linear, hydro, rbacPaths, contours, scaleTier,
  } = scene;
  const MARGIN = 72;

  const root = d3.select(svg) as d3.Selection<SVGSVGElement, unknown, null, undefined>;
  root.selectAll('*').remove();
  root.attr('width', mapW).attr('height', mapH).attr('viewBox', `0 0 ${mapW} ${mapH}`)
    .style('font-family', "'Source Sans 3', 'Gill Sans MT', 'Gill Sans', sans-serif");

  // Defs
  const defs = root.append('defs');
  for (const county of counties) {
    const cid = county.id.replace(/[^a-zA-Z0-9]/g, '_');
    defs.append('clipPath').attr('id', `clip-county-${cid}`)
      .append('path').attr('d', polyPath(county.polygon));
  }

  // Paper
  root.append('rect').attr('width', mapW).attr('height', mapH).attr('fill', OS.paper);

  // ---- L1: Land use ----
  const luLayer = root.append('g').attr('class', 'land-use');
  if (scaleTier === 'road') {
    counties.forEach(c => {
      luLayer.append('path').attr('d', polyPath(c.polygon))
        .attr('fill', '#F0E8D0').attr('stroke', 'none');
    });
  } else {
    parishes.forEach(p => {
      luLayer.append('path').attr('d', polyPath(p.polygon))
        .attr('fill', OS.landUse[p.landUse]).attr('stroke', 'none');
    });
  }

  // ---- L2: §5.6 Open-access overlay (mauve) on public-facing resources ----
  const oaLayer = root.append('g').attr('class', 'open-access');
  const visRes = scaleTier === 'road'
    ? resources.filter(r => ROAD_TYPES.includes(r.type) || r.isTrigPoint)
    : resources;
  for (const r of visRes) {
    if (r.type === 'publicip' || r.type === 'frontdoor' || r.type === 'appgateway') {
      oaLayer.append('circle')
        .attr('cx', r.pos[0]).attr('cy', r.pos[1]).attr('r', 26)
        .attr('fill', '#C8B5D4').attr('fill-opacity', 0.18)
        .attr('stroke', '#C8B5D4').attr('stroke-width', 1)
        .attr('stroke-dasharray', '4,3').attr('opacity', 0.7);
    }
  }

  // ---- L3: §6 Pass 5 Hydrography (data-flow rivers) ----
  if (scaleTier !== 'road') {
    const hydroLayer = root.append('g').attr('class', 'hydrography');
    for (const h of hydro) {
      const d = catmullPath(h.points);
      if (!d) continue;
      // Glow (wider, paler)
      hydroLayer.append('path').attr('d', d).attr('fill', 'none')
        .attr('stroke', '#B5D4F0').attr('stroke-width', h.width * 3)
        .attr('stroke-opacity', 0.45).attr('stroke-linecap', 'round');
      // Core river line
      hydroLayer.append('path').attr('d', d).attr('fill', 'none')
        .attr('stroke', OS.riverBlue).attr('stroke-width', h.width)
        .attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round');
    }
  }

  // ---- L4: Contours (Landranger + Explorer only) ----
  if (scaleTier !== 'road') {
    const conLayer = root.append('g').attr('class', 'contours');
    for (const c of contours) {
      const d = contourPath(c);
      if (!d) continue;
      conLayer.append('path').attr('d', d).attr('fill', 'none')
        .attr('stroke', c.isIndex ? OS.contourIndex : OS.contour)
        .attr('stroke-width', c.isIndex ? 1.6 : 0.65)
        .attr('opacity', c.isIndex ? 0.80 : 0.55);
    }
  }

  // ---- L5: §5.3 Subnet field boundaries (Landranger + Explorer) ----
  if (scaleTier !== 'road') {
    const subnetLayer = root.append('g').attr('class', 'subnet-boundaries');
    for (const hull of subnetHulls) {
      subnetLayer.append('path').attr('d', polyPath(hull.hull))
        .attr('fill', 'none')
        .attr('stroke', '#7A9A74').attr('stroke-width', 0.7)
        .attr('stroke-dasharray', '2,3').attr('opacity', 0.65);
      // Field boundary label (Explorer only)
      if (scaleTier === 'explorer' && hull.hull.length >= 3) {
        const cen = hull.hull.reduce(
          ([ax, ay], [x, y]) => [ax + x / hull.hull.length, ay + y / hull.hull.length],
          [0, 0],
        );
        subnetLayer.append('text').attr('x', cen[0]).attr('y', cen[1])
          .attr('text-anchor', 'middle').attr('font-size', '6px')
          .attr('fill', '#7A9A74').attr('opacity', 0.8).text(hull.name);
      }
    }
  }

  // ---- L6: VNet hulls (network topology overlay) ----
  if (scaleTier !== 'road') {
    const hullLayer = root.append('g').attr('class', 'vnet-hulls');
    for (const hull of vnetHulls) {
      hullLayer.append('path').attr('d', polyPath(hull.hull))
        .attr('fill', hull.color).attr('fill-opacity', 0.06)
        .attr('stroke', hull.color).attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '6,4').attr('opacity', 0.7);
    }
  }

  // ---- L7: §5.6 RBAC rights-of-way layer ----
  if (scaleTier !== 'road') {
    const RBAC_STYLE: Record<string, { color: string; dash: string; width: number }> = {
      reader:      { color: '#E07070', dash: '5,4',   width: 1.5 },
      contributor: { color: '#D4860A', dash: '8,3,2', width: 2.0 },
      owner:       { color: '#8B4513', dash: '',      width: 2.5 },
    };
    const rbacLayer = root.append('g').attr('class', 'rbac-paths');
    for (const path of rbacPaths) {
      const style = RBAC_STYLE[path.role]!;
      // County-scope paths are slightly inset (drawn on boundary); parish-scope on inner boundary
      rbacLayer.append('path').attr('d', polyPath(path.polygon))
        .attr('fill', 'none')
        .attr('stroke', style.color).attr('stroke-width', style.width)
        .attr('stroke-dasharray', style.dash || null)
        .attr('opacity', path.scope === 'subscription' ? 0.55 : 0.70)
        .attr('stroke-linejoin', 'round');
    }
  }

  // ---- L8: County boundaries (Subscriptions) ----
  const countyLayer = root.append('g').attr('class', 'county-boundaries');
  counties.forEach(c => {
    countyLayer.append('path').attr('d', polyPath(c.polygon))
      .attr('fill', 'none').attr('stroke', OS.countyBoundary)
      .attr('stroke-width', 2.5).attr('stroke-dasharray', '12,5');
  });

  // ---- L9: Parish boundaries (RGs — Landranger+Explorer only) ----
  if (scaleTier !== 'road') {
    const parLayer = root.append('g').attr('class', 'parish-boundaries');
    parishes.forEach(p => {
      parLayer.append('path').attr('d', polyPath(p.polygon))
        .attr('fill', 'none').attr('stroke', OS.parishBoundary)
        .attr('stroke-width', 0.8).attr('stroke-dasharray', OS.parishBoundaryDash);
    });
  }

  // ---- L10: Linear features (peerings, ER motorway, VPN A-road) ----
  const linLayer = root.append('g').attr('class', 'linear-features');
  for (const feat of linear) {
    const d = catmullPath(feat.points as Array<[number, number]>);
    if (!d) continue;

    // §5.6 Transport hierarchy: OS colour grammar
    if (feat.type === 'expressroute') {
      // Motorway: yellow casing + blue fill
      linLayer.append('path').attr('d', d).attr('fill', 'none')
        .attr('stroke', '#FFEE44').attr('stroke-width', feat.width + 2)
        .attr('stroke-linecap', 'round');
    } else if (feat.type === 'vpn') {
      // A-road: white casing + red fill
      linLayer.append('path').attr('d', d).attr('fill', 'none')
        .attr('stroke', 'white').attr('stroke-width', feat.width + 1.5)
        .attr('stroke-linecap', 'round');
    }

    linLayer.append('path').attr('d', d).attr('fill', 'none')
      .attr('stroke', feat.color).attr('stroke-width', feat.width)
      .attr('stroke-dasharray', feat.dash || null)
      .attr('stroke-linecap', 'round');

    if (feat.label && scaleTier === 'explorer') {
      const mid = feat.points[Math.floor(feat.points.length / 2)];
      if (mid) linLayer.append('text').attr('x', mid[0]).attr('y', mid[1] - 5)
        .attr('text-anchor', 'middle').attr('font-size', '7px')
        .attr('fill', feat.color).attr('font-style', 'italic')
        .text(feat.label);
    }
  }

  // ---- L11: Grid lines ----
  renderGrid(root, mapW, mapH, MARGIN);

  // ---- L12: Resource symbols ----
  const symLayer = root.append('g').attr('class', 'symbols');
  for (const r of visRes) {
    const g = symLayer.append('g')
      .attr('class', 'resource')
      .attr('transform', `translate(${r.pos[0].toFixed(1)},${r.pos[1].toFixed(1)})`)
      .style('cursor', 'pointer');

    drawSymbol(g as unknown as GrpSel, r);
    g.append('title').text(r.tooltip);

    const lbl = r.symbol.label.length > 14 ? r.symbol.label.slice(0, 12) + '…' : r.symbol.label;
    g.append('text').attr('dy', r.symbol.size / 2 + 10).attr('text-anchor', 'middle')
      .attr('font-size', '8px').attr('fill', OS.textResource).text(lbl);
  }

  // ---- L13: Spot heights for top resources by elevation ----
  if (scaleTier !== 'road') {
    const shLayer = root.append('g').attr('class', 'spot-heights');
    const top = [...resources].sort((a, b) => b.elevation - a.elevation).slice(0, 4);
    for (const r of top) {
      shLayer.append('circle').attr('cx', r.pos[0]).attr('cy', r.pos[1] - r.symbol.size/2 - 2)
        .attr('r', 1.5).attr('fill', OS.spotHeight);
      shLayer.append('text').attr('x', r.pos[0] + r.symbol.size/2 + 3)
        .attr('y', r.pos[1] - r.symbol.size/2 - 1)
        .attr('font-size', '7px').attr('font-weight', 'bold').attr('fill', OS.spotHeight)
        .text(r.elevation.toFixed(1));
    }
  }

  // ---- L14: Labels (typography as data) ----
  const lblLayer = root.append('g').attr('class', 'labels');

  // §5.6 Typography: County (Subscription) = bold all-caps, ghost
  for (const c of counties) {
    lblLayer.append('text').attr('x', c.centroid[0]).attr('y', c.centroid[1])
      .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
      .attr('font-size', scaleTier === 'road' ? '16px' : '14px')
      .attr('font-weight', 'bold').attr('font-variant', 'all-small-caps')
      .attr('letter-spacing', '2').attr('fill', OS.textCounty).attr('opacity', 0.25)
      .text(c.name.toUpperCase());

    if (scaleTier === 'road') {
      lblLayer.append('text').attr('x', c.centroid[0]).attr('y', c.centroid[1] + 18)
        .attr('text-anchor', 'middle').attr('font-size', '10px').attr('fill', '#666').attr('opacity', 0.7)
        .text(`~£${Math.round(c.totalCost).toLocaleString()}/mo`);
    }
  }

  // §5.6 Typography: Parish (RG) = caps regular, ghost
  if (scaleTier !== 'road') {
    for (const p of parishes) {
      lblLayer.append('text').attr('x', p.centroid[0]).attr('y', p.centroid[1] - 8)
        .attr('text-anchor', 'middle').attr('font-size', '9px').attr('letter-spacing', '0.5')
        .attr('fill', OS.textParish).attr('opacity', 0.65).text(p.name.toUpperCase());

      if (p.environment) {
        lblLayer.append('text').attr('x', p.centroid[0]).attr('y', p.centroid[1] + 5)
          .attr('text-anchor', 'middle').attr('font-size', '7px').attr('font-style', 'italic')
          .attr('fill', OS.textParish).attr('opacity', 0.5).text(p.environment);
      }
    }
  }

  // VNet hull labels (Explorer tier)
  if (scaleTier === 'explorer') {
    for (const hull of vnetHulls) {
      lblLayer.append('text').attr('x', hull.centroid[0]).attr('y', hull.centroid[1])
        .attr('text-anchor', 'middle').attr('font-size', '8px').attr('font-style', 'italic')
        .attr('fill', hull.color).attr('opacity', 0.8).text(hull.name);
    }
  }

  // ---- Cartouche, legend, north arrow, scale bar, mag var (always on top) ----
  renderCartouche(root, scene);
  renderLegend(root, scene);
  renderNorthArrow(root, mapW - MARGIN/2 - 4, MARGIN + 35);
  renderScaleBar(root, MARGIN + 20, mapH - MARGIN - 20, scene.cartouche.scaleLabel);
  renderMagVarDiagram(root, mapW - MARGIN + 20, mapH - MARGIN + 12);
}
