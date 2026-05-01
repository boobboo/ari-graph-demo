import * as THREE from 'three';
import type { World, PlacedVm } from './types';

// ---- SimCity-style tunables ----
// VNets are hills. Subnets are neighborhood plots on the hilltop. VMs are
// houses, sized by vCPU + RAM. Subnets are wired by little streets, VNets
// are joined by bridge-roads where peerings exist.
const HILL_BASE_HEIGHT = 3.5;       // shortest VNet hill, before bonus rises
const HILL_PER_SUBNET = 1.2;        // each extra subnet raises the hill
const HILL_PER_PEERING = 2.0;       // each peering on this VNet raises the hill more
const HILL_TOP_INSET = 6;           // top plateau is smaller than the base footprint
const HILL_SIDES = 12;              // octagonal-ish low-poly hill
const PLOT_LIFT = 0.18;             // subnet plot sits this far above the hill plateau
const ROAD_LIFT = 0.04;             // roads sit just above the plot
const ROAD_HALFWIDTH = 0.55;        // thickness of a residential street
const MAIN_ROAD_HALFWIDTH = 0.95;
const BRIDGE_HALFWIDTH = 1.1;
const HOUSE_MIN = 1.6;              // smallest house side (small VM)
const HOUSE_MAX = 3.6;              // largest house side (huge VM)
const HOUSE_ROOF_PITCH = 0.7;       // roof height as a fraction of body width
const HOUSE_BODY_HEIGHT = 1.2;      // body height fraction of side
const BRIDGE_HEIGHT = 0.5;          // 3D bridge thickness so it reads from any angle

const HOUSE_COLORS: Record<string, number> = {
  linux:   0xd6a45a,   // warm tan stucco
  windows: 0xc4d3e0,   // pale blue siding
  other:   0xb6b6b0,   // grey siding
};
const ROOF_COLORS: Record<string, number> = {
  linux:   0x8b4f2e,   // brown shingle
  windows: 0x4a5a6c,   // slate
  other:   0x555550,   // charcoal
};

const HILL_SIDE_COLOR = 0x6f9c5c;      // grass slope
const HILL_TOP_COLOR = 0x88b46a;       // brighter top grass
const PLOT_COLOR = 0xa6c97a;           // mowed neighborhood lawn
const ROAD_COLOR = 0x5a5a55;           // asphalt
const GROUND_COLOR = 0x4d6a4a;         // surrounding meadow / countryside

export interface BuiltScene {
  scene: THREE.Scene;
  vmTowers: THREE.InstancedMesh[];      // bodies are the hover targets
  vmIndex: PlacedVm[];
  vmInstanceMap: Map<THREE.InstancedMesh, PlacedVm[]>;
  spawn: { pos: THREE.Vector3; lookAt: THREE.Vector3 };
  dispose(): void;
}

