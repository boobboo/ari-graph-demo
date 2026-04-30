import * as THREE from 'three';
import type { World, PlacedVm, PlacedSubnet, PlacedVnet } from './types';

// ---- Topographical map tunables ----
// The whole map is one rolling landmass. The VNet/subnet groupings ARE the
// mountains; individual VMs only add modest summit character — they don't poke
// up as spikes. Heavy smoothing knits everything (noise, peaks, plateaus) into
// a single flowing fabric of terrain.
const GRID_CELL = 0.5;
const PADDING = 36;             // generous border so terrain fades into open country
// VM bump: wide and gentle so peaks read as rounded summit knolls, not pencils.
const VM_SIGMA = 1.4;
const VM_BASE = 0.55;           // small base bump per VM
const VM_PER_HEIGHT = 0.55;     // modest extra rise per sqrt(tower-height) unit
// Subnets are sub-ranges that sit on the larger VNet mountain.
const SUBNET_AMP = 1.7;
const SUBNET_SIGMA_K = 0.7;
// VNets are the dominant mountains — wide and tall, so subnets read as
// shoulders on them rather than separate hills.
const VNET_AMP = 5.0;
const VNET_SIGMA_K = 1.15;      // very wide so multiple vnets blend at their edges
// Peering: a substantial mountain ridge linking the two VNet summits.
const PEERING_RIDGE_AMP = 3.6;
const PEERING_RIDGE_WIDTH = 16;
// Background fBm noise gives the land texture everywhere so it never reads
// like a smooth dome with sharp summit features stuck on top.
const NOISE_AMP = 1.6;
const NOISE_FREQ = 0.05;
const SMOOTH_PASSES = 4;        // blend hard splats into rolling terrain
const EDGE_FALLOFF_FRAC = 0.85; // smoother fade at the map border
const BASE_GROUND = 0.0;
const CONTOUR_BANDS = 18;
const COLOR_HIGH_PCT = 0.985;
const COLOR_LOW_PCT = 0.04;
const SUBNET_EDGE_CAP = 200;

// Unified terrestrial palette — low valleys to snowy peaks, no ocean break.
const PALETTE: Array<[number, number, number]> = [
  [ 96, 128,  92],   // valley moss
  [120, 152, 100],   // meadow
  [148, 178, 110],   // grassland
  [172, 192, 116],   // dry grass
  [196, 200, 128],   // savannah
  [210, 196, 132],   // sandstone
  [206, 178, 124],   // tan rock
  [192, 158, 110],   // brown rock
  [176, 138,  96],   // dark rock
  [160, 128,  92],   // weathered rock
  [168, 142, 110],   // talus
  [188, 168, 142],   // high scree
  [212, 198, 178],   // alpine
  [232, 222, 208],   // snow line
  [248, 248, 248],   // peak snow
];

const OS_TINT: Record<string, number> = {
  linux:   0xf0c674,
  windows: 0x81a2be,
  other:   0xc5c8c6,
};

export interface BuiltScene {
  scene: THREE.Scene;
  vmTowers: THREE.InstancedMesh[];      // for raycasting (one instance per VM)
  vmIndex: PlacedVm[];
  vmInstanceMap: Map<THREE.InstancedMesh, PlacedVm[]>;
  spawn: { pos: THREE.Vector3; lookAt: THREE.Vector3 };
  dispose(): void;
}

