// SimCity 3000 renderer.
//
// Hierarchy: Region (subtle ground tint) → Subscription (low boundary kerb)
// → Resource Group (district floor coloured by R/C/I bias) → Buildings
// (placed by catalogue archetype: factory, water tower, police HQ, …).
//
// VNets/Subnets are NOT containers in this mode — they're a network overlay
// drawn as coloured avenues threading through the subnet centroids derived
// in layout.ts. Peerings are bridges. NICs are shopfronts on the side of the
// owning VM tower facing the road.

import * as THREE from 'three';
import type {
  World, PlacedVm, PlacedNsg, PlacedPublicIp, PlacedStorage,
  PlacedRegion, PlacedSubscription, PlacedResourceGroup,
} from './types';
import { ZONE_TINT } from './catalogue';

// ---- Vertical bands ----------------------------------------------------
const REGION_FLOOR_H = 0.12;
const SUB_KERB_H = 0.5;
const SUB_KERB_THICKNESS = 0.4;
const RG_FLOOR_H = 0.22;
const RG_KERB_H = 0.18;
const RG_KERB_THICKNESS = 0.16;
const ROAD_LIFT = 0.08;
const AVENUE_HALF = 0.7;            // VNet avenue half-width
const AVENUE_LIFT = 0.14;           // sits above the RG floor

// Buildings
const STOREY_H = 0.85;
const FOOTPRINT_TILE = 2.4;         // world units per tile (smaller than layout TILE so we leave a kerb)

// Tints
const GROUND_COLOR = 0x4d6a4a;
const REGION_FLOOR_TINTS = [0xd5e0d3, 0xd9d6e0, 0xe0d8c8, 0xd0dee2];
const SUB_KERB_COLOR = 0x6c757d;
const ROAD_COLOR = 0x4d4a44;
const KERB_COLOR = 0xc8c2ad;

// VM/factory cladding by OS
const FACTORY_BODY: Record<string, number> = {
  linux:   0xc89556,
  windows: 0xa6c2db,
  other:   0xb2b1ad,
};
const FACTORY_BAND: Record<string, number> = {
  linux:   0x6e4f30,
  windows: 0x4a6079,
  other:   0x55564f,
};

// Storage water tower
const WATER_TOWER_TANK_COLOR = 0xd4d8da;
const WATER_TOWER_LEG_COLOR = 0x707474;
const WATER_TOWER_TIER_TINT: Record<string, number> = {
  hot:     0x9ec5d8,
  cool:    0x6f8da3,
  archive: 0x4f6678,
  unknown: 0xb6c4cc,
};

// NSG / police HQ
const POLICE_BODY = 0x355bb5;
const POLICE_ROOF = 0xf2eadb;
const BARRIER_COLOR = 0xe85a3a;

// Public IP / toll booth
const TOLL_BOOTH_BODY = 0xefe6c8;
const TOLL_BOOTH_ROOF = 0xb6852c;
const FLAG_STANDARD = 0x4ec27d;
const FLAG_BASIC = 0x9aa29a;

export interface BuiltScene {
  scene: THREE.Scene;
  vmTowers: THREE.InstancedMesh[];
  vmIndex: PlacedVm[];
  vmInstanceMap: Map<THREE.InstancedMesh, PlacedVm[]>;
  serviceTargets: THREE.Object3D[];
  serviceLookup: Map<THREE.Object3D, ServiceTip>;
  spawn: { pos: THREE.Vector3; lookAt: THREE.Vector3 };
  dispose(): void;
}

export type ServiceTip =
  | { kind: 'nsg'; data: PlacedNsg }
  | { kind: 'publicIp'; data: PlacedPublicIp }
  | { kind: 'storage'; data: PlacedStorage };