export function buildScene(world: World): BuiltScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xc7e1f0);
  scene.fog = new THREE.Fog(0xc7e1f0, 140, 800);

  // ---- Lights: warm key, cool fill ----
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.65));
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.0);
  sun.position.set(120, 200, 80);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xa9c4ff, 0.35);
  fill.position.set(-100, 60, -90);
  scene.add(fill);

  const disposables: Array<{ dispose(): void }> = [];

  // ---- Hill heights driven by subnet count + peering count ----
  const peeringCount = new Map<string, number>();
  for (const p of world.peerings) {
    peeringCount.set(p.a, (peeringCount.get(p.a) ?? 0) + 1);
    peeringCount.set(p.b, (peeringCount.get(p.b) ?? 0) + 1);
  }
  const subnetCountByVnet = new Map<string, number>();
  for (const s of world.subnets) {
    subnetCountByVnet.set(s.vnetId, (subnetCountByVnet.get(s.vnetId) ?? 0) + 1);
  }
  const vnetHeight = (vnId: string) =>
    HILL_BASE_HEIGHT
    + HILL_PER_SUBNET * (subnetCountByVnet.get(vnId) ?? 0)
    + HILL_PER_PEERING * (peeringCount.get(vnId) ?? 0);

  // ---- Surrounding countryside ----
  const span = Math.max(
    world.bounds.max[0] - world.bounds.min[0],
    world.bounds.max[1] - world.bounds.min[1],
  );
  const groundSize = span * 2.4 + 240;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundSize, groundSize, 1, 1),
    new THREE.MeshLambertMaterial({ color: GROUND_COLOR }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  scene.add(ground);
  disposables.push(ground.geometry, ground.material as THREE.Material);

  // ---- Hills (one frustum per VNet) ----
  interface HillInfo { yTop: number; cx: number; cz: number; topRadius: number; }
  const hillByVnet = new Map<string, HillInfo>();
  for (const vn of world.vnets) {
    const h = vnetHeight(vn.id);
    const baseR = vn.size * 0.55 + 6;
    const topR = Math.max(vn.size * 0.45 + 2, baseR - HILL_TOP_INSET);
    const geom = new THREE.CylinderGeometry(topR, baseR, h, HILL_SIDES, 1, false);
    const sideMat = new THREE.MeshLambertMaterial({ color: HILL_SIDE_COLOR });
    const hill = new THREE.Mesh(geom, sideMat);
    hill.position.set(vn.center[0], h / 2, vn.center[1]);
    scene.add(hill);
    disposables.push(geom, sideMat);

    // Brighter grass cap so the plateau reads clearly.
    const capGeom = new THREE.CylinderGeometry(topR, topR, 0.18, HILL_SIDES, 1, false);
    const capMat = new THREE.MeshLambertMaterial({ color: HILL_TOP_COLOR });
    const cap = new THREE.Mesh(capGeom, capMat);
    cap.position.set(vn.center[0], h + 0.09, vn.center[1]);
    scene.add(cap);
    disposables.push(capGeom, capMat);

    hillByVnet.set(vn.id, { yTop: h + 0.18, cx: vn.center[0], cz: vn.center[1], topRadius: topR });

    addLabelSprite(scene, vn.name, vn.center[0], h + 4.0, vn.center[1], 1.1, 0xffffff, disposables, Math.min(vn.size, 22));
  }

  // ---- Subnet plots on the hilltops ----
  interface PlotInfo { yTop: number; cx: number; cz: number; size: number; }
  const plotBySubnet = new Map<string, PlotInfo>();
  for (const s of world.subnets) {
    const hill = hillByVnet.get(s.vnetId);
    if (!hill) continue;
    const plotSize = Math.max(s.size * 0.85, 6);
    const yTop = hill.yTop + 0.12;
    const plotGeom = new THREE.BoxGeometry(plotSize, 0.24, plotSize);
    const plotMat = new THREE.MeshLambertMaterial({ color: PLOT_COLOR });
    const plot = new THREE.Mesh(plotGeom, plotMat);
    plot.position.set(s.center[0], hill.yTop + PLOT_LIFT, s.center[1]);
    scene.add(plot);
    disposables.push(plotGeom, plotMat);
    plotBySubnet.set(s.id, { yTop, cx: s.center[0], cz: s.center[1], size: plotSize });

    const lbl = s.cidr ? `${s.name} (${s.cidr})` : s.name;
    addLabelSprite(scene, lbl, s.center[0], yTop + 0.5, s.center[1], 0.5, 0xffffff, disposables, Math.min(s.size, 12));
  }

  // ---- Houses (VMs) ----
  // Footprint scaled by composite CPU+RAM "tower height" already computed in
  // layout.ts. Each VM gets a body cube + pyramid roof, instanced per OS.
  const sizeFor = (vm: PlacedVm): number => {
    const t = Math.min(1, Math.max(0, (vm.height - 1) / 31));
    return HOUSE_MIN + (HOUSE_MAX - HOUSE_MIN) * Math.sqrt(t);
  };
  const liftedY = (vm: PlacedVm): number => {
    const plot = vm.subnetId ? plotBySubnet.get(vm.subnetId) : null;
    return (plot?.yTop ?? 0) + 0.12;
  };

  const buckets: Record<string, PlacedVm[]> = { linux: [], windows: [], other: [] };
  for (const vm of world.vms) buckets[vm.os].push(vm);

  const vmTowers: THREE.InstancedMesh[] = [];
  const vmInstanceMap = new Map<THREE.InstancedMesh, PlacedVm[]>();
  const bodyGeom = new THREE.BoxGeometry(1, 1, 1);
  const roofGeom = new THREE.ConeGeometry(0.72, 1, 4);   // square pyramid
  roofGeom.rotateY(Math.PI / 4);                          // sides axis-aligned
  disposables.push(bodyGeom, roofGeom);

  for (const os of Object.keys(buckets) as Array<keyof typeof buckets>) {
    const list = buckets[os];
    if (list.length === 0) continue;
    const bodyMat = new THREE.MeshLambertMaterial({ color: HOUSE_COLORS[os] });
    const roofMat = new THREE.MeshLambertMaterial({ color: ROOF_COLORS[os] });
    disposables.push(bodyMat, roofMat);
    const bodies = new THREE.InstancedMesh(bodyGeom, bodyMat, list.length);
    const roofs = new THREE.InstancedMesh(roofGeom, roofMat, list.length);
    bodies.userData.os = os;
    const dummy = new THREE.Object3D();
    list.forEach((vm, i) => {
      const side = sizeFor(vm);
      const yPlot = liftedY(vm);
      const bodyH = side * HOUSE_BODY_HEIGHT;
      // Body: scale unit cube to side × bodyH × side; sit base on plot.
      dummy.position.set(vm.pos[0], yPlot + bodyH / 2, vm.pos[2]);
      dummy.scale.set(side, bodyH, side);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      bodies.setMatrixAt(i, dummy.matrix);
      // Pyramid roof on top of the body.
      const roofH = side * HOUSE_ROOF_PITCH;
      dummy.position.set(vm.pos[0], yPlot + bodyH + roofH / 2, vm.pos[2]);
      dummy.scale.set(side * 1.18, roofH, side * 1.18);
      dummy.updateMatrix();
      roofs.setMatrixAt(i, dummy.matrix);
    });
    bodies.instanceMatrix.needsUpdate = true;
    roofs.instanceMatrix.needsUpdate = true;
    scene.add(bodies, roofs);
    vmTowers.push(bodies);
    vmInstanceMap.set(bodies, list);
  }

  // ---- Streets ----
  // Each subnet gets an "I-shape" of road: a centerline through its row of
  // houses plus crossbars at both ends. Each subnet center is then connected
  // to its hill's centerpoint via a wider main road.
  const roadSegments: Array<{ ax: number; az: number; bx: number; bz: number; halfWidth: number; y: number; }> = [];

  for (const s of world.subnets) {
    const plot = plotBySubnet.get(s.id);
    if (!plot) continue;
    const localVms = world.vms.filter(v => v.subnetId === s.id);
    if (localVms.length === 0) continue;
    const minX = Math.min(...localVms.map(v => v.pos[0]));
    const maxX = Math.max(...localVms.map(v => v.pos[0]));
    const minZ = Math.min(...localVms.map(v => v.pos[2]));
    const maxZ = Math.max(...localVms.map(v => v.pos[2]));
    const yRoad = plot.yTop + ROAD_LIFT + 0.12;
    // Long centerline through the houses.
    roadSegments.push({ ax: minX - 1.5, az: plot.cz, bx: maxX + 1.5, bz: plot.cz, halfWidth: ROAD_HALFWIDTH, y: yRoad });
    // End crossbars (only meaningful if there's vertical extent in the row layout).
    if (maxZ - minZ > 0.5) {
      roadSegments.push({ ax: minX - 1.5, az: minZ - 1.5, bx: minX - 1.5, bz: maxZ + 1.5, halfWidth: ROAD_HALFWIDTH, y: yRoad });
      roadSegments.push({ ax: maxX + 1.5, az: minZ - 1.5, bx: maxX + 1.5, bz: maxZ + 1.5, halfWidth: ROAD_HALFWIDTH, y: yRoad });
    }
  }

  for (const s of world.subnets) {
    const plot = plotBySubnet.get(s.id);
    const hill = hillByVnet.get(s.vnetId);
    if (!plot || !hill) continue;
    const yRoad = plot.yTop + ROAD_LIFT + 0.12;
    roadSegments.push({
      ax: plot.cx, az: plot.cz, bx: hill.cx, bz: hill.cz,
      halfWidth: MAIN_ROAD_HALFWIDTH, y: yRoad,
    });
  }

  buildRoadMesh(scene, roadSegments, ROAD_COLOR, disposables);

  // ---- Bridges between peered VNets (3D boxes spanning hilltop to hilltop) ----
  for (const p of world.peerings) {
    const a = hillByVnet.get(p.a);
    const b = hillByVnet.get(p.b);
    if (!a || !b) continue;
    addBridgeBox(scene, a, b, BRIDGE_HALFWIDTH * 2, BRIDGE_HEIGHT, ROAD_COLOR, disposables);
  }

  // ---- Stub for service buildings (NSG / ASG / Storage) -----------------
  // Parser doesn't yet surface NSG/ASG/Storage, so there's nothing to draw.
  // Once parser exposes those (e.g. `world.services: { kind, cx, cz, vnetId }[]`),
  // drop in a small block per kind: police = blue tower, fire = red boxy hall
  // with a flag, shop = striped awning. No layout work needed beyond placing
  // them at the perimeter of their nearest subnet plot.

  // ---- Spawn camera: tilted SimCity-screenshot angle ----
  const cxc = (world.bounds.min[0] + world.bounds.max[0]) / 2;
  const czc = (world.bounds.min[1] + world.bounds.max[1]) / 2;
  const tallestHill = Math.max(0, ...world.vnets.map(v => vnetHeight(v.id)));
  const spawnY = Math.max(16, tallestHill * 1.4, span * 0.22);
  const spawnPos = new THREE.Vector3(cxc - span * 0.4, spawnY, czc + span * 0.5);
  const spawnLook = new THREE.Vector3(cxc, tallestHill * 0.5, czc);

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

// A peering bridge is a long thin 3D box spanning two hilltops. Sits at the
// max of the two hilltop heights so it never clips into either hill.
function addBridgeBox(
  scene: THREE.Scene,
  a: { yTop: number; cx: number; cz: number },
  b: { yTop: number; cx: number; cz: number },
  width: number,
  height: number,
  color: number,
  disposables: Array<{ dispose(): void }>,
) {
  const dx = b.cx - a.cx;
  const dz = b.cz - a.cz;
  const len = Math.hypot(dx, dz);
  if (len < 0.5) return;
  const cx = (a.cx + b.cx) / 2;
  const cz = (a.cz + b.cz) / 2;
  // Y of the deck is just above the higher hilltop so the bridge sits proudly.
  const y = Math.max(a.yTop, b.yTop) + height / 2 + 0.2;
  const geom = new THREE.BoxGeometry(len, height, width);
  const mat = new THREE.MeshLambertMaterial({ color });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, y, cz);
  // Rotate around Y so the long axis points from A to B.
  mesh.rotation.y = -Math.atan2(dz, dx);
  scene.add(mesh);
  disposables.push(geom, mat);
  // Two short pylons at each end to suggest support, just for SimCity charm.
  for (const end of [a, b]) {
    const pylonH = Math.max(0.5, y - 0.1);
    const pg = new THREE.BoxGeometry(width * 0.45, pylonH, width * 0.45);
    const pm = new THREE.MeshLambertMaterial({ color: 0x8c8b86 });
    const p = new THREE.Mesh(pg, pm);
    p.position.set(end.cx, pylonH / 2, end.cz);
    scene.add(p);
    disposables.push(pg, pm);
  }
}

