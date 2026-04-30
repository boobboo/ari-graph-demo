import * as XLSX from 'xlsx';
import type { Graph, Vm, Vnet, Subnet, Peering } from './types';
import { lookupSku } from './sku';

type Row = Record<string, unknown>;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function findSheet(wb: XLSX.WorkBook, keywords: string[]): string | null {
  const names = wb.SheetNames;
  for (const kw of keywords) {
    const k = norm(kw);
    const hit = names.find(n => norm(n) === k);
    if (hit) return hit;
  }
  for (const kw of keywords) {
    const k = norm(kw);
    const hit = names.find(n => norm(n).includes(k));
    if (hit) return hit;
  }
  return null;
}

function readSheet(wb: XLSX.WorkBook, name: string | null): Row[] {
  if (!name) return [];
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json<Row>(ws, { defval: '' });
}

// Resolve a column value by checking multiple candidate header aliases.
function pick(row: Row, aliases: string[]): string {
  if (!row) return '';
  const map: Record<string, unknown> = {};
  for (const k of Object.keys(row)) map[norm(k)] = row[k];
  for (const a of aliases) {
    const v = map[norm(a)];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  // Fallback: substring match.
  for (const a of aliases) {
    const an = norm(a);
    for (const k of Object.keys(map)) {
      if (k.includes(an)) {
        const v = map[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
    }
  }
  return '';
}

function num(s: string): number {
  if (!s) return NaN;
  const cleaned = s.replace(/[^0-9.\-]/g, '');
  if (!cleaned) return NaN;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function classifyOs(s: string): 'linux' | 'windows' | 'other' {
  const t = s.toLowerCase();
  if (!t) return 'other';
  if (t.includes('windows')) return 'windows';
  if (t.includes('linux') || t.includes('ubuntu') || t.includes('rhel') ||
      t.includes('centos') || t.includes('debian') || t.includes('suse') ||
      t.includes('oracle') || t.includes('rocky') || t.includes('alma')) return 'linux';
  return 'other';
}

// Build a stable id like "rg/name" — used to wire NIC.VM -> VM.id and NIC.Subnet -> Subnet.id.
const subnetId = (vnet: string, subnet: string) => `${norm(vnet)}::${norm(subnet)}`;

export function parseAri(buf: ArrayBuffer, log: (msg: string) => void): Graph {
  const wb = XLSX.read(buf, { type: 'array' });
  log(`Workbook: ${wb.SheetNames.length} sheets — ${wb.SheetNames.join(', ')}`);

  const vmSheet      = findSheet(wb, ['Virtual Machines', 'VM', 'Compute']);
  const vnetSheet    = findSheet(wb, ['Virtual Network', 'VNET', 'VirtualNetworks']);
  const subnetSheet  = findSheet(wb, ['Subnets', 'Subnet']);
  const nicSheet     = findSheet(wb, ['Network Interface', 'NetworkInterface', 'NIC', 'NICs']);
  const peerSheet    = findSheet(wb, ['VNET Peerings', 'Peering', 'Peerings']);

  const detection = {
    vm:      Boolean(vmSheet),
    vnet:    Boolean(vnetSheet),
    subnet:  Boolean(subnetSheet),
    nic:     Boolean(nicSheet),
    peering: Boolean(peerSheet),
  };

  log(`Detected sheets — VM:${vmSheet ?? '—'}  VNET:${vnetSheet ?? '—'}  Subnet:${subnetSheet ?? '—'}  NIC:${nicSheet ?? '—'}  Peer:${peerSheet ?? '—'}`);

  const vmRows     = readSheet(wb, vmSheet);
  const vnetRows   = readSheet(wb, vnetSheet);
  const subnetRows = readSheet(wb, subnetSheet);
  const nicRows    = readSheet(wb, nicSheet);
  const peerRows   = readSheet(wb, peerSheet);

  // ---- VNets ----
  const vnetByKey = new Map<string, Vnet>();
  for (const r of vnetRows) {
    const name = pick(r, ['Name', 'VNet Name', 'Virtual Network Name', 'VNET']);
    if (!name) continue;
    const rg = pick(r, ['Resource Group', 'ResourceGroup', 'RG']);
    const v: Vnet = {
      id: norm(name),
      name,
      rg,
      location: pick(r, ['Location', 'Region']),
      addressSpace: pick(r, ['Address Space', 'AddressSpace', 'CIDR', 'Address Prefixes', 'Address Prefix']),
    };
    vnetByKey.set(v.id, v);
  }

  // ---- Subnets (from dedicated sheet OR inferred from VNet sheet rows) ----
  const subnetByKey = new Map<string, Subnet>();
  const addSubnet = (vnetName: string, name: string, cidr: string) => {
    if (!vnetName || !name) return;
    const vnetIdNorm = norm(vnetName);
    const id = subnetId(vnetName, name);
    if (!subnetByKey.has(id)) {
      subnetByKey.set(id, { id, name, vnetId: vnetIdNorm, cidr });
    }
    if (!vnetByKey.has(vnetIdNorm)) {
      vnetByKey.set(vnetIdNorm, { id: vnetIdNorm, name: vnetName, rg: '', location: '', addressSpace: '' });
    }
  };

  for (const r of subnetRows) {
    const vn = pick(r, ['Virtual Network', 'VNet', 'VNET', 'VNet Name', 'Network']);
    const sn = pick(r, ['Subnet', 'Subnet Name', 'Name']);
    const cidr = pick(r, ['Address Range', 'Subnet Address', 'CIDR', 'Subnet Range', 'Address Prefix']);
    addSubnet(vn, sn, cidr);
  }
  // ARI sometimes one-row-per-subnet inside the VNet sheet:
  for (const r of vnetRows) {
    const vn = pick(r, ['Name', 'VNet Name', 'Virtual Network Name']);
    const sn = pick(r, ['Subnet', 'Subnet Name']);
    const cidr = pick(r, ['Subnet Address', 'Subnet Range', 'Subnet CIDR']);
    if (sn) addSubnet(vn, sn, cidr);
  }

  // ---- NICs: VM -> Subnet attachment ----
  const nicByVm = new Map<string, { subnetKey: string; ip: string }>();
  for (const r of nicRows) {
    const vmName = pick(r, ['Virtual Machine', 'VM Name', 'VM', 'Owner', 'Attached To']);
    const subnetName = pick(r, ['Subnet', 'Subnet Name']);
    const vnetName = pick(r, ['Virtual Network', 'VNET', 'VNet', 'Network']);
    const ip = pick(r, ['Private IP', 'Private IP Address', 'IP', 'Primary IP']);
    if (!vmName) continue;
    if (vnetName && subnetName) {
      addSubnet(vnetName, subnetName, '');
      nicByVm.set(norm(vmName), { subnetKey: subnetId(vnetName, subnetName), ip });
    } else if (subnetName) {
      // Subnet only — match by subnet name across known subnets.
      const candidate = [...subnetByKey.values()].find(s => norm(s.name) === norm(subnetName));
      if (candidate) nicByVm.set(norm(vmName), { subnetKey: candidate.id, ip });
    }
  }

  // ---- VMs ----
  const vms: Vm[] = [];
  let unknownSkuCount = 0;
  for (const r of vmRows) {
    const name = pick(r, ['Name', 'VM Name', 'Virtual Machine']);
    if (!name) continue;
    const sku = pick(r, ['VM Size', 'Size', 'SKU', 'VM SKU']);
    const vCpuCol = num(pick(r, ['vCPUs', 'vCPU', 'CPU', 'Cores']));
    const ramCol  = num(pick(r, ['Memory', 'Memory (GB)', 'RAM', 'RAM (GB)', 'Memory GB']));

    let vCPU = vCpuCol;
    let ramGB = ramCol;
    let unknownSku = false;
    if (!Number.isFinite(vCPU) || !Number.isFinite(ramGB) || vCPU <= 0 || ramGB <= 0) {
      const fb = lookupSku(sku);
      if (!Number.isFinite(vCPU) || vCPU <= 0) vCPU = fb.vCPU;
      if (!Number.isFinite(ramGB) || ramGB <= 0) ramGB = fb.ramGB;
      if (!fb.known && sku) { unknownSku = true; unknownSkuCount++; }
    }

    const rg = pick(r, ['Resource Group', 'ResourceGroup', 'RG']);
    const id = norm(name);
    const nic = nicByVm.get(id);

    // Fallback: maybe the VM sheet itself names a subnet/vnet.
    let subnetIdLink: string | null = nic?.subnetKey ?? null;
    if (!subnetIdLink) {
      const vmVnet = pick(r, ['Virtual Network', 'VNET', 'VNet']);
      const vmSubnet = pick(r, ['Subnet']);
      if (vmVnet && vmSubnet) {
        addSubnet(vmVnet, vmSubnet, '');
        subnetIdLink = subnetId(vmVnet, vmSubnet);
      }
    }

    vms.push({
      id,
      name,
      rg,
      subscription: pick(r, ['Subscription', 'Subscription Name']),
      location: pick(r, ['Location', 'Region']),
      sku,
      os: classifyOs(pick(r, ['OS', 'Operating System', 'OS Type', 'Image Reference', 'Image'])),
      vCPU,
      ramGB,
      subnetId: subnetIdLink,
      privateIp: nic?.ip ?? null,
      unknownSku,
    });
  }

  // ---- Peerings ----
  const peerings: Peering[] = [];
  for (const r of peerRows) {
    const a = pick(r, ['VNet 1', 'Source VNet', 'From VNet', 'Local VNet', 'Virtual Network', 'VNET']);
    const b = pick(r, ['VNet 2', 'Target VNet', 'To VNet', 'Remote VNet', 'Peer VNet', 'Remote Virtual Network']);
    if (!a || !b) continue;
    peerings.push({ a: norm(a), b: norm(b), state: pick(r, ['State', 'Peering State', 'Status']) });
  }

  // ---- Group structures ----
  const subnets = [...subnetByKey.values()];
  const vnets = [...vnetByKey.values()];
  const vmsBySubnet = new Map<string, Vm[]>();
  for (const v of vms) {
    if (!v.subnetId) continue;
    if (!vmsBySubnet.has(v.subnetId)) vmsBySubnet.set(v.subnetId, []);
    vmsBySubnet.get(v.subnetId)!.push(v);
  }
  const subnetsByVnet = new Map<string, Subnet[]>();
  for (const s of subnets) {
    if (!subnetsByVnet.has(s.vnetId)) subnetsByVnet.set(s.vnetId, []);
    subnetsByVnet.get(s.vnetId)!.push(s);
  }

  const orphanCount = vms.filter(v => !v.subnetId).length;
  const notes: string[] = [];
  if (unknownSkuCount > 0) notes.push(`${unknownSkuCount} VM(s) had unrecognised SKUs (heuristic sizing applied).`);
  if (orphanCount > 0) notes.push(`${orphanCount} VM(s) could not be linked to a subnet — placed in an "unattached" pad.`);
  if (!detection.nic) notes.push(`No NIC sheet found — VM/subnet links inferred from the VM sheet.`);

  log(`Parsed: ${vms.length} VMs · ${vnets.length} VNets · ${subnets.length} subnets · ${peerings.length} peerings`);
  if (notes.length) for (const n of notes) log(`  · ${n}`);

  return { vms, vnets, subnets, peerings, vmsBySubnet, subnetsByVnet, detection, notes };
}