export function buildScene(world: World): BuiltScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xc7e1f0);

  const worldSpan = Math.max(
    world.bounds.max[0] - world.bounds.min[0],
    world.bounds.max[1] - world.bounds.min[1],
  );
  scene.fog = new THREE.Fog(0xc7e1f0, Math.max(120, worldSpan * 0.5), Math.max(600, worldSpan * 2.0));

  // Lights
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.7));
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.05);
  sun.position.set(140, 220, 90);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xa9c4ff, 0.3);
  fill.position.set(-100, 60, -90);
  scene.add(fill);

  const disposables: Array<{ dispose(): void }> = [];

  // ---- Surrounding countryside ----------------------------------------
  const groundSize = worldSpan * 2.4 + 240;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundSize, groundSize, 1, 1),
    new THREE.MeshLambertMaterial({ color: GROUND_COLOR }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  disposables.push(ground.geometry, ground.material as THREE.Material);

  // ---- Region floors (states) -----------------------------------------
  // Subtle ground tint per Azure region. Helps multi-region estates read.
  world.regions.forEach((region, i) => {
    addRegionFloor(scene, region, REGION_FLOOR_TINTS[i % REGION_FLOOR_TINTS.length], disposables);
  });

  // ---- Subscription kerbs (cities) ------------------------------------
  // A low boundary kerb (not a wall) outlines each subscription.
  for (const sub of world.subscriptions) {
    addSubKerb(scene, sub, disposables);
    addLabelSprite(scene, sub.name, sub.center[0], REGION_FLOOR_H + SUB_KERB_H + 1.6, sub.center[1] - sub.depth / 2 + 1.6, 0.9, 0xffffff, disposables, Math.min(sub.width, 24));
  }

  // ---- RG district floors (with R/C/I tint) ---------------------------
  for (const rg of world.resourceGroups) {
    addRgDistrict(scene, rg, disposables);
    addLabelSprite(
      scene, rg.name,
      rg.center[0],
      REGION_FLOOR_H + SUB_KERB_H * 0.4 + RG_FLOOR_H + 1.0,
      rg.center[1] - rg.depth / 2 + 1.0,
      0.45, 0xffffff, disposables,
      Math.min(rg.width, 16),
    );
  }

  // The Y at which buildings sit: top of the RG floor.
  const buildingBaseY = REGION_FLOOR_H + RG_FLOOR_H + 0.05;

  // ---- VM factories ---------------------------------------------------
  // VMs become factory blocks: footprint scales with FOOTPRINT_TILE *
  // catalogue footprint, height = storeys * STOREY_H. Body cladding tinted
  // by OS so familiar OS colours still distinguish them at a glance.
  const buckets: Record<string, PlacedVm[]> = { linux: [], windows: [], other: [] };
  for (const vm of world.vms) buckets[vm.os].push(vm);

  const vmTowers: THREE.InstancedMesh[] = [];
  const vmInstanceMap = new Map<THREE.InstancedMesh, PlacedVm[]>();
  const factoryBodyGeom = new THREE.BoxGeometry(1, 1, 1);
  const factoryBandGeom = new THREE.BoxGeometry(1, 1, 1);
  const chimneyGeom = new THREE.CylinderGeometry(0.15, 0.18, 1, 8);
  disposables.push(factoryBodyGeom, factoryBandGeom, chimneyGeom);

  for (const os of Object.keys(buckets) as Array<keyof typeof buckets>) {
    const list = buckets[os];
    if (list.length === 0) continue;
    const bodyMat = new THREE.MeshLambertMaterial({ color: FACTORY_BODY[os] });
    const bandMat = new THREE.MeshLambertMaterial({ color: FACTORY_BAND[os] });
    const chimneyMat = new THREE.MeshLambertMaterial({ color: 0x6b5b48 });
    disposables.push(bodyMat, bandMat, chimneyMat);

    const bodies = new THREE.InstancedMesh(factoryBodyGeom, bodyMat, list.length);
    bodies.userData.os = os;
    const dummy = new THREE.Object3D();
    list.forEach((vm, i) => {
      const fp = FOOTPRINT_TILE * vm.footprint;
      const totalH = vm.storeys * STOREY_H;
      dummy.position.set(vm.pos[0], buildingBaseY + totalH / 2, vm.pos[2]);
      dummy.scale.set(fp, totalH, fp);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      bodies.setMatrixAt(i, dummy.matrix);
    });
    bodies.instanceMatrix.needsUpdate = true;
    scene.add(bodies);
    vmTowers.push(bodies);
    vmInstanceMap.set(bodies, list);

    // Floor banding to read "factory floors" rather than a solid block.
    const bandCount = list.reduce((s, v) => s + v.storeys, 0);
    if (bandCount > 0) {
      const bands = new THREE.InstancedMesh(factoryBandGeom, bandMat, bandCount);
      let bi = 0;
      for (const vm of list) {
        const fp = FOOTPRINT_TILE * vm.footprint;
        for (let s = 1; s <= vm.storeys; s++) {
          const y = buildingBaseY + s * STOREY_H;
          dummy.position.set(vm.pos[0], y, vm.pos[2]);
          dummy.scale.set(fp + 0.08, 0.06, fp + 0.08);
          dummy.updateMatrix();
          bands.setMatrixAt(bi++, dummy.matrix);
        }
      }
      bands.instanceMatrix.needsUpdate = true;
      scene.add(bands);
    }

    // Chimney on top of every factory.
    const chimneys = new THREE.InstancedMesh(chimneyGeom, chimneyMat, list.length);
    list.forEach((vm, i) => {
      const fp = FOOTPRINT_TILE * vm.footprint;
      const totalH = vm.storeys * STOREY_H;
      const chimneyH = 0.6 + Math.min(2.4, vm.storeys * 0.18);
      dummy.position.set(
        vm.pos[0] + fp * 0.28,
        buildingBaseY + totalH + chimneyH / 2,
        vm.pos[2] - fp * 0.28,
      );
      dummy.scale.set(1, chimneyH, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      chimneys.setMatrixAt(i, dummy.matrix);
    });
    chimneys.instanceMatrix.needsUpdate = true;
    scene.add(chimneys);
  }

  // ---- NIC shopfronts ------------------------------------------------
  if (world.nics.length > 0) {
    const shopGeom = new THREE.BoxGeometry(1.0, 0.6, 0.4);
    const shopMat = new THREE.MeshLambertMaterial({ color: 0xefe6c8 });
    disposables.push(shopGeom, shopMat);
    const shops = new THREE.InstancedMesh(shopGeom, shopMat, world.nics.length);
    const dummy = new THREE.Object3D();
    world.nics.forEach((nic, i) => {
      // Footprint of the parent VM determines how far from the centre to push the shop.
      const vm = world.vms.find(v => v.id === nic.vmId);
      const fp = FOOTPRINT_TILE * (vm?.footprint ?? 1);
      const baseX = nic.pos[0] + nic.facing[0] * (fp / 2 + 0.2);
      const baseZ = nic.pos[1] + nic.facing[1] * (fp / 2 + 0.2);
      dummy.position.set(baseX, buildingBaseY + 0.3, baseZ);
      dummy.rotation.set(0, -Math.atan2(nic.facing[1], nic.facing[0]), 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      shops.setMatrixAt(i, dummy.matrix);
    });
    shops.instanceMatrix.needsUpdate = true;
    scene.add(shops);
  }

  // ---- Storage water towers -----------------------------------------
  // PRD §5.2: storage = utility / water tower. Cylinder tank on a stubby
  // leg, tier-tinted (hot/cool/archive). Storeys → tank height.
  const serviceTargets: THREE.Object3D[] = [];
  const serviceLookup = new Map<THREE.Object3D, ServiceTip>();
  for (const sa of world.storage) {
    const tankColor = WATER_TOWER_TIER_TINT[sa.tier] ?? WATER_TOWER_TANK_COLOR;
    const tankH = Math.max(1.0, sa.storeys * 0.55);
    const tankR = 0.85 * (sa.footprint > 1 ? 1.4 : 1);
    const legH = Math.min(tankH * 1.0, 1.5);

    // Legs: a stubby cylinder.
    const legGeom = new THREE.CylinderGeometry(0.18, 0.22, legH, 6);
    const legMat = new THREE.MeshLambertMaterial({ color: WATER_TOWER_LEG_COLOR });
    const leg = new THREE.Mesh(legGeom, legMat);
    leg.position.set(sa.pos[0], buildingBaseY + legH / 2, sa.pos[1]);
    scene.add(leg);
    disposables.push(legGeom, legMat);

    // Tank: cylinder.
    const tankGeom = new THREE.CylinderGeometry(tankR, tankR, tankH, 12);
    const tankMat = new THREE.MeshLambertMaterial({ color: tankColor });
    const tank = new THREE.Mesh(tankGeom, tankMat);
    tank.position.set(sa.pos[0], buildingBaseY + legH + tankH / 2, sa.pos[1]);
    scene.add(tank);
    disposables.push(tankGeom, tankMat);
    serviceTargets.push(tank);
    serviceLookup.set(tank, { kind: 'storage', data: sa });

    // Dome cap.
    const domeGeom = new THREE.SphereGeometry(tankR * 1.02, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    const domeMat = new THREE.MeshLambertMaterial({ color: tankColor });
    const dome = new THREE.Mesh(domeGeom, domeMat);
    dome.position.set(sa.pos[0], buildingBaseY + legH + tankH, sa.pos[1]);
    scene.add(dome);
    disposables.push(domeGeom, domeMat);
  }

  // ---- NSG police HQ ---------------------------------------------------
  for (const nsg of world.nsgs) {
    const w = 1.3, d = 1.3, h = 1.6;
    const bodyGeom = new THREE.BoxGeometry(w, h, d);
    const bodyMat = new THREE.MeshLambertMaterial({ color: POLICE_BODY });
    const body = new THREE.Mesh(bodyGeom, bodyMat);
    body.position.set(nsg.pos[0], buildingBaseY + h / 2, nsg.pos[1]);
    body.rotation.y = -Math.atan2(nsg.facing[1], nsg.facing[0]);
    scene.add(body);
    disposables.push(bodyGeom, bodyMat);
    serviceTargets.push(body);
    serviceLookup.set(body, { kind: 'nsg', data: nsg });

    // Roof.
    const roofGeom = new THREE.BoxGeometry(w * 1.06, 0.16, d * 1.06);
    const roofMat = new THREE.MeshLambertMaterial({ color: POLICE_ROOF });
    const roof = new THREE.Mesh(roofGeom, roofMat);
    roof.position.set(nsg.pos[0], buildingBaseY + h + 0.08, nsg.pos[1]);
    roof.rotation.y = body.rotation.y;
    scene.add(roof);
    disposables.push(roofGeom, roofMat);

    // Barrier arm aimed toward the protected subnet (if any).
    const armGeom = new THREE.BoxGeometry(2.6, 0.12, 0.18);
    const armMat = new THREE.MeshLambertMaterial({ color: BARRIER_COLOR });
    const arm = new THREE.Mesh(armGeom, armMat);
    arm.position.set(
      nsg.pos[0] + nsg.facing[0] * (w * 0.6 + 0.1),
      buildingBaseY + h * 0.6,
      nsg.pos[1] + nsg.facing[1] * (w * 0.6 + 0.1),
    );
    arm.rotation.y = -Math.atan2(nsg.facing[1], nsg.facing[0]);
    scene.add(arm);
    disposables.push(armGeom, armMat);
  }

  // ---- Public IP toll booths -----------------------------------------
  for (const pip of world.publicIps) {
    const w = 1.1, d = 0.9, h = 1.0;
    const bodyGeom = new THREE.BoxGeometry(w, h, d);
    const bodyMat = new THREE.MeshLambertMaterial({ color: TOLL_BOOTH_BODY });
    const body = new THREE.Mesh(bodyGeom, bodyMat);
    body.position.set(pip.pos[0], buildingBaseY + h / 2, pip.pos[1]);
    scene.add(body);
    disposables.push(bodyGeom, bodyMat);
    serviceTargets.push(body);
    serviceLookup.set(body, { kind: 'publicIp', data: pip });

    // Sloped roof.
    const roofGeom = new THREE.ConeGeometry(w * 0.85, 0.55, 4);
    roofGeom.rotateY(Math.PI / 4);
    const roofMat = new THREE.MeshLambertMaterial({ color: TOLL_BOOTH_ROOF });
    const roof = new THREE.Mesh(roofGeom, roofMat);
    roof.position.set(pip.pos[0], buildingBaseY + h + 0.27, pip.pos[1]);
    scene.add(roof);
    disposables.push(roofGeom, roofMat);

    // Flagpole + flag (existing visual).
    const poleGeom = new THREE.CylinderGeometry(0.05, 0.05, 2.4, 8);
    const poleMat = new THREE.MeshLambertMaterial({ color: 0xf3ede0 });
    const pole = new THREE.Mesh(poleGeom, poleMat);
    pole.position.set(pip.pos[0] + 0.4, buildingBaseY + 1.2, pip.pos[1]);
    scene.add(pole);
    disposables.push(poleGeom, poleMat);

    const flagColor = pip.sku.toLowerCase().startsWith('standard') ? FLAG_STANDARD : FLAG_BASIC;
    const flagGeom = new THREE.PlaneGeometry(0.7, 0.4);
    const flagMat = new THREE.MeshLambertMaterial({ color: flagColor, side: THREE.DoubleSide });
    const flag = new THREE.Mesh(flagGeom, flagMat);
    flag.position.set(pip.pos[0] + 0.75, buildingBaseY + 2.0, pip.pos[1]);
    scene.add(flag);
    disposables.push(flagGeom, flagMat);
  }

  // ---- VNet avenues + Subnet street markers ---------------------------
  // VNet = polyline avenue threading through its subnet centroids. Subnets
  // with no member buildings are skipped (their centroid is at world origin).
  buildVNetAvenues(scene, world, disposables);

  // ---- Peering bridges ------------------------------------------------
  // Bridge from VNet centroid to peered VNet centroid.
  for (const p of world.peerings) {
    const a = world.vnetById.get(p.a);
    const b = world.vnetById.get(p.b);
    if (!a || !b) continue;
    if (a.center[0] === 0 && a.center[1] === 0) continue;
    if (b.center[0] === 0 && b.center[1] === 0) continue;
    addBridgeBox(scene, a.center, b.center, REGION_FLOOR_H + 0.15, 1.6, 0.4, 0x3a3835, disposables);
  }

  // ---- Spawn camera (city-map angle, scaled to estate size) ----------
  const cxc = (world.bounds.min[0] + world.bounds.max[0]) / 2;
  const czc = (world.bounds.min[1] + world.bounds.max[1]) / 2;
  const span = Math.max(
    world.bounds.max[0] - world.bounds.min[0],
    world.bounds.max[1] - world.bounds.min[1],
  );
  const spawnY = Math.max(40, span * 0.55);
  const spawnPos = new THREE.Vector3(cxc - span * 0.45, spawnY, czc + span * 0.85);
  const spawnLook = new THREE.Vector3(cxc, 2, czc);

  return {
    scene,
    vmTowers,
    vmIndex: world.vms,
    vmInstanceMap,
    serviceTargets,
    serviceLookup,
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

// ---- Region floor: a flat rectangle at ground level --------------------
function addRegionFloor(
  scene: THREE.Scene,
  region: PlacedRegion,
  color: number,
  disposables: Array<{ dispose(): void }>,
) {
  const geom = new THREE.BoxGeometry(region.width, REGION_FLOOR_H, region.depth);
  const mat = new THREE.MeshLambertMaterial({ color });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(region.center[0], REGION_FLOOR_H / 2, region.center[1]);
  scene.add(mesh);
  disposables.push(geom, mat);
}

// ---- Subscription kerb: a low boundary, no wall ------------------------
function addSubKerb(
  scene: THREE.Scene,
  sub: PlacedSubscription,
  disposables: Array<{ dispose(): void }>,
) {
  const halfW = sub.width / 2;
  const halfD = sub.depth / 2;
  const y = REGION_FLOOR_H + SUB_KERB_H / 2;
  const mat = new THREE.MeshLambertMaterial({ color: SUB_KERB_COLOR });
  disposables.push(mat);
  // Four edges as low rectangular bars.
  const horizGeom = new THREE.BoxGeometry(sub.width, SUB_KERB_H, SUB_KERB_THICKNESS);
  const vertGeom = new THREE.BoxGeometry(SUB_KERB_THICKNESS, SUB_KERB_H, sub.depth);
  disposables.push(horizGeom, vertGeom);
  const a = new THREE.Mesh(horizGeom, mat); a.position.set(sub.center[0], y, sub.center[1] - halfD); scene.add(a);
  const b = new THREE.Mesh(horizGeom, mat); b.position.set(sub.center[0], y, sub.center[1] + halfD); scene.add(b);
  const c = new THREE.Mesh(vertGeom,  mat); c.position.set(sub.center[0] - halfW, y, sub.center[1]); scene.add(c);
  const d = new THREE.Mesh(vertGeom,  mat); d.position.set(sub.center[0] + halfW, y, sub.center[1]); scene.add(d);
}

// ---- RG district floor + kerb ring -------------------------------------
function addRgDistrict(
  scene: THREE.Scene,
  rg: PlacedResourceGroup,
  disposables: Array<{ dispose(): void }>,
) {
  const tint = ZONE_TINT[rg.rciPrimary] ?? 0xc8c8b8;
  const floorGeom = new THREE.BoxGeometry(rg.width, RG_FLOOR_H, rg.depth);
  const floorMat = new THREE.MeshLambertMaterial({ color: tint });
  const floor = new THREE.Mesh(floorGeom, floorMat);
  floor.position.set(rg.center[0], REGION_FLOOR_H + RG_FLOOR_H / 2, rg.center[1]);
  scene.add(floor);
  disposables.push(floorGeom, floorMat);

  // Kerb ring around the district.
  const kerbY = REGION_FLOOR_H + RG_FLOOR_H + RG_KERB_H / 2;
  const halfW = rg.width / 2, halfD = rg.depth / 2;
  const kerbMat = new THREE.MeshLambertMaterial({ color: KERB_COLOR });
  disposables.push(kerbMat);
  const horizGeom = new THREE.BoxGeometry(rg.width, RG_KERB_H, RG_KERB_THICKNESS);
  const vertGeom = new THREE.BoxGeometry(RG_KERB_THICKNESS, RG_KERB_H, rg.depth);
  disposables.push(horizGeom, vertGeom);
  const k1 = new THREE.Mesh(horizGeom, kerbMat); k1.position.set(rg.center[0], kerbY, rg.center[1] - halfD); scene.add(k1);
  const k2 = new THREE.Mesh(horizGeom, kerbMat); k2.position.set(rg.center[0], kerbY, rg.center[1] + halfD); scene.add(k2);
  const k3 = new THREE.Mesh(vertGeom,  kerbMat); k3.position.set(rg.center[0] - halfW, kerbY, rg.center[1]); scene.add(k3);
  const k4 = new THREE.Mesh(vertGeom,  kerbMat); k4.position.set(rg.center[0] + halfW, kerbY, rg.center[1]); scene.add(k4);
}

// ---- VNet avenues + subnet markers -------------------------------------
function buildVNetAvenues(
  scene: THREE.Scene,
  world: World,
  disposables: Array<{ dispose(): void }>,
) {
  const subnetsByVnet = new Map<string, typeof world.subnets>();
  for (const s of world.subnets) {
    if (!subnetsByVnet.has(s.vnetId)) subnetsByVnet.set(s.vnetId, []);
    subnetsByVnet.get(s.vnetId)!.push(s);
  }
  // Build an avenue mesh per VNet by chaining its subnet centroids in some
  // order. v1: nearest-neighbour starting from the leftmost subnet.
  for (const vn of world.vnets) {
    const subs = (subnetsByVnet.get(vn.id) ?? [])
      .filter(s => !(s.center[0] === 0 && s.center[1] === 0));
    if (subs.length === 0) continue;
    const ordered = chainNearest(subs.map(s => s.center));
    if (ordered.length < 2) {
      // Single-subnet VNet → just drop a small disc marker.
      addSubnetMarker(scene, ordered[0], vn.color, disposables);
      continue;
    }
    addAvenueStrip(scene, ordered, vn.color, disposables);
    // Subnet markers along the avenue.
    for (const c of ordered) addSubnetMarker(scene, c, vn.color, disposables);
  }
}

function chainNearest(points: Array<[number, number]>): Array<[number, number]> {
  if (points.length <= 1) return points.slice();
  // Start from the leftmost (smallest X) for determinism.
  const remaining = points.slice();
  remaining.sort((a, b) => a[0] - b[0]);
  const ordered = [remaining.shift()!];
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let bestIdx = 0;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = Math.hypot(remaining[i][0] - last[0], remaining[i][1] - last[1]);
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }
  return ordered;
}

function addAvenueStrip(
  scene: THREE.Scene,
  points: Array<[number, number]>,
  color: number,
  disposables: Array<{ dispose(): void }>,
) {
  // Build merged quad strip along the polyline.
  const positions: number[] = [];
  const indices: number[] = [];
  let baseIdx = 0;
  const y = REGION_FLOOR_H + RG_FLOOR_H + AVENUE_LIFT;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.1) continue;
    const nx = -dz / len, nz = dx / len;
    const w = AVENUE_HALF;
    positions.push(
      a[0] + nx * w, y, a[1] + nz * w,
      a[0] - nx * w, y, a[1] - nz * w,
      b[0] - nx * w, y, b[1] - nz * w,
      b[0] + nx * w, y, b[1] + nz * w,
    );
    indices.push(baseIdx, baseIdx + 1, baseIdx + 2, baseIdx, baseIdx + 2, baseIdx + 3);
    baseIdx += 4;
  }
  if (positions.length === 0) return;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ color });
  disposables.push(geom, mat);
  scene.add(new THREE.Mesh(geom, mat));
}