// Build one merged mesh from quads laid along each road segment.
function buildRoadMesh(
  scene: THREE.Scene,
  segments: Array<{ ax: number; az: number; bx: number; bz: number; halfWidth: number; y: number; }>,
  color: number,
  disposables: Array<{ dispose(): void }>,
) {
  if (segments.length === 0) return;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let baseIdx = 0;
  for (const s of segments) {
    const dx = s.bx - s.ax;
    const dz = s.bz - s.az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) continue;
    const nx = -dz / len;
    const nz = dx / len;
    const w = s.halfWidth;
    const ax1 = s.ax + nx * w, az1 = s.az + nz * w;
    const ax2 = s.ax - nx * w, az2 = s.az - nz * w;
    const bx1 = s.bx + nx * w, bz1 = s.bz + nz * w;
    const bx2 = s.bx - nx * w, bz2 = s.bz - nz * w;
    positions.push(ax1, s.y, az1, ax2, s.y, az2, bx2, s.y, bz2, bx1, s.y, bz1);
    for (let i = 0; i < 4; i++) normals.push(0, 1, 0);
    indices.push(baseIdx, baseIdx + 1, baseIdx + 2, baseIdx, baseIdx + 2, baseIdx + 3);
    baseIdx += 4;
  }
  if (positions.length === 0) return;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setIndex(indices);
  const mat = new THREE.MeshLambertMaterial({ color });
  disposables.push(geom, mat);
  scene.add(new THREE.Mesh(geom, mat));
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