export function buildScene(world: World): BuiltScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd9e6ed);
  scene.fog = new THREE.Fog(0xd9e6ed, 160, 1100);

  // ---- Lighting: low-angle sun gives the terrain readable shading ----
  const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 0.7);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 0.95);
  sun.position.set(160, 220, 110);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xa9c4ff, 0.35);
  fill.position.set(-120, 80, -90);
  scene.add(fill);

  const disposables: Array<{ dispose(): void }> = [];

  // ---- Heightfield bounds ----
  const minX = world.bounds.min[0] - PADDING;
  const maxX = world.bounds.max[0] + PADDING;
  const minZ = world.bounds.min[1] - PADDING;
  const maxZ = world.bounds.max[1] + PADDING;
  const width = maxX - minX;
  const depth = maxZ - minZ;
  const cols = Math.max(8, Math.round(width / GRID_CELL));
  const rows = Math.max(8, Math.round(depth / GRID_CELL));

  const elev = computeElevation(world, minX, minZ, width, depth, cols, rows);

  // Use percentiles for the colour/contour range so isolated outliers (one very
  // tall VM, or the noisy floor) don't compress the palette in the middle bands.
  const sorted = Float32Array.from(elev).sort();
  const eMin = sorted[Math.floor(sorted.length * COLOR_LOW_PCT)];
  const eMax = Math.max(
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * COLOR_HIGH_PCT))],
    eMin + 1,
  );

  // ---- Build terrain mesh ----
  const geom = new THREE.PlaneGeometry(width, depth, cols - 1, rows - 1);
  geom.rotateX(-Math.PI / 2);
  // Translate to align with world bounds.
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  geom.translate(cx, 0, cz);

  const posAttr = geom.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(posAttr.count * 3);
  // PlaneGeometry vertex order: row by row, top→bottom. After rotateX, +z grows down.
  // Use the same (col,row) iteration the elevation array uses.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const h = elev[idx];
      posAttr.setY(idx, h);
      const t = clamp01((h - eMin) / Math.max(1e-6, eMax - eMin));
      const banded = bandColor(t, CONTOUR_BANDS);
      colors[idx * 3] = banded[0];
      colors[idx * 3 + 1] = banded[1];
      colors[idx * 3 + 2] = banded[2];
    }
  }
  posAttr.needsUpdate = true;
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.computeVertexNormals();

  const terrainMat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: false,
  });
  disposables.push(geom, terrainMat);
  const terrain = new THREE.Mesh(geom, terrainMat);
  scene.add(terrain);

  // ---- Contour lines: iso-elevation polylines via marching squares ----
  const contourPositions: number[] = [];
  for (let k = 1; k < CONTOUR_BANDS; k++) {
    const level = eMin + (eMax - eMin) * (k / CONTOUR_BANDS);
    marchingSquares(elev, cols, rows, level, minX, minZ, width, depth, (x1, z1, x2, z2) => {
      const y = level + 0.04;
      contourPositions.push(x1, y, z1, x2, y, z2);
    });
  }
  if (contourPositions.length) {
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(contourPositions, 3));
    const cm = new THREE.LineBasicMaterial({ color: 0x2a2418, transparent: true, opacity: 0.38 });
    disposables.push(cg, cm);
    scene.add(new THREE.LineSegments(cg, cm));
  }

  // VNet / subnet outlines suppressed in topo mode: the terrain itself
  // (continents, ridges, summit highlands) communicates the grouping. Hard
  // rectangles would make logical groups read as separate bordered islands.

  // ---- Labels: VNet name floats above the highest peak in that VNet ----
  for (const vn of world.vnets) {
    const yC = sampleHeight(elev, cols, rows, minX, minZ, width, depth, vn.center[0], vn.center[1]);
    addLabelSprite(scene, vn.name, vn.center[0], yC + 5, vn.center[1], 0.9, 0xffffff, disposables, Math.min(vn.size, 22));
  }
  for (const s of world.subnets) {
    const lbl = s.cidr ? `${s.name} (${s.cidr})` : s.name;
    const ys = sampleHeight(elev, cols, rows, minX, minZ, width, depth, s.center[0], s.center[1]);
    addLabelSprite(scene, lbl, s.center[0], ys + 2.0, s.center[1], 0.55, 0xf0f4f8, disposables, Math.min(s.size, 14));
  }

  // ---- VM marker pins (small spheres at the peak), instanced per OS ----
  const buckets: Record<string, PlacedVm[]> = { linux: [], windows: [], other: [] };
  for (const vm of world.vms) buckets[vm.os].push(vm);

  const vmTowers: THREE.InstancedMesh[] = [];
  const vmInstanceMap = new Map<THREE.InstancedMesh, PlacedVm[]>();
  const sphereGeom = new THREE.SphereGeometry(0.32, 10, 8);
  disposables.push(sphereGeom);

  for (const os of Object.keys(buckets) as Array<keyof typeof buckets>) {
    const list = buckets[os];
    if (list.length === 0) continue;
    const mat = new THREE.MeshLambertMaterial({ color: OS_TINT[os] });
    disposables.push(mat);
    const inst = new THREE.InstancedMesh(sphereGeom, mat, list.length);
    inst.userData.os = os;
    const dummy = new THREE.Object3D();
    list.forEach((vm, i) => {
      const y = sampleHeight(elev, cols, rows, minX, minZ, width, depth, vm.pos[0], vm.pos[2]);
      dummy.position.set(vm.pos[0], y + 0.35, vm.pos[2]);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = true;
    scene.add(inst);
    vmTowers.push(inst);
    vmInstanceMap.set(inst, list);
  }

  // Peerings appear as raised mountain ridges in the terrain itself
  // (added during elevation pass) — no floating arches needed in topo mode.
  void SUBNET_EDGE_CAP;

  // ---- Spawn camera obliquely so the relief reads immediately ----
  const cxc = (world.bounds.min[0] + world.bounds.max[0]) / 2;
  const czc = (world.bounds.min[1] + world.bounds.max[1]) / 2;
  const span = Math.max(world.bounds.max[0] - world.bounds.min[0], world.bounds.max[1] - world.bounds.min[1]);
  const peakH = eMax;
  const spawnY = Math.max(45, peakH + 22, span * 0.45);
  const spawnPos = new THREE.Vector3(cxc - span * 0.3, spawnY, czc + span * 0.7);
  const spawnLook = new THREE.Vector3(cxc, peakH * 0.35, czc);

  return {
    scene,
    vmTowers,
    vmIndex: world.vms,
    vmInstanceMap,
    spawn: { pos: spawnPos, lookAt: spawnLook },
    dispose() {
      for (const d of disposables) d.dispose();
      for (const inst of vmTowers) {
        if (Array.isArray(inst.material)) for (const m of inst.material) m.dispose();
        else inst.material.dispose();
      }
    },
  };
}

// ---- Heightfield computation ----------------------------------------------

function computeElevation(
  world: World,
  minX: number, minZ: number, width: number, depth: number,
  cols: number, rows: number,
): Float32Array {
  const elev = new Float32Array(cols * rows);
  const cellW = width / (cols - 1);
  const cellD = depth / (rows - 1);

  // Pass 1: gentle fBm noise across the whole map so it never reads as flat.
  for (let r = 0; r < rows; r++) {
    const wz = minZ + r * cellD;
    for (let c = 0; c < cols; c++) {
      const wx = minX + c * cellW;
      elev[r * cols + c] = BASE_GROUND + NOISE_AMP * fbm(wx * NOISE_FREQ, wz * NOISE_FREQ);
    }
  }

  // Splat: additive Gaussian bump.
  function splat(x: number, z: number, amp: number, sigma: number) {
    const radius = sigma * 3.5;
    const c0 = Math.max(0, Math.floor((x - radius - minX) / cellW));
    const c1 = Math.min(cols - 1, Math.ceil((x + radius - minX) / cellW));
    const r0 = Math.max(0, Math.floor((z - radius - minZ) / cellD));
    const r1 = Math.min(rows - 1, Math.ceil((z + radius - minZ) / cellD));
    const inv2s2 = 1 / (2 * sigma * sigma);
    for (let r = r0; r <= r1; r++) {
      const wz = minZ + r * cellD;
      const dz = wz - z;
      for (let c = c0; c <= c1; c++) {
        const wx = minX + c * cellW;
        const dx = wx - x;
        const d2 = dx * dx + dz * dz;
        const g = Math.exp(-d2 * inv2s2);
        elev[r * cols + c] += amp * g;
      }
    }
  }

  // Pass 2: VNet "continents". Wide so adjacent vnets blend into one landmass.
  for (const vn of world.vnets) {
    const sigma = Math.max(8, vn.size * VNET_SIGMA_K);
    splat(vn.center[0], vn.center[1], VNET_AMP, sigma);
  }

  // Pass 3: Peering ridges. Raise a soft mountain ridge along the line between peered vnets.
  for (const p of world.peerings) {
    const a = world.vnetById.get(p.a);
    const b = world.vnetById.get(p.b);
    if (!a || !b) continue;
    ridge(elev, cols, rows, minX, minZ, cellW, cellD,
      a.center[0], a.center[1], b.center[0], b.center[1],
      PEERING_RIDGE_AMP, PEERING_RIDGE_WIDTH);
  }

  // Pass 4: subnet highlands.
  for (const s of world.subnets) {
    const sigma = Math.max(3.5, s.size * SUBNET_SIGMA_K);
    splat(s.center[0], s.center[1], SUBNET_AMP, sigma);
  }

  // Pass 5: VM peaks. sqrt-compressed so one huge VM doesn't dwarf the rest.
  for (const vm of world.vms) {
    const amp = VM_BASE + VM_PER_HEIGHT * Math.sqrt(Math.max(1, vm.height));
    splat(vm.pos[0], vm.pos[2], amp, VM_SIGMA);
  }

  // Pass 6: edge falloff toward the base ground level so the map fades out smoothly
  // at its border rather than ending in a hard cliff.
  {
    const bx0 = world.bounds.min[0];
    const bx1 = world.bounds.max[0];
    const bz0 = world.bounds.min[1];
    const bz1 = world.bounds.max[1];
    const fade = PADDING * EDGE_FALLOFF_FRAC;
    for (let r = 0; r < rows; r++) {
      const wz = minZ + r * cellD;
      for (let c = 0; c < cols; c++) {
        const wx = minX + c * cellW;
        const dx = wx < bx0 ? bx0 - wx : (wx > bx1 ? wx - bx1 : 0);
        const dz = wz < bz0 ? bz0 - wz : (wz > bz1 ? wz - bz1 : 0);
        const d = Math.hypot(dx, dz);
        if (d <= 0) continue;
        const t = smoothstep(clamp01(d / fade));
        const i = r * cols + c;
        elev[i] = elev[i] * (1 - t) + BASE_GROUND * t;
      }
    }
  }

  // Pass 7: smoothing — knit everything into one continuous fabric.
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    boxBlur(elev, cols, rows);
  }

  return elev;
}

