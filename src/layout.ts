import type { Graph, World, PlacedVm, PlacedSubnet, PlacedVnet, Subnet, Vm } from './types';

// Topographic mode: VMs sit along a horizontal row inside each subnet so the
// row reads as a connected mountain ridge with each VM as a summit. Subnets
// stack vertically within their VNet — parallel ridges making one massif.
const VM_SPACING = 8;          // pitch between VM peaks along the subnet ridge
const VM_PAD = 4;              // padding at the ends of each subnet ridge
const ROW_GAP = 8;             // vertical gap between subnet ridges inside a VNet
const VNET_GAP = 28;           // gap between VNet ranges
const MAX_TOWER = 32;          // tallest VM tower, in blocks
const MIN_TOWER = 1;
const MAX_VMS_PER_ROW = 8;     // wrap to a second/third ridge if a subnet has more

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

interface SubnetExtent { width: number; depth: number; rows: number; perRow: number; }

function subnetExtent(vmCount: number): SubnetExtent {
  const n = Math.max(1, vmCount);
  const perRow = Math.min(MAX_VMS_PER_ROW, n);
  const rows = Math.ceil(n / perRow);
  const width = perRow * VM_SPACING + VM_PAD * 2;
  const depth = rows * VM_SPACING + VM_PAD * 2;
  return { width, depth, rows, perRow };
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

  // ---- Subnet extents per VNet (subnets stack vertically inside the VNet) ----
  interface VnetGeom { width: number; depth: number; subExt: SubnetExtent[]; }
  const vnetGeom = new Map<string, VnetGeom>();
  for (const vn of vnets) {
    const subs = subnetsByVnet.get(vn.id) ?? [];
    const subExt = subs.map(s => subnetExtent((vmsBySubnet.get(s.id) ?? []).length));
    const width = Math.max(VM_SPACING * 2, ...subExt.map(e => e.width));
    const depth = subExt.reduce((sum, e) => sum + e.depth, 0)
                + Math.max(0, subs.length - 1) * ROW_GAP
                + VM_PAD * 2;
    vnetGeom.set(vn.id, { width, depth, subExt });
  }

  // ---- VNet outer grid: place VNets in a square arrangement ----
  const vnetSide = gridSide(vnets.length);
  const maxVnetW = Math.max(...vnets.map(v => vnetGeom.get(v.id)?.width ?? VM_SPACING * 4));
  const maxVnetD = Math.max(...vnets.map(v => vnetGeom.get(v.id)?.depth ?? VM_SPACING * 4));
  const cellPitchX = maxVnetW + VNET_GAP;
  const cellPitchZ = maxVnetD + VNET_GAP;
  const totalSpanX = vnetSide * maxVnetW + (vnetSide - 1) * VNET_GAP;
  const totalSpanZ = vnetSide * maxVnetD + (vnetSide - 1) * VNET_GAP;
  const originX = -totalSpanX / 2 + maxVnetW / 2;
  const originZ = -totalSpanZ / 2 + maxVnetD / 2;

  const placedVnets: PlacedVnet[] = [];
  const placedSubnets: PlacedSubnet[] = [];
  const placedVms: PlacedVm[] = [];

  vnets.forEach((vn, idx) => {
    const gx = idx % vnetSide;
    const gz = Math.floor(idx / vnetSide);
    const cx = originX + gx * cellPitchX;
    const cz = originZ + gz * cellPitchZ;
    const geom = vnetGeom.get(vn.id) ?? { width: VM_SPACING * 4, depth: VM_SPACING * 4, subExt: [] };
    const size = Math.max(geom.width, geom.depth);
    const color = vn.id === '__unattached__' ? 0x444a52 : vnetColor(vn.name);
    placedVnets.push({
      ...vn,
      center: [cx, cz],
      size, width: geom.width, depth: geom.depth,
      color,
    });

    const subs = subnetsByVnet.get(vn.id) ?? [];
    // Stack subnets vertically within VNet, top to bottom.
    const stackTopZ = cz - geom.depth / 2 + VM_PAD;
    let cursorZ = stackTopZ;
    subs.forEach((s, si) => {
      const ext = geom.subExt[si];
      const subCz = cursorZ + ext.depth / 2;
      const subCx = cx;
      cursorZ += ext.depth + ROW_GAP;
      const localVms = vmsBySubnet.get(s.id) ?? [];
      placedSubnets.push({
        ...s,
        center: [subCx, subCz],
        size: Math.max(ext.width, ext.depth),
        width: ext.width,
        depth: ext.depth,
        vnetCenter: [cx, cz],
      });

      // VMs along the subnet ridge: row-major within ext.perRow x ext.rows.
      const totalRowWidth = ext.perRow * VM_SPACING;
      const totalColDepth = ext.rows * VM_SPACING;
      const vmOriginX = subCx - totalRowWidth / 2 + VM_SPACING / 2;
      const vmOriginZ = subCz - totalColDepth / 2 + VM_SPACING / 2;
      localVms.forEach((vm, vi) => {
        const col = vi % ext.perRow;
        const row = Math.floor(vi / ext.perRow);
        const x = vmOriginX + col * VM_SPACING;
        const z = vmOriginZ + row * VM_SPACING;
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
