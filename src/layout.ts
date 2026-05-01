import type {
  Graph, World, PlacedVm, PlacedSubnet, PlacedVnet, Subnet, Vm,
  PlacedNic, PlacedNsg, PlacedPublicIp, PlacedStorage,
} from './types';

const VM_SPACING = 4;          // grid pitch between tower plots within a subnet
const VM_PAD = 3;              // padding around the tower grid on a subnet plot
const SUBNET_GAP = 8;          // gap between subnet plots (room for streets)
const VNET_GAP = 36;           // gap between districts (room for inter-district roads)
const STORAGE_PITCH = 7;       // gap between storage car parks in the services strip
const STORAGE_RG_GAP = 4;      // extra gap between RG groups in the strip
const STORAGE_OFFSET = 22;     // distance of services strip from the world bounds edge
const MAX_TOWER = 32;          // tallest VM tower, in blocks
const MIN_TOWER = 1;

// FNV-1a-ish hash → 0..1
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

function vnetColor(name: string): number {
  const hue = hash01(name);
  // Soft daylight-ish palette: medium saturation, mid-light value.
  // Convert HSL → hex.
  const h = hue * 360;
  const s = 0.45;
  const l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)        { r = c; g = x; }
  else if (h < 120)  { r = x; g = c; }
  else if (h < 180)  { g = c; b = x; }
  else if (h < 240)  { g = x; b = c; }
  else if (h < 300)  { r = x; b = c; }
  else               { r = c; b = x; }
  const R = Math.round((r + m) * 255);
  const G = Math.round((g + m) * 255);
  const B = Math.round((b + m) * 255);
  return (R << 16) | (G << 8) | B;
}

function gridSide(n: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(Math.max(1, n))));
}

function subnetSize(vmCount: number): number {
  const side = gridSide(vmCount);
  return side * VM_SPACING + VM_PAD * 2;
}

