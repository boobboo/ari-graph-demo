import * as THREE from 'three';
import type { World, PlacedVm, PlacedNsg, PlacedPublicIp, PlacedStorage } from './types';

// ---- Semantic-mapping tunables (see plan) ------------------------------
// The whole map is one flat city. VNets are walled districts whose colour
// reflects the network. Subnets are neighbourhood blocks within the district.
// VMs are tower blocks (RAM = footprint, vCPU = storeys, OS = cladding).
// NICs are shopfronts on the side of the tower facing the subnet road.
// Peerings are bridge-roads between districts, threading through gate
// openings cut in the walls. NSGs are police checkpoints; Public IPs are
// flagpoles; Storage Accounts are multistorey car parks lined up off-network
// in a "services strip" along the south edge of the map.

// Districts (VNets)
const DISTRICT_FLOOR_HEIGHT = 0.3;
const WALL_HEIGHT = 1.6;
const WALL_THICKNESS = 0.6;
const GATE_WIDTH = 6;            // opening in the wall where a road enters

// Subnets
const PLOT_LIFT = 0.22;
const PLOT_THICKNESS = 0.28;
const KERB_HEIGHT = 0.22;
const KERB_THICKNESS = 0.18;

// Tower blocks (VMs)
const TOWER_FOOTPRINT_MIN = 1.7;
const TOWER_FOOTPRINT_MAX = 2.6;
const STOREY_HEIGHT = 0.9;
const STOREY_MIN = 2;
const STOREY_MAX = 18;
const FLOOR_BAND_THICKNESS = 0.06;
const FLOOR_BAND_INSET = 0.04;   // how much wider than the tower the band extends
const TOWER_BODY: Record<string, number> = {
  linux:   0xc8a576,   // warm tan/sandstone
  windows: 0xb9cad9,   // pale blue glass
  other:   0xb6b6b0,   // neutral concrete
};
const TOWER_BAND: Record<string, number> = {
  linux:   0x6e4f30,
  windows: 0x4a6079,
  other:   0x55564f,
};

// NIC shopfronts
const SHOPFRONT_W = 1.2;
const SHOPFRONT_H = 0.7;
const SHOPFRONT_D = 0.5;

// Roads
const ROAD_LIFT = 0.04;
const ROAD_HALFWIDTH = 0.55;
const MAIN_ROAD_HALFWIDTH = 0.95;
const BRIDGE_HALFWIDTH = 1.2;
const BRIDGE_HEIGHT = 0.4;
const ROAD_COLOR = 0x4d4a44;
const GROUND_COLOR = 0x445948;
const SUBNET_PLOT_COLOR = 0xb1c986;
const KERB_COLOR = 0xd9d3c0;

// NSG (police checkpoint)
const NSG_BODY_COLOR = 0x355bb5;
const NSG_BODY_W = 1.4;
const NSG_BODY_H = 1.4;
const NSG_BODY_D = 1.4;
const BARRIER_LEN = 4.2;
const BARRIER_THICK = 0.18;

// Public IP (flagpole)
const FLAGPOLE_HEIGHT = 3.4;
const FLAGPOLE_RADIUS = 0.07;
const FLAG_W = 1.0;
const FLAG_H = 0.55;
const FLAG_COLOR_STANDARD = 0x4ec27d;
const FLAG_COLOR_BASIC = 0x9aa29a;