// 3x3 box blur (in-place via temp buffer). Border cells are clamped.
function boxBlur(field: Float32Array, cols: number, rows: number) {
  const tmp = new Float32Array(field.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0, n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols) continue;
          sum += field[rr * cols + cc];
          n++;
        }
      }
      tmp[r * cols + c] = sum / n;
    }
  }
  field.set(tmp);
}

// Raised ridge along segment AB: each cell gets +amp * cos²(πd/(2w)) where d is
// perpendicular distance, falling to 0 at d>=width. Ends are tapered.
function ridge(
  elev: Float32Array, cols: number, rows: number,
  minX: number, minZ: number, cellW: number, cellD: number,
  ax: number, az: number, bx: number, bz: number,
  amp: number, width: number,
) {
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < 1e-3) return;
  const nx = dx / len, nz = dz / len;
  // Bounding box of the ridge (with width margin).
  const bbMinX = Math.min(ax, bx) - width;
  const bbMaxX = Math.max(ax, bx) + width;
  const bbMinZ = Math.min(az, bz) - width;
  const bbMaxZ = Math.max(az, bz) + width;
  const c0 = Math.max(0, Math.floor((bbMinX - minX) / cellW));
  const c1 = Math.min(cols - 1, Math.ceil((bbMaxX - minX) / cellW));
  const r0 = Math.max(0, Math.floor((bbMinZ - minZ) / cellD));
  const r1 = Math.min(rows - 1, Math.ceil((bbMaxZ - minZ) / cellD));
  for (let r = r0; r <= r1; r++) {
    const wz = minZ + r * cellD;
    for (let c = c0; c <= c1; c++) {
      const wx = minX + c * cellW;
      const px = wx - ax, pz = wz - az;
      // Project onto the segment.
      const t = px * nx + pz * nz;
      if (t < 0 || t > len) continue;
      // Perpendicular distance.
      const perpX = px - t * nx;
      const perpZ = pz - t * nz;
      const d = Math.hypot(perpX, perpZ);
      if (d >= width) continue;
      // Cosine bump perpendicular, taper at endpoints.
      const perpFall = 0.5 + 0.5 * Math.cos(Math.PI * (d / width));
      const endFade = Math.min(1, t / (width * 0.6), (len - t) / (width * 0.6));
      elev[r * cols + c] += amp * perpFall * Math.max(0, endFade);
    }
  }
}

