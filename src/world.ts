import * as THREE from 'three';
import type { World, PlacedVm, PlacedSubnet, PlacedVnet } from './types';

const OS_COLOR: Record<string, number> = {
  linux:   0x6abf69,
  windows: 0x5a8fd1,
  other:   0x9aa6b2,
};

const SUBNET_EDGE_CAP = 200;
const VOXEL = 1; // one block = one world unit

export interface BuiltScene {
  scene: THREE.Scene;
  vmTowers: THREE.InstancedMesh[];      // for raycasting
  vmIndex: PlacedVm[];                  // parallel: instance index → VM
  vmInstanceMap: Map<THREE.InstancedMesh, PlacedVm[]>;
  spawn: { pos: THREE.Vector3; lookAt: THREE.Vector3 };
  dispose(): void;
}

export function buildScene(world: World): BuiltScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9bc8e0); // soft sky
  scene.fog = new THREE.Fog(0x9bc8e0, 80, 600);

  // ---- Lighting ----
  const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(120, 200, 80);
  scene.add(sun);

  // ---- Ground plane (huge, below the world) ----
  const groundSpan = Math.max(
    world.bounds.max[0] - world.bounds.min[0],
    world.bounds.max[1] - world.bounds.min[1],
  ) * 2 + 200;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundSpan, groundSpan),
    new THREE.MeshLambertMaterial({ color: 0x2e3b45 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -2;
  scene.add(ground);

  const disposables: Array<{ dispose(): void }> = [];

  // ---- VNet bedrock slabs ----
  const slabGeom = new THREE.BoxGeometry(1, 1, 1);
  disposables.push(slabGeom);
  for (const vn of world.vnets) {
    const mat = new THREE.MeshLambertMaterial({ color: vn.color });
    disposables.push(mat);
    const slab = new THREE.Mesh(slabGeom, mat);
    slab.position.set(vn.center[0], -0.5, vn.center[1]);
    slab.scale.set(vn.size + 4, 1, vn.size + 4);
    scene.add(slab);
    addLabelSprite(scene, vn.name, vn.center[0], 0.6, vn.center[1], 1.6, 0xffffff, disposables, vn.size + 4);
  }

  // ---- Subnet pads ----
  const padGeom = new THREE.BoxGeometry(1, 1, 1);
  disposables.push(padGeom);
  for (const s of world.subnets) {
    const vnet = world.vnetById.get(s.vnetId);
    const base = vnet?.color ?? 0x808080;
    const lighter = lightenColor(base, 0.18);
    const mat = new THREE.MeshLambertMaterial({ color: lighter });
    disposables.push(mat);
    const pad = new THREE.Mesh(padGeom, mat);
    pad.position.set(s.center[0], 0.25, s.center[1]);
    pad.scale.set(s.size, 0.5, s.size);
    scene.add(pad);
    const lbl = s.cidr ? `${s.name} (${s.cidr})` : s.name;
    addLabelSprite(scene, lbl, s.center[0], 1.2, s.center[1], 1.0, 0xffffff, disposables, s.size);
  }

  // ---- VM towers, instanced per OS bucket ----
  const buckets: Record<string, PlacedVm[]> = { linux: [], windows: [], other: [] };
  for (const vm of world.vms) buckets[vm.os].push(vm);

  const vmTowers: THREE.InstancedMesh[] = [];
  const vmInstanceMap = new Map<THREE.InstancedMesh, PlacedVm[]>();
  const cubeGeom = new THREE.BoxGeometry(VOXEL * 0.95, VOXEL * 0.95, VOXEL * 0.95);
  disposables.push(cubeGeom);

  for (const os of Object.keys(buckets) as Array<keyof typeof buckets>) {
    const list = buckets[os];
    if (list.length === 0) continue;
    const total = list.reduce((acc, v) => acc + v.height, 0);
    if (total === 0) continue;
    const mat = new THREE.MeshLambertMaterial({ color: OS_COLOR[os] });
    disposables.push(mat);
    const inst = new THREE.InstancedMesh(cubeGeom, mat, total);
    inst.userData.os = os;
    const dummy = new THREE.Object3D();
    let i = 0;
    const flatList: PlacedVm[] = [];
    for (const vm of list) {
      for (let h = 0; h < vm.height; h++) {
        dummy.position.set(vm.pos[0], 0.5 + 0.5 + h, vm.pos[2]);
        dummy.updateMatrix();
        inst.setMatrixAt(i++, dummy.matrix);
        flatList.push(vm);
      }
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = true;
    scene.add(inst);
    vmTowers.push(inst);
    vmInstanceMap.set(inst, flatList);
  }

  // ---- Edges: in-subnet (white-ish), cross-subnet within VNet (lighter), peerings (rust) ----
  const edgePositions: number[] = [];
  const archPositions: number[] = [];
  const peerPositions: number[] = [];

  for (const s of world.subnets) {
    const vmsHere = world.vms.filter(v => v.subnetId === s.id);
    if (vmsHere.length < 2) continue;
    let count = 0;
    outer: for (let a = 0; a < vmsHere.length; a++) {
      for (let b = a + 1; b < vmsHere.length; b++) {
        const va = vmsHere[a], vb = vmsHere[b];
        edgePositions.push(va.pos[0], 0.6, va.pos[2], vb.pos[0], 0.6, vb.pos[2]);
        count++;
        if (count >= SUBNET_EDGE_CAP) break outer;
      }
    }
  }

  // Cross-subnet edges: arch from subnet centre to subnet centre per VNet (one per pair).
  const subnetsByVnet = new Map<string, PlacedSubnet[]>();
  for (const s of world.subnets) {
    if (!subnetsByVnet.has(s.vnetId)) subnetsByVnet.set(s.vnetId, []);
    subnetsByVnet.get(s.vnetId)!.push(s);
  }
  for (const [, subs] of subnetsByVnet) {
    for (let i = 0; i < subs.length; i++) {
      for (let j = i + 1; j < subs.length; j++) {
        pushArch(archPositions, subs[i].center, subs[j].center, 6);
      }
    }
  }

  // VNet peerings: tall rust-coloured arches between VNet centres.
  for (const p of world.peerings) {
    const a = world.vnetById.get(p.a);
    const b = world.vnetById.get(p.b);
    if (!a || !b) continue;
    pushArch(peerPositions, a.center, b.center, 24);
  }

  if (edgePositions.length) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xe8eef5, transparent: true, opacity: 0.55 });
    disposables.push(geom, mat);
    scene.add(new THREE.LineSegments(geom, mat));
  }
  if (archPositions.length) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(archPositions, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xb8d6ff, transparent: true, opacity: 0.5 });
    disposables.push(geom, mat);
    scene.add(new THREE.LineSegments(geom, mat));
  }
  if (peerPositions.length) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(peerPositions, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0xc97a3a, transparent: true, opacity: 0.85 });
    disposables.push(geom, mat);
    scene.add(new THREE.LineSegments(geom, mat));
  }

  // ---- Spawn camera over the centre, looking down-ish ----
  const cx = (world.bounds.min[0] + world.bounds.max[0]) / 2;
  const cz = (world.bounds.min[1] + world.bounds.max[1]) / 2;
  const span = Math.max(world.bounds.max[0] - world.bounds.min[0], world.bounds.max[1] - world.bounds.min[1]);
  const tallest = world.vms.reduce((m, v) => Math.max(m, v.height), 8);
  const spawnY = Math.max(40, tallest + 24, span * 0.5);
  const spawnPos = new THREE.Vector3(cx - span * 0.35, spawnY, cz + span * 0.35);
  const spawnLook = new THREE.Vector3(cx, tallest / 2, cz);

  return {
    scene,
    vmTowers,
    vmIndex: world.vms,
    vmInstanceMap,
    spawn: { pos: spawnPos, lookAt: spawnLook },
    dispose() {
      for (const d of disposables) d.dispose();
      for (const inst of vmTowers) {
        inst.geometry.dispose();
        if (Array.isArray(inst.material)) for (const m of inst.material) m.dispose();
        else inst.material.dispose();
      }
    },
  };
}