function addSubnetMarker(
  scene: THREE.Scene,
  pos: [number, number],
  color: number,
  disposables: Array<{ dispose(): void }>,
) {
  const geom = new THREE.CylinderGeometry(AVENUE_HALF * 1.1, AVENUE_HALF * 1.1, 0.18, 12);
  const mat = new THREE.MeshLambertMaterial({ color });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(pos[0], REGION_FLOOR_H + RG_FLOOR_H + AVENUE_LIFT + 0.09, pos[1]);
  scene.add(mesh);
  disposables.push(geom, mat);
}

function addBridgeBox(
  scene: THREE.Scene,
  a: [number, number], b: [number, number],
  baseY: number, width: number, height: number, color: number,
  disposables: Array<{ dispose(): void }>,
) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  if (len < 0.5) return;
  const cx = (a[0] + b[0]) / 2;
  const cz = (a[1] + b[1]) / 2;
  const geom = new THREE.BoxGeometry(len, height, width);
  const mat = new THREE.MeshLambertMaterial({ color });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, baseY + height / 2, cz);
  mesh.rotation.y = -Math.atan2(dz, dx);
  scene.add(mesh);
  disposables.push(geom, mat);
  void ROAD_COLOR; // reserved for in-RG service roads (next pass)
}

function addLabelSprite(
  scene: THREE.Scene,
  text: string,
  x: number, y: number, z: number,
  scale: number, color: number,
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