// Cheap value-noise + 4-octave fBm. Deterministic, no dependencies.
function fbm(x: number, y: number): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    sum += amp * valueNoise(x * freq, y * freq);
    amp *= 0.5;
    freq *= 2.0;
  }
  return sum * 2 - 1; // roughly -1..1
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const v00 = hash2(xi, yi);
  const v10 = hash2(xi + 1, yi);
  const v01 = hash2(xi, yi + 1);
  const v11 = hash2(xi + 1, yi + 1);
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = v00 + (v10 - v00) * u;
  const b = v01 + (v11 - v01) * u;
  return a + (b - a) * v;
}

function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177 | 0;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function sampleHeight(
  elev: Float32Array, cols: number, rows: number,
  minX: number, minZ: number, width: number, depth: number,
  x: number, z: number,
): number {
  const cellW = width / (cols - 1);
  const cellD = depth / (rows - 1);
  const fc = (x - minX) / cellW;
  const fr = (z - minZ) / cellD;
  const c0 = Math.max(0, Math.min(cols - 1, Math.floor(fc)));
  const r0 = Math.max(0, Math.min(rows - 1, Math.floor(fr)));
  const c1 = Math.min(cols - 1, c0 + 1);
  const r1 = Math.min(rows - 1, r0 + 1);
  const tx = clamp01(fc - c0);
  const tz = clamp01(fr - r0);
  const h00 = elev[r0 * cols + c0];
  const h10 = elev[r0 * cols + c1];
  const h01 = elev[r1 * cols + c0];
  const h11 = elev[r1 * cols + c1];
  const a = h00 * (1 - tx) + h10 * tx;
  const b = h01 * (1 - tx) + h11 * tx;
  return a * (1 - tz) + b * tz;
}