function pushArch(out: number[], a: [number, number], b: [number, number], peakHeight: number, segments = 18) {
  const ax = a[0], az = a[1], bx = b[0], bz = b[1];
  const mx = (ax + bx) / 2;
  const mz = (az + bz) / 2;
  // Quadratic Bezier with peak above midpoint.
  for (let i = 0; i < segments; i++) {
    const t1 = i / segments;
    const t2 = (i + 1) / segments;
    const p1 = bezier(ax, az, mx, mz, bx, bz, peakHeight, t1);
    const p2 = bezier(ax, az, mx, mz, bx, bz, peakHeight, t2);
    out.push(p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
  }
}

function bezier(ax: number, az: number, mx: number, mz: number, bx: number, bz: number, peak: number, t: number): [number, number, number] {
  const u = 1 - t;
  const x = u * u * ax + 2 * u * t * mx + t * t * bx;
  const z = u * u * az + 2 * u * t * mz + t * t * bz;
  // Apex at t=0.5 — vertical Bezier with control at peak.
  const y = u * u * 0.6 + 2 * u * t * peak + t * t * 0.6;
  return [x, y, z];
}

function lightenColor(hex: number, amt: number): number {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  const lr = Math.min(255, Math.round(r + (255 - r) * amt));
  const lg = Math.min(255, Math.round(g + (255 - g) * amt));
  const lb = Math.min(255, Math.round(b + (255 - b) * amt));
  return (lr << 16) | (lg << 8) | lb;
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
  // Scale by worldWidth so label width is comparable to the slab it sits on.
  const w = Math.min(worldWidth * 0.6, 24) * scale;
  sprite.scale.set(w, w * (canvas.height / canvas.width), 1);
  sprite.position.set(x, y, z);
  scene.add(sprite);
  disposables.push(tex, mat);
}