export function buildWorld(graph: Graph): World {
  // Synthetic "unattached" subnet for VMs without a NIC link.
  const orphanVms = graph.vms.filter(v => !v.subnetId);
  let allSubnets = [...graph.subnets];
  let vmsBySubnet = new Map(graph.vmsBySubnet);
  let subnetsByVnet = new Map<string, Subnet[]>();
  for (const [k, v] of graph.subnetsByVnet) subnetsByVnet.set(k, [...v]);
  let vnets = [...graph.vnets];

  if (orphanVms.length > 0) {
    const ghostVnet = { id: '__unattached__', name: '(unattached)', rg: '', location: '', addressSpace: '' };
    const ghostSubnet: Subnet = { id: '__unattached__::orphans', name: 'orphans', vnetId: '__unattached__', cidr: '' };
    vnets = [...vnets, ghostVnet];
    allSubnets = [...allSubnets, ghostSubnet];
    subnetsByVnet.set(ghostVnet.id, [ghostSubnet]);
    const linked = orphanVms.map(v => ({ ...v, subnetId: ghostSubnet.id })) as Vm[];
    vmsBySubnet.set(ghostSubnet.id, linked);
    // Replace orphan VMs in the working list with their linked copies.
    const linkedById = new Map(linked.map(v => [v.id, v]));
    graph = {
      ...graph,
      vms: graph.vms.map(v => linkedById.get(v.id) ?? v),
    };
  }

  // Drop empty VNets that have no subnets.
  vnets = vnets.filter(vn => (subnetsByVnet.get(vn.id)?.length ?? 0) > 0);

  // ---- Composite height per VM (normalize vCPU & RAM across the file) ----
  const vCPUs = graph.vms.map(v => v.vCPU).filter(n => Number.isFinite(n) && n > 0);
  const rams = graph.vms.map(v => v.ramGB).filter(n => Number.isFinite(n) && n > 0);
  const minC = Math.min(...vCPUs, 1);
  const maxC = Math.max(...vCPUs, minC + 1);
  const minR = Math.min(...rams, 1);
  const maxR = Math.max(...rams, minR + 1);
  const heightFor = (v: Vm) => {
    const nc = (v.vCPU - minC) / Math.max(1e-6, maxC - minC);
    const nr = (v.ramGB - minR) / Math.max(1e-6, maxR - minR);
    const score = (clamp01(nc) + clamp01(nr)) / 2;
    return Math.max(MIN_TOWER, Math.min(MAX_TOWER, Math.round(MIN_TOWER + score * (MAX_TOWER - MIN_TOWER))));
  };

  // ---- VNet outer grid ----
  const vnetSizes = new Map<string, number>();
  for (const vn of vnets) {
    const subs = subnetsByVnet.get(vn.id) ?? [];
    const subSizes = subs.map(s => subnetSize((vmsBySubnet.get(s.id) ?? []).length));
    const subnetSide = gridSide(subs.length);
    const cellSize = Math.max(VM_SPACING * 2, ...subSizes);
    const side = subnetSide * cellSize + (subnetSide - 1) * SUBNET_GAP + VM_SPACING * 2;
    vnetSizes.set(vn.id, side);
  }

  const vnetSide = gridSide(vnets.length);
  // Use the largest VNet size as the cell pitch so layouts stay rectilinear.
  const maxVnetSize = Math.max(...vnets.map(v => vnetSizes.get(v.id) ?? VM_SPACING * 4), VM_SPACING * 4);
  const vnetCellPitch = maxVnetSize + VNET_GAP;
  const totalSpan = vnetSide * maxVnetSize + (vnetSide - 1) * VNET_GAP;
  const originX = -totalSpan / 2 + maxVnetSize / 2;
  const originZ = -totalSpan / 2 + maxVnetSize / 2;

  const placedVnets: PlacedVnet[] = [];
  const placedSubnets: PlacedSubnet[] = [];
  const placedVms: PlacedVm[] = [];

  vnets.forEach((vn, idx) => {
    const gx = idx % vnetSide;
    const gz = Math.floor(idx / vnetSide);
    const cx = originX + gx * vnetCellPitch;
    const cz = originZ + gz * vnetCellPitch;
    const size = vnetSizes.get(vn.id) ?? maxVnetSize;
    const color = vn.id === '__unattached__' ? 0x444a52 : vnetColor(vn.name);
    placedVnets.push({ ...vn, center: [cx, cz], size, color });

    const subs = subnetsByVnet.get(vn.id) ?? [];
    const subSide = gridSide(subs.length);
    const subSizes = subs.map(s => subnetSize((vmsBySubnet.get(s.id) ?? []).length));
    const cellSize = Math.max(VM_SPACING * 2, ...subSizes);
    const innerPitch = cellSize + SUBNET_GAP;
    const innerSpan = subSide * cellSize + (subSide - 1) * SUBNET_GAP;
    const innerOriginX = cx - innerSpan / 2 + cellSize / 2;
    const innerOriginZ = cz - innerSpan / 2 + cellSize / 2;

    subs.forEach((s, si) => {
      const sx = si % subSide;
      const sz = Math.floor(si / subSide);
      const subCx = innerOriginX + sx * innerPitch;
      const subCz = innerOriginZ + sz * innerPitch;
      const localVms = vmsBySubnet.get(s.id) ?? [];
      const ssize = subnetSize(localVms.length);
      placedSubnets.push({ ...s, center: [subCx, subCz], size: ssize, vnetCenter: [cx, cz] });

      // VMs on the subnet pad
      const vside = gridSide(localVms.length);
      const vmSpan = vside * VM_SPACING;
      const vmOriginX = subCx - vmSpan / 2 + VM_SPACING / 2;
      const vmOriginZ = subCz - vmSpan / 2 + VM_SPACING / 2;
      localVms.forEach((vm, vi) => {
        const vx = vi % vside;
        const vz = Math.floor(vi / vside);
        const x = vmOriginX + vx * VM_SPACING;
        const z = vmOriginZ + vz * VM_SPACING;
        const h = heightFor(vm);
        placedVms.push({ ...vm, pos: [x, 0, z], height: h });
      });
    });
  });

  const vnetById = new Map(placedVnets.map(v => [v.id, v]));
  const subnetById = new Map(placedSubnets.map(s => [s.id, s]));

  // ---- NICs: one shopfront per VM, on the side facing its subnet centre ----
  // (Multi-NIC support comes via raw graph.vms when each VM may carry several;
  // today the parser collapses to a single NIC per VM, which is the common case.)
  const placedNics: PlacedNic[] = [];
  const vmIdByNicName = new Map<string, string>();
  for (const vm of placedVms) {
    if (vm.nicName) vmIdByNicName.set(norm(vm.nicName), vm.id);
    if (!vm.subnetId) continue;
    const sub = subnetById.get(vm.subnetId);
    if (!sub) continue;
    const dx = sub.center[0] - vm.pos[0];
    const dz = sub.center[1] - vm.pos[2];
    const len = Math.hypot(dx, dz) || 1;
    const fx = dx / len, fz = dz / len;
    placedNics.push({
      vmId: vm.id,
      subnetId: vm.subnetId,
      privateIp: vm.privateIp ?? '',
      pos: [vm.pos[0] + fx * (VM_SPACING * 0.32), vm.pos[2] + fz * (VM_SPACING * 0.32)],
      facing: [fx, fz],
    });
  }
  const nicByVmId = new Map(placedNics.map(n => [n.vmId, n]));

  // ---- NSGs: subnet-attached at the subnet "gate"; NIC-attached next to the VM ----
  const placedNsgs: PlacedNsg[] = [];
  for (const nsg of graph.nsgs) {
    if (nsg.subnetId) {
      const sub = subnetById.get(nsg.subnetId);
      if (!sub) continue;
      // Gate edge = the side of the subnet facing the VNet centre.
      const dx = sub.vnetCenter[0] - sub.center[0];
      const dz = sub.vnetCenter[1] - sub.center[1];
      const len = Math.hypot(dx, dz) || 1;
      const fx = dx / len, fz = dz / len;
      const edgeOffset = sub.size / 2 + 1.5;
      placedNsgs.push({
        ...nsg,
        pos: [sub.center[0] + fx * edgeOffset, sub.center[1] + fz * edgeOffset],
        facing: [-fz, fx],     // perpendicular to the road direction (the barrier sweep)
        attachedSubnetId: nsg.subnetId,
        attachedVmId: null,
      });
    } else if (nsg.nicName) {
      const vmId = vmIdByNicName.get(norm(nsg.nicName));
      const vm = vmId ? placedVms.find(v => v.id === vmId) : null;
      if (!vm) continue;
      const nic = nicByVmId.get(vm.id);
      // Place beside the NIC shopfront, perpendicular to its facing direction.
      const fx = nic?.facing[0] ?? 0;
      const fz = nic?.facing[1] ?? 1;
      const lateral = VM_SPACING * 0.55;
      placedNsgs.push({
        ...nsg,
        pos: [vm.pos[0] + (-fz) * lateral + fx * 0.3, vm.pos[2] + fx * lateral + fz * 0.3],
        facing: [fx, fz],
        attachedSubnetId: null,
        attachedVmId: vm.id,
      });
    }
  }

  // ---- Public IPs: hover next to the NIC shopfront of the attached VM ----
  const placedPublicIps: PlacedPublicIp[] = [];
  for (const pip of graph.publicIps) {
    if (!pip.attachedNic) continue;
    const vmId = vmIdByNicName.get(norm(pip.attachedNic));
    const vm = vmId ? placedVms.find(v => v.id === vmId) : null;
    if (!vm) continue;
    const nic = nicByVmId.get(vm.id);
    const fx = nic?.facing[0] ?? 0;
    const fz = nic?.facing[1] ?? 1;
    const offset = VM_SPACING * 0.5;
    placedPublicIps.push({
      ...pip,
      pos: [vm.pos[0] + fx * offset + (-fz) * (offset * 0.5),
            vm.pos[2] + fz * offset + (fx) * (offset * 0.5)],
      attachedVmId: vm.id,
    });
  }

  // ---- Storage accounts: services strip along the south edge of the world ----
  // Storage isn't network-attached, so it sits off the districts in a single
  // row, grouped by RG with a small gap between groups.
  const placedStorage: PlacedStorage[] = [];
  if (graph.storage.length > 0) {
    // Sort by RG, then name, so RG groups stay together.
    const sorted = [...graph.storage].sort((a, b) =>
      a.rg === b.rg ? a.name.localeCompare(b.name) : a.rg.localeCompare(b.rg));
    // Compute total strip width to centre under the world bounds.
    const widths: number[] = [];
    let prevRg: string | null = null;
    for (const s of sorted) {
      widths.push(STORAGE_PITCH + (prevRg !== null && prevRg !== s.rg ? STORAGE_RG_GAP : 0));
      prevRg = s.rg;
    }
    const totalWidth = widths.reduce((a, b) => a + b, 0);
    const stripCx = placedVnets.length
      ? placedVnets.reduce((sum, v) => sum + v.center[0], 0) / placedVnets.length
      : 0;
    const stripStartX = stripCx - totalWidth / 2 + STORAGE_PITCH / 2;
    const stripZ = (placedVnets.length
      ? Math.max(...placedVnets.map(v => v.center[1] + v.size / 2))
      : 0) + STORAGE_OFFSET;
    let cursorX = stripStartX;
    prevRg = null;
    for (const s of sorted) {
      if (prevRg !== null && prevRg !== s.rg) cursorX += STORAGE_RG_GAP;
      // Storeys: bigger SKU/kind → taller car park.
      const skuLow = s.sku.toLowerCase();
      const kindLow = s.kind.toLowerCase();
      let storeys = 3;
      if (skuLow.includes('premium')) storeys += 2;
      if (skuLow.includes('zrs') || skuLow.includes('grs')) storeys += 1;
      if (kindLow.includes('blob')) storeys += 1;
      if (s.tier === 'archive') storeys = Math.max(2, storeys - 1);
      placedStorage.push({ ...s, pos: [cursorX, stripZ], storeys });
      cursorX += STORAGE_PITCH;
      prevRg = s.rg;
    }
  }

  // ---- Bounds: include the services strip too so the camera can frame it ----
  const xs = placedVnets.flatMap(v => [v.center[0] - v.size / 2, v.center[0] + v.size / 2]);
  const zs = placedVnets.flatMap(v => [v.center[1] - v.size / 2, v.center[1] + v.size / 2]);
  const stripXs = placedStorage.map(s => s.pos[0]);
  const stripZs = placedStorage.map(s => s.pos[1]);
  const bounds = {
    min: [
      Math.min(...xs, ...stripXs.map(x => x - STORAGE_PITCH / 2), -10),
      Math.min(...zs, ...stripZs.map(z => z - 4), -10),
    ] as [number, number],
    max: [
      Math.max(...xs, ...stripXs.map(x => x + STORAGE_PITCH / 2), 10),
      Math.max(...zs, ...stripZs.map(z => z + 4), 10),
    ] as [number, number],
  };

  return {
    vms: placedVms,
    subnets: placedSubnets,
    vnets: placedVnets,
    peerings: graph.peerings,
    nics: placedNics,
    nsgs: placedNsgs,
    publicIps: placedPublicIps,
    storage: placedStorage,
    bounds,
    vnetById,
    subnetById,
  };
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