// ---- Marching squares: emits line segments for an iso-contour ----
function marchingSquares(
  elev: Float32Array, cols: number, rows: number, level: number,
  minX: number, minZ: number, width: number, depth: number,
  emit: (x1: number, z1: number, x2: number, z2: number) => void,
) {
  const cellW = width / (cols - 1);
  const cellD = depth / (rows - 1);
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const tl = elev[r * cols + c];
      const tr = elev[r * cols + c + 1];
      const br = elev[(r + 1) * cols + c + 1];
      const bl = elev[(r + 1) * cols + c];
      let idx = 0;
      if (tl > level) idx |= 1;
      if (tr > level) idx |= 2;
      if (br > level) idx |= 4;
      if (bl > level) idx |= 8;
      if (idx === 0 || idx === 15) continue;

      const xL = minX + c * cellW;
      const xR = xL + cellW;
      const zT = minZ + r * cellD;
      const zB = zT + cellD;

      // Linear interpolation along each edge where it crosses `level`.
      const top = (): [number, number] => {
        const t = (level - tl) / (tr - tl);
        return [xL + t * cellW, zT];
      };
      const right = (): [number, number] => {
        const t = (level - tr) / (br - tr);
        return [xR, zT + t * cellD];
      };
      const bottom = (): [number, number] => {
        const t = (level - bl) / (br - bl);
        return [xL + t * cellW, zB];
      };
      const left = (): [number, number] => {
        const t = (level - tl) / (bl - tl);
        return [xL, zT + t * cellD];
      };

      // Each case is one or two short segments connecting edge crossings.
      // Reference: https://en.wikipedia.org/wiki/Marching_squares
      const seg = (a: [number, number], b: [number, number]) => emit(a[0], a[1], b[0], b[1]);
      switch (idx) {
        case 1:  seg(left(), top()); break;
        case 2:  seg(top(), right()); break;
        case 3:  seg(left(), right()); break;
        case 4:  seg(right(), bottom()); break;
        case 5:  // saddle
          seg(left(), top()); seg(right(), bottom()); break;
        case 6:  seg(top(), bottom()); break;
        case 7:  seg(left(), bottom()); break;
        case 8:  seg(left(), bottom()); break;
        case 9:  seg(top(), bottom()); break;
        case 10: // saddle
          seg(left(), bottom()); seg(top(), right()); break;
        case 11: seg(top(), right()); break;
        case 12: seg(left(), right()); break;
        case 13: seg(top(), right()); break;
        case 14: seg(left(), top()); break;
      }
    }
  }
}

// ---- Helpers --------------------------------------------------------------

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function bandColor(t: number, bands: number): [number, number, number] {
  const b = Math.min(bands - 1, Math.max(0, Math.floor(t * bands)));
  const palIdx = Math.min(PALETTE.length - 1, Math.floor((b / Math.max(1, bands - 1)) * (PALETTE.length - 1)));
  const c = PALETTE[palIdx];
  return [c[0] / 255, c[1] / 255, c[2] / 255];
}