// Storage car park
const CARPARK_W = 4.4;
const CARPARK_D = 5.6;
const CARPARK_BODY_COLOR = 0x9a8d76;
const CARPARK_FLOOR_COLOR = 0x615746;
const CARPARK_TIER_TINT: Record<string, number> = {
  hot:     0xb4a888,
  cool:    0x8aa4a8,
  archive: 0x6c6358,
  unknown: 0x9a8d76,
};

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
  scene.fog = new THREE.Fog(0xc7e1f0, 220, 1200);

  // ---- Lights ----
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.7));
  const sun = new THREE.DirectionalLight(0xfff0d8, 1.05);
  sun.position.set(140, 220, 90);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xa9c4ff, 0.3);
  fill.position.set(-100, 60, -90);
  scene.add(fill);

  const disposables: Array<{ dispose(): void }> = [];

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

  // ---- Districts (VNets) ----
  // Each VNet renders as a flat coloured slab plus a low boundary wall.
  // Gates are cut in the wall on each face that has a peering bridge entering.
  // For each VNet we precompute the per-face gate offsets.
  interface DistrictGeom { cx: number; cz: number; halfW: number; halfD: number; color: number; }
  const districtByVnet = new Map<string, DistrictGeom>();
  for (const vn of world.vnets) {
    const halfW = vn.size / 2 + 4;
    const halfD = vn.size / 2 + 4;
    districtByVnet.set(vn.id, { cx: vn.center[0], cz: vn.center[1], halfW, halfD, color: vn.color });
  }

  // For each district, what gate openings are needed on which face?
  // Bridges connect two districts → each one drills a gate on the face nearest
  // the other. We model a "gate" as (face, offset along that face).
  type Face = 'north' | 'south' | 'east' | 'west';   // -z, +z, +x, -x
  interface Gate { face: Face; offset: number; }     // offset along face in world units, centred
  const gatesByVnet = new Map<string, Gate[]>();
  for (const p of world.peerings) {
    const a = districtByVnet.get(p.a);
    const b = districtByVnet.get(p.b);
    if (!a || !b) continue;
    const gateA = pickGate(a, b);
    const gateB = pickGate(b, a);
    if (!gatesByVnet.has(p.a)) gatesByVnet.set(p.a, []);
    if (!gatesByVnet.has(p.b)) gatesByVnet.set(p.b, []);
    gatesByVnet.get(p.a)!.push(gateA);
    gatesByVnet.get(p.b)!.push(gateB);
  }

  // Render the floor + walls for each district.
  for (const vn of world.vnets) {
    const d = districtByVnet.get(vn.id)!;
    // Floor slab tinted by VNet colour.
    const floorGeom = new THREE.BoxGeometry(d.halfW * 2, DISTRICT_FLOOR_HEIGHT, d.halfD * 2);
    const floorMat = new THREE.MeshLambertMaterial({ color: vn.color });
    const floor = new THREE.Mesh(floorGeom, floorMat);
    floor.position.set(d.cx, DISTRICT_FLOOR_HEIGHT / 2, d.cz);
    scene.add(floor);
    disposables.push(floorGeom, floorMat);

    // Walls (4 sides), each split around any gate openings.
    const wallColor = darkenColor(vn.color, 0.35);
    const wallMat = new THREE.MeshLambertMaterial({ color: wallColor });
    disposables.push(wallMat);
    const gates = gatesByVnet.get(vn.id) ?? [];
    addWallSegments(scene, 'north', d, gates, wallMat, disposables);
    addWallSegments(scene, 'south', d, gates, wallMat, disposables);
    addWallSegments(scene, 'east',  d, gates, wallMat, disposables);
    addWallSegments(scene, 'west',  d, gates, wallMat, disposables);

    // District name above the district centre.
    addLabelSprite(scene, vn.name, d.cx, WALL_HEIGHT + 3.6, d.cz, 1.0, 0xffffff, disposables, Math.min(vn.size, 22));
  }

  // ---- Subnets (neighbourhood blocks) ----
  // A raised plot with a kerb ring around it.
  for (const s of world.subnets) {
    const plotSize = Math.max(s.size * 0.92, 6);
    const plotY = DISTRICT_FLOOR_HEIGHT + PLOT_LIFT;
    const plotGeom = new THREE.BoxGeometry(plotSize, PLOT_THICKNESS, plotSize);
    const plotMat = new THREE.MeshLambertMaterial({ color: SUBNET_PLOT_COLOR });
    const plot = new THREE.Mesh(plotGeom, plotMat);
    plot.position.set(s.center[0], plotY + PLOT_THICKNESS / 2, s.center[1]);
    scene.add(plot);
    disposables.push(plotGeom, plotMat);

    // Kerb ring: four thin bars on the plot's perimeter.
    const kerbMat = new THREE.MeshLambertMaterial({ color: KERB_COLOR });
    disposables.push(kerbMat);
    const half = plotSize / 2;
    const kerbY = plotY + PLOT_THICKNESS + KERB_HEIGHT / 2;
    const horizGeom = new THREE.BoxGeometry(plotSize, KERB_HEIGHT, KERB_THICKNESS);
    const vertGeom = new THREE.BoxGeometry(KERB_THICKNESS, KERB_HEIGHT, plotSize);
    disposables.push(horizGeom, vertGeom);
    const k1 = new THREE.Mesh(horizGeom, kerbMat); k1.position.set(s.center[0], kerbY, s.center[1] - half); scene.add(k1);
    const k2 = new THREE.Mesh(horizGeom, kerbMat); k2.position.set(s.center[0], kerbY, s.center[1] + half); scene.add(k2);
    const k3 = new THREE.Mesh(vertGeom,  kerbMat); k3.position.set(s.center[0] - half, kerbY, s.center[1]); scene.add(k3);
    const k4 = new THREE.Mesh(vertGeom,  kerbMat); k4.position.set(s.center[0] + half, kerbY, s.center[1]); scene.add(k4);

    const lbl = s.cidr ? `${s.name} (${s.cidr})` : s.name;
    addLabelSprite(scene, lbl, s.center[0], kerbY + 0.6, s.center[1], 0.45, 0xffffff, disposables, Math.min(s.size, 12));
  }

  // The plot top is where towers sit.
  const towerBaseY = DISTRICT_FLOOR_HEIGHT + PLOT_LIFT + PLOT_THICKNESS;

  // ---- Tower blocks (VMs) ----
  // RAM normalises across the file → footprint. vCPU normalises → storey count.
  const vCPUs = world.vms.map(v => v.vCPU).filter(n => Number.isFinite(n) && n > 0);
  const rams  = world.vms.map(v => v.ramGB).filter(n => Number.isFinite(n) && n > 0);
  const minC = Math.min(...vCPUs, 1), maxC = Math.max(...vCPUs, minC + 1);
  const minR = Math.min(...rams, 1),  maxR = Math.max(...rams, minR + 1);
  const footprintFor = (vm: PlacedVm) => {
    const t = clamp01((vm.ramGB - minR) / Math.max(1e-6, maxR - minR));
    return TOWER_FOOTPRINT_MIN + (TOWER_FOOTPRINT_MAX - TOWER_FOOTPRINT_MIN) * Math.sqrt(t);
  };
  const storeysFor = (vm: PlacedVm) => {
    const t = clamp01((vm.vCPU - minC) / Math.max(1e-6, maxC - minC));
    return Math.round(STOREY_MIN + t * (STOREY_MAX - STOREY_MIN));
  };

  const buckets: Record<string, PlacedVm[]> = { linux: [], windows: [], other: [] };
  for (const vm of world.vms) buckets[vm.os].push(vm);

  const vmTowers: THREE.InstancedMesh[] = [];
  const vmInstanceMap = new Map<THREE.InstancedMesh, PlacedVm[]>();
  const towerGeom = new THREE.BoxGeometry(1, 1, 1);
  const bandGeom = new THREE.BoxGeometry(1, 1, 1);
  disposables.push(towerGeom, bandGeom);

  for (const os of Object.keys(buckets) as Array<keyof typeof buckets>) {
    const list = buckets[os];
    if (list.length === 0) continue;
    const bodyMat = new THREE.MeshLambertMaterial({ color: TOWER_BODY[os] });
    const bandMat = new THREE.MeshLambertMaterial({ color: TOWER_BAND[os] });
    disposables.push(bodyMat, bandMat);

    // Body instances: one per VM.
    const bodies = new THREE.InstancedMesh(towerGeom, bodyMat, list.length);
    bodies.userData.os = os;
    const dummy = new THREE.Object3D();
    list.forEach((vm, i) => {
      const fp = footprintFor(vm);
      const totalH = storeysFor(vm) * STOREY_HEIGHT;
      dummy.position.set(vm.pos[0], towerBaseY + totalH / 2, vm.pos[2]);
      dummy.scale.set(fp, totalH, fp);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      bodies.setMatrixAt(i, dummy.matrix);
    });
    bodies.instanceMatrix.needsUpdate = true;
    scene.add(bodies);
    vmTowers.push(bodies);
    vmInstanceMap.set(bodies, list);

    // Floor banding: a thin band at the top of every storey of every tower.
    // Total band count ≈ Σ storeys.
    const bandCount = list.reduce((sum, vm) => sum + storeysFor(vm), 0);
    if (bandCount > 0) {
      const bands = new THREE.InstancedMesh(bandGeom, bandMat, bandCount);
      let bi = 0;
      for (const vm of list) {
        const fp = footprintFor(vm);
        const storeys = storeysFor(vm);
        for (let s = 1; s <= storeys; s++) {
          const y = towerBaseY + s * STOREY_HEIGHT;
          dummy.position.set(vm.pos[0], y, vm.pos[2]);
          dummy.scale.set(fp + FLOOR_BAND_INSET * 2, FLOOR_BAND_THICKNESS, fp + FLOOR_BAND_INSET * 2);
          dummy.updateMatrix();
          bands.setMatrixAt(bi++, dummy.matrix);
        }
      }
      bands.instanceMatrix.needsUpdate = true;
      scene.add(bands);
    }
  }

  // ---- NIC shopfronts (one per NIC, on the road-facing side of the tower) ----
  if (world.nics.length > 0) {
    const shopGeom = new THREE.BoxGeometry(SHOPFRONT_W, SHOPFRONT_H, SHOPFRONT_D);
    const shopMat = new THREE.MeshLambertMaterial({ color: 0xefe6c8 });
    disposables.push(shopGeom, shopMat);
    const shops = new THREE.InstancedMesh(shopGeom, shopMat, world.nics.length);
    const dummy = new THREE.Object3D();
    world.nics.forEach((nic, i) => {
      // Nudge the shopfront flush against the tower base on the road-facing side.
      const fp = (() => {
        const vm = world.vms.find(v => v.id === nic.vmId);
        return vm ? footprintFor(vm) : TOWER_FOOTPRINT_MIN;
      })();
      const baseX = nic.pos[0] + nic.facing[0] * (fp / 2 + SHOPFRONT_D / 2 - 0.05);
      const baseZ = nic.pos[1] + nic.facing[1] * (fp / 2 + SHOPFRONT_D / 2 - 0.05);
      dummy.position.set(baseX, towerBaseY + SHOPFRONT_H / 2, baseZ);
      dummy.rotation.set(0, -Math.atan2(nic.facing[1], nic.facing[0]), 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      shops.setMatrixAt(i, dummy.matrix);
    });
    shops.instanceMatrix.needsUpdate = true;
    scene.add(shops);
  }

  // ---- Streets ----
  // For each subnet: a centerline street through its row of tower bases.
  // Then a main road from the subnet centre to the district centre — that's
  // the one a subnet-attached NSG sits on.
  const roadSegments: Array<{ ax: number; az: number; bx: number; bz: number; halfWidth: number; }> = [];
  for (const s of world.subnets) {
    const localVms = world.vms.filter(v => v.subnetId === s.id);
    if (localVms.length === 0) continue;
    const minX = Math.min(...localVms.map(v => v.pos[0]));
    const maxX = Math.max(...localVms.map(v => v.pos[0]));
    roadSegments.push({ ax: minX - 1.5, az: s.center[1], bx: maxX + 1.5, bz: s.center[1], halfWidth: ROAD_HALFWIDTH });
  }
  for (const s of world.subnets) {
    roadSegments.push({
      ax: s.center[0], az: s.center[1],
      bx: s.vnetCenter[0], bz: s.vnetCenter[1],
      halfWidth: MAIN_ROAD_HALFWIDTH,
    });
  }
  const roadY = towerBaseY + ROAD_LIFT;
  buildRoadMesh(scene, roadSegments, roadY, ROAD_COLOR, disposables);

  // ---- Bridges (peerings) ----
  // 3D box at ground level passing through the gate openings of both districts.
  for (const p of world.peerings) {
    const a = districtByVnet.get(p.a);
    const b = districtByVnet.get(p.b);
    if (!a || !b) continue;
    addBridgeBox(scene, a, b, BRIDGE_HALFWIDTH * 2, BRIDGE_HEIGHT, ROAD_COLOR, disposables);
  }

  // ---- NSGs (police checkpoints) ----
  const serviceTargets: THREE.Object3D[] = [];
  const serviceLookup = new Map<THREE.Object3D, ServiceTip>();
  for (const nsg of world.nsgs) {
    const bodyGeom = new THREE.BoxGeometry(NSG_BODY_W, NSG_BODY_H, NSG_BODY_D);
    const bodyMat = new THREE.MeshLambertMaterial({ color: NSG_BODY_COLOR });
    const body = new THREE.Mesh(bodyGeom, bodyMat);
    body.position.set(nsg.pos[0], towerBaseY + NSG_BODY_H / 2, nsg.pos[1]);
    body.rotation.y = -Math.atan2(nsg.facing[1], nsg.facing[0]);
    scene.add(body);
    disposables.push(bodyGeom, bodyMat);
    serviceTargets.push(body);
    serviceLookup.set(body, { kind: 'nsg', data: nsg });

    // Striped roof so it reads as a checkpoint, not just a blue box.
    const roofGeom = new THREE.BoxGeometry(NSG_BODY_W * 1.05, 0.18, NSG_BODY_D * 1.05);
    const roofMat = new THREE.MeshLambertMaterial({ color: 0xf2eadb });
    const roof = new THREE.Mesh(roofGeom, roofMat);
    roof.position.set(nsg.pos[0], towerBaseY + NSG_BODY_H + 0.09, nsg.pos[1]);
    roof.rotation.y = body.rotation.y;
    scene.add(roof);
    disposables.push(roofGeom, roofMat);

    // Barrier arm sweeping across the road in the facing direction.
    const armGeom = new THREE.BoxGeometry(BARRIER_LEN, BARRIER_THICK, BARRIER_THICK);
    const armMat = new THREE.MeshLambertMaterial({ color: 0xe85a3a });
    const arm = new THREE.Mesh(armGeom, armMat);
    // Place barrier perpendicular to the building's facing — i.e. across the road.
    // The 'facing' field on PlacedNsg already encodes the perpendicular direction.
    arm.position.set(
      nsg.pos[0] + nsg.facing[0] * (NSG_BODY_W * 0.65),
      towerBaseY + NSG_BODY_H * 0.55,
      nsg.pos[1] + nsg.facing[1] * (NSG_BODY_W * 0.65),
    );
    arm.rotation.y = -Math.atan2(nsg.facing[1], nsg.facing[0]);
    scene.add(arm);
    disposables.push(armGeom, armMat);
  }

  // ---- Public IPs (flagpoles) ----
  for (const pip of world.publicIps) {
    const poleGeom = new THREE.CylinderGeometry(FLAGPOLE_RADIUS, FLAGPOLE_RADIUS, FLAGPOLE_HEIGHT, 8);
    const poleMat = new THREE.MeshLambertMaterial({ color: 0xf3ede0 });
    const pole = new THREE.Mesh(poleGeom, poleMat);
    pole.position.set(pip.pos[0], towerBaseY + FLAGPOLE_HEIGHT / 2, pip.pos[1]);
    scene.add(pole);
    disposables.push(poleGeom, poleMat);
    serviceTargets.push(pole);
    serviceLookup.set(pole, { kind: 'publicIp', data: pip });

    // Flag at the top, coloured by SKU.
    const flagColor = pip.sku.toLowerCase().startsWith('standard') ? FLAG_COLOR_STANDARD : FLAG_COLOR_BASIC;
    const flagGeom = new THREE.PlaneGeometry(FLAG_W, FLAG_H);
    const flagMat = new THREE.MeshLambertMaterial({ color: flagColor, side: THREE.DoubleSide });
    const flag = new THREE.Mesh(flagGeom, flagMat);
    flag.position.set(
      pip.pos[0] + FLAG_W / 2,
      towerBaseY + FLAGPOLE_HEIGHT - FLAG_H / 2,
      pip.pos[1],
    );
    scene.add(flag);
    disposables.push(flagGeom, flagMat);
  }

  // ---- Storage car parks ----
  for (const sa of world.storage) {
    const tint = CARPARK_TIER_TINT[sa.tier] ?? CARPARK_BODY_COLOR;
    const totalH = sa.storeys * 0.95;
    const bodyGeom = new THREE.BoxGeometry(CARPARK_W, totalH, CARPARK_D);
    const bodyMat = new THREE.MeshLambertMaterial({ color: tint });
    const body = new THREE.Mesh(bodyGeom, bodyMat);
    body.position.set(sa.pos[0], totalH / 2, sa.pos[1]);
    scene.add(body);
    disposables.push(bodyGeom, bodyMat);
    serviceTargets.push(body);
    serviceLookup.set(body, { kind: 'storage', data: sa });

    // Floor bands so it reads as multistorey parking, not a solid block.
    const slabGeom = new THREE.BoxGeometry(CARPARK_W * 1.04, 0.08, CARPARK_D * 1.04);
    const slabMat = new THREE.MeshLambertMaterial({ color: CARPARK_FLOOR_COLOR });
    disposables.push(slabGeom, slabMat);
    for (let s = 1; s < sa.storeys; s++) {
      const slab = new THREE.Mesh(slabGeom, slabMat);
      slab.position.set(sa.pos[0], (totalH / sa.storeys) * s, sa.pos[1]);
      scene.add(slab);
    }

    addLabelSprite(scene, sa.name, sa.pos[0], totalH + 1.2, sa.pos[1], 0.42, 0xffffff, disposables, 10);
  }

  // ---- Spawn camera: high oblique "city map" view ----
  const cxc = (world.bounds.min[0] + world.bounds.max[0]) / 2;
  const czc = (world.bounds.min[1] + world.bounds.max[1]) / 2;
  const spawnY = Math.max(35, span * 0.45);
  const spawnPos = new THREE.Vector3(cxc - span * 0.35, spawnY, czc + span * 0.85);
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

// ---- Wall geometry: cut gates into each face ----------------------------
type Face = 'north' | 'south' | 'east' | 'west';
interface DistrictGeom { cx: number; cz: number; halfW: number; halfD: number; color: number; }
interface Gate { face: Face; offset: number; }

function pickGate(here: DistrictGeom, other: DistrictGeom): Gate {
  const dx = other.cx - here.cx;
  const dz = other.cz - here.cz;
  if (Math.abs(dx) >= Math.abs(dz)) {
    // East/west face. Offset along Z, clamped to face.
    return { face: dx > 0 ? 'east' : 'west', offset: clampOffset(dz, here.halfD) };
  }
  return { face: dz > 0 ? 'south' : 'north', offset: clampOffset(dx, here.halfW) };
}

function clampOffset(v: number, halfExtent: number): number {
  const inset = GATE_WIDTH / 2 + 1;
  return Math.max(-(halfExtent - inset), Math.min(halfExtent - inset, v));
}

function addWallSegments(
  scene: THREE.Scene, face: Face, d: DistrictGeom, gates: Gate[],
  mat: THREE.Material, disposables: Array<{ dispose(): void }>,
) {
  const wallY = DISTRICT_FLOOR_HEIGHT + WALL_HEIGHT / 2;
  const faceGates = gates.filter(g => g.face === face).map(g => g.offset).sort((a, b) => a - b);

  // For north/south face the wall runs along X (length = halfW*2). Z is fixed.
  // For east/west face the wall runs along Z (length = halfD*2). X is fixed.
  const along = (face === 'north' || face === 'south') ? d.halfW : d.halfD;
  const fixedAxis = (face === 'north') ? d.cz - d.halfD
                  : (face === 'south') ? d.cz + d.halfD
                  : (face === 'east')  ? d.cx + d.halfW
                                       : d.cx - d.halfW;

  // Build a list of [start, end] segments along the face minus gate openings.
  const cuts: Array<[number, number]> = [];
  let cursor = -along;
  for (const g of faceGates) {
    const gateStart = g - GATE_WIDTH / 2;
    const gateEnd = g + GATE_WIDTH / 2;
    if (gateStart > cursor) cuts.push([cursor, gateStart]);
    cursor = Math.max(cursor, gateEnd);
  }
  if (cursor < along) cuts.push([cursor, along]);

  for (const [s, e] of cuts) {
    const len = e - s;
    if (len <= 0.1) continue;
    let geom: THREE.BoxGeometry, x: number, z: number;
    if (face === 'north' || face === 'south') {
      geom = new THREE.BoxGeometry(len, WALL_HEIGHT, WALL_THICKNESS);
      x = d.cx + (s + e) / 2;
      z = fixedAxis;
    } else {
      geom = new THREE.BoxGeometry(WALL_THICKNESS, WALL_HEIGHT, len);
      x = fixedAxis;
      z = d.cz + (s + e) / 2;
    }
    const wall = new THREE.Mesh(geom, mat);
    wall.position.set(x, wallY, z);
    scene.add(wall);
    disposables.push(geom);
  }
}

// ---- Bridge: a long 3D box spanning two districts at ground level. -----
function addBridgeBox(
  scene: THREE.Scene,
  a: DistrictGeom, b: DistrictGeom,
  width: number, height: number, color: number,
  disposables: Array<{ dispose(): void }>,
) {
  const dx = b.cx - a.cx;
  const dz = b.cz - a.cz;
  const len = Math.hypot(dx, dz);
  if (len < 0.5) return;
  const cx = (a.cx + b.cx) / 2;
  const cz = (a.cz + b.cz) / 2;
  // Bridge deck just above the district floors.
  const y = DISTRICT_FLOOR_HEIGHT + height / 2 + 0.05;
  const geom = new THREE.BoxGeometry(len, height, width);
  const mat = new THREE.MeshLambertMaterial({ color });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, y, cz);
  mesh.rotation.y = -Math.atan2(dz, dx);
  scene.add(mesh);
  disposables.push(geom, mat);
}

// ---- Roads: merged mesh of horizontal quads. ---------------------------
function buildRoadMesh(
  scene: THREE.Scene,
  segments: Array<{ ax: number; az: number; bx: number; bz: number; halfWidth: number; }>,
  y: number, color: number,
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
    positions.push(ax1, y, az1, ax2, y, az2, bx2, y, bz2, bx1, y, bz1);
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

// ---- Helpers ------------------------------------------------------------
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function darkenColor(hex: number, amt: number): number {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return (Math.round(r * (1 - amt)) << 16) | (Math.round(g * (1 - amt)) << 8) | Math.round(b * (1 - amt));
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
