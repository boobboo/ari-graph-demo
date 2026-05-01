import type { Graph, World, PlacedVm, PlacedSubnet, PlacedVnet, Subnet, Vm } from './types';

const VM_SPACING = 5;          // grid pitch between houses within a subnet
const VM_PAD = 3;              // padding around house grid on a subnet plot
const SUBNET_GAP = 8;          // gap between subnet plots (room for streets)
const VNET_GAP = 32;           // gap between hills
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

  const xs = placedVnets.flatMap(v => [v.center[0] - v.size / 2, v.center[0] + v.size / 2]);
  const zs = placedVnets.flatMap(v => [v.center[1] - v.size / 2, v.center[1] + v.size / 2]);
  const bounds = {
    min: [Math.min(...xs, -10), Math.min(...zs, -10)] as [number, number],
    max: [Math.max(...xs, 10), Math.max(...zs, 10)] as [number, number],
  };

  return {
    vms: placedVms,
    subnets: placedSubnets,
    vnets: placedVnets,
    peerings: graph.peerings,
    bounds,
    vnetById,
    subnetById,
  };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