function pushRectOutline(
  scene: THREE.Scene,
  rects: Array<{ cx: number; cz: number; size: number; color: number; opacity: number; width: number }>,
  elev: Float32Array, minX: number, minZ: number, width: number, depth: number, cols: number, rows: number,
  disposables: Array<{ dispose(): void }>,
) {
  if (rects.length === 0) return;
  const positions: number[] = [];
  const colorsArr: number[] = [];
  const SAMPLES_PER_EDGE = 24;
  for (const r of rects) {
    const half = r.size / 2;
    const corners: Array<[number, number]> = [
      [r.cx - half, r.cz - half],
      [r.cx + half, r.cz - half],
      [r.cx + half, r.cz + half],
      [r.cx - half, r.cz + half],
    ];
    const rgb = [(r.color >> 16 & 0xff) / 255, (r.color >> 8 & 0xff) / 255, (r.color & 0xff) / 255];
    for (let e = 0; e < 4; e++) {
      const a = corners[e];
      const b = corners[(e + 1) % 4];
      let prevX = a[0], prevZ = a[1];
      let prevY = sampleHeight(elev, cols, rows, minX, minZ, width, depth, prevX, prevZ) + 0.18;
      for (let s = 1; s <= SAMPLES_PER_EDGE; s++) {
        const t = s / SAMPLES_PER_EDGE;
        const x = a[0] + (b[0] - a[0]) * t;
        const z = a[1] + (b[1] - a[1]) * t;
        const y = sampleHeight(elev, cols, rows, minX, minZ, width, depth, x, z) + 0.18;
        positions.push(prevX, prevY, prevZ, x, y, z);
        colorsArr.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
        prevX = x; prevZ = z; prevY = y;
      }
    }
    void r.width;
    // Note: opacity baked into the material below; per-rect opacity blends through alpha
    // Same opacity works visually fine across both layers since we draw vnets first.
    void r.opacity;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colorsArr, 3));
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55 });
  disposables.push(geom, mat);
  scene.add(new THREE.LineSegments(geom, mat));
}

function pushArch(
  out: number[],
  a: [number, number], b: [number, number],
  yA: number, yB: number, peakHeight: number, segments = 22,
) {
  const ax = a[0], az = a[1], bx = b[0], bz = b[1];
  const mx = (ax + bx) / 2;
  const mz = (az + bz) / 2;
  for (let i = 0; i < segments; i++) {
    const t1 = i / segments;
    const t2 = (i + 1) / segments;
    const p1 = bezier(ax, az, mx, mz, bx, bz, yA, yB, peakHeight, t1);
    const p2 = bezier(ax, az, mx, mz, bx, bz, yA, yB, peakHeight, t2);
    out.push(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
  }
}

function bezier(
  ax: number, az: number, mx: number, mz: number, bx: number, bz: number,
  yA: number, yB: number, peak: number, t: number,
): [number, number, number] {
  const u = 1 - t;
  const x = u * u * ax + 2 * u * t * mx + t * t * bx;
  const z = u * u * az + 2 * u * t * mz + t * t * bz;
  const y = u * u * (yA + 0.5) + 2 * u * t * peak + t * t * (yB + 0.5);
  return [x, y, z];
}

function addLabelSprite(
  scene: THREE.Scene,
  text: string,
  x: number,
  y: number,
  z: number,
  scale: number,
  color: number,
  disposables: Array<{ dispose(): void }>,
  worldWidth: number,
) {
  const canvas = document.createElement('canvas');
  const padding = 12;
  const fontSize = 48;
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(8,12,18,0.6)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
  ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  let display = text;
  if (ctx.measureText(display).width > canvas.width - padding * 2) {
    while (display.length > 4 && ctx.measureText(display + '…').width > canvas.width - padding * 2) {
      display = display.slice(0, -1);
    }
    display += '…';
  }
  ctx.fillText(display, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const w = Math.min(worldWidth * 0.6, 24) * scale;
  sprite.scale.set(w, w * (canvas.height / canvas.width), 1);
  sprite.position.set(x, y, z);
  scene.add(sprite);
  disposables.push(tex, mat);
}
