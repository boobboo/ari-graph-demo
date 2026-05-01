import * as XLSX from 'xlsx';
import type {
  Graph, Vm, Vnet, Subnet, Peering, Nsg, PublicIp, StorageAccount, StorageTier,
  Region, Subscription, ResourceGroup, OtherResource, AzureResourceKind,
} from './types';
import { lookupSku } from './sku';
import { computeRciBias } from './catalogue';

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
  const nsgSheet     = findSheet(wb, ['Network Security Groups', 'NSG', 'NetworkSecurityGroups', 'NSGs']);
  const pipSheet     = findSheet(wb, ['Public IPs', 'Public IP Addresses', 'PublicIP', 'Public IP']);
  const storageSheet = findSheet(wb, ['Storage Accounts', 'Storage', 'StorageAccount', 'StorageAccounts']);
  // ---- Phase 2 catalogue extension: extra sheets per PRD §5.2 ----
  const sheetCatalogue: Array<{ kind: AzureResourceKind; aliases: string[]; cols: { name: string[]; sku?: string[]; sizeGB?: string[]; createdTime?: string[]; extras: string[] } }> = [
    { kind: 'disk',            aliases: ['Disks', 'Managed Disks', 'Disk'],
      cols: { name: ['Disk Name', 'Name'], sku: ['SKU'], sizeGB: ['Disk Size'], createdTime: ['Created Time'], extras: ['Disk State', 'Encryption', 'OS Type', 'Disk IOPS Read / Write'] } },
    { kind: 'keyVault',        aliases: ['Key Vaults', 'KeyVault', 'Key Vault'],
      cols: { name: ['Name'], sku: ['SKU', 'SKU Family'], extras: ['Vault Uri', 'Public Network Access', 'Enable RBAC', 'Enable Soft Delete'] } },
    { kind: 'sqlDb',           aliases: ['SQL DBs', 'SQL Databases', 'Sql Databases', 'SQL DB'],
      cols: { name: ['Name'], sku: ['Service Tier', 'Hardware Configuration'], extras: ['Database Server', 'Status', 'DTU Capacity', 'Data Max Size (GB)', 'Zone Redundant'] } },
    { kind: 'sqlServer',       aliases: ['SQL Servers', 'Sql Servers', 'SQL Server'],
      cols: { name: ['Name'], sku: ['Kind', 'Version'], extras: ['Admin Login', 'FQDN', 'Public Network Access', 'State'] } },
    { kind: 'sqlVm',           aliases: ['SQL VMs', 'Sql VMs', 'SQL VM'],
      cols: { name: ['Name'], sku: ['SQL Image Sku', 'SQL Image'], extras: ['SQL Server License Type', 'SQL Management'] } },
    { kind: 'recoveryVault',   aliases: ['Recovery Vaults', 'Recovery Services Vaults', 'Recovery Vault'],
      cols: { name: ['Name'], sku: ['SKU Name'], extras: ['Private Endpoint State for Backup', 'Private Endpoint State for Site Recovery'] } },
    { kind: 'appGateway',      aliases: ['App Gateway', 'Application Gateway', 'App Gateways', 'Application Gateways'],
      cols: { name: ['Name'], sku: ['SKU Name'], extras: ['State', 'WAF Enabled', 'Minimum TLS Version', 'Backend', 'Frontend'] } },
    { kind: 'privateEndpoint', aliases: ['Private Endpoint', 'Private Endpoints'],
      cols: { name: ['Name'], extras: ['VNET', 'Subnet', 'Private Link Name', 'IP Address', 'FQDN', 'Private Link Status', 'Private Link Resource Type'] } },
    { kind: 'logAnalytics',    aliases: ['Workspaces', 'Log Analytics', 'Log Analytics Workspaces', 'Workspace'],
      cols: { name: ['Name'], sku: ['SKU'], createdTime: ['Created Time'], extras: ['Retention Days', 'Daily Cap (GB)'] } },
    { kind: 'availabilitySet', aliases: ['Availability Sets', 'AvailabilitySets', 'Availability Set'],
      cols: { name: ['Name'], extras: ['Fault Domains', 'Update Domains', 'Virtual Machines', 'Orphaned'] } },
    { kind: 'routeTable',      aliases: ['Route Tables', 'RouteTables', 'Route Table'],
      cols: { name: ['Name'], extras: ['Disable BGP Route Propagation', 'Routes', 'Routes Prefixes', 'Routes Next Hop Type', 'Orphaned'] } },
    { kind: 'managedIdentity', aliases: ['Managed Identity', 'Managed Identities', 'User Assigned Managed Identities'],
      cols: { name: ['Name'], extras: ['Principal ID', 'Client ID'] } },
    { kind: 'bastion',         aliases: ['Bastion', 'Bastions', 'Bastion Host'],
      cols: { name: ['Name'], sku: ['SKU'], extras: [] } },
    { kind: 'acr',             aliases: ['Container Registries', 'ACR', 'Container Registry'],
      cols: { name: ['Name'], sku: ['SKU'], extras: ['Admin User Enabled', 'Login Server'] } },
    { kind: 'aks',             aliases: ['AKS', 'Kubernetes', 'Azure Kubernetes Service', 'Container Apps'],
      cols: { name: ['Name'], sku: ['SKU', 'Tier'], extras: ['Kubernetes Version', 'Node Count'] } },
    { kind: 'appService',      aliases: ['App Services', 'App Service Plans', 'Web Apps'],
      cols: { name: ['Name'], sku: ['SKU', 'Tier'], extras: ['Number of Sites'] } },
    { kind: 'functionApp',     aliases: ['Function Apps', 'Functions'],
      cols: { name: ['Name'], sku: ['SKU'], extras: ['Hosting Plan'] } },
  ];
  const sheetCatalogueResolved = sheetCatalogue.map(c => ({
    ...c,
    sheet: findSheet(wb, c.aliases),
  }));

  const otherDetection: Record<string, boolean> = {};
  for (const c of sheetCatalogueResolved) otherDetection[c.kind] = Boolean(c.sheet);

  const detection = {
    vm:        Boolean(vmSheet),
    vnet:      Boolean(vnetSheet),
    subnet:    Boolean(subnetSheet),
    nic:       Boolean(nicSheet),
    peering:   Boolean(peerSheet),
    nsg:       Boolean(nsgSheet),
    publicIp:  Boolean(pipSheet),
    storage:   Boolean(storageSheet),
    others:    otherDetection,
  };

  const otherDetectionStr = sheetCatalogueResolved
    .filter(c => c.sheet)
    .map(c => `${c.kind}:${c.sheet}`)
    .join('  ');
  log(`Detected sheets — VM:${vmSheet ?? '—'}  VNET:${vnetSheet ?? '—'}  Subnet:${subnetSheet ?? '—'}  NIC:${nicSheet ?? '—'}  Peer:${peerSheet ?? '—'}  NSG:${nsgSheet ?? '—'}  PIP:${pipSheet ?? '—'}  Storage:${storageSheet ?? '—'}`);
  if (otherDetectionStr) log(`Catalogue extras — ${otherDetectionStr}`);

  const vmRows      = readSheet(wb, vmSheet);
  const vnetRows    = readSheet(wb, vnetSheet);
  const subnetRows  = readSheet(wb, subnetSheet);
  const nicRows     = readSheet(wb, nicSheet);
  const peerRows    = readSheet(wb, peerSheet);
  const nsgRows     = readSheet(wb, nsgSheet);
  const pipRows     = readSheet(wb, pipSheet);
  const storageRows = readSheet(wb, storageSheet);

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
  // ARI almost always lays out one-row-per-subnet inside the VNet sheet
  // (Microsoft ARI uses 'Subnet Name' + 'Subnet Prefix').
  for (const r of vnetRows) {
    const vn = pick(r, ['Name', 'VNet Name', 'Virtual Network Name']);
    const sn = pick(r, ['Subnet', 'Subnet Name']);
    const cidr = pick(r, ['Subnet Prefix', 'Subnet Address', 'Subnet Range', 'Subnet CIDR']);
    if (sn) addSubnet(vn, sn, cidr);
  }

  // ---- NICs: VM -> Subnet attachment ----
  // Also build a reverse map (nicName -> vmId) so PublicIP/NSG sheets can
  // resolve their attachment by NIC name back to a VM.
  const nicByVm = new Map<string, { subnetKey: string; ip: string; nicName: string }>();
  const vmIdByNicName = new Map<string, string>();
  for (const r of nicRows) {
    const nicName = pick(r, ['Name', 'NIC Name', 'Network Interface']);
    // Real ARI exports use 'Attached Resource' (with 'Attached Resource Type'
    // saying which kind). We accept it as a VM name alongside the older names
    // — non-VM attachments will simply not resolve to a VM later.
    const vmName = pick(r, ['Virtual Machine', 'VM Name', 'VM', 'Owner', 'Attached To', 'Attached Resource']);
    const subnetName = pick(r, ['Subnet', 'Subnet Name']);
    const vnetName = pick(r, ['Virtual Network', 'VNET', 'VNet', 'Network']);
    const ip = pick(r, ['Private IP', 'Private IP Address', 'IP', 'Primary IP']);
    if (!vmName) continue;
    if (nicName) vmIdByNicName.set(norm(nicName), norm(vmName));
    if (vnetName && subnetName) {
      addSubnet(vnetName, subnetName, '');
      nicByVm.set(norm(vmName), { subnetKey: subnetId(vnetName, subnetName), ip, nicName });
    } else if (subnetName) {
      // Subnet only — match by subnet name across known subnets.
      const candidate = [...subnetByKey.values()].find(s => norm(s.name) === norm(subnetName));
      if (candidate) nicByVm.set(norm(vmName), { subnetKey: candidate.id, ip, nicName });
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
      nicName: nic?.nicName ?? null,
      unknownSku,
    });
  }

  // ---- Peerings ----
  // Real ARI uses 'VNET Name' and 'Peering VNet' columns.
  const peerings: Peering[] = [];
  for (const r of peerRows) {
    const a = pick(r, ['VNet 1', 'Source VNet', 'From VNet', 'Local VNet', 'VNET Name', 'Virtual Network', 'VNET']);
    const b = pick(r, ['VNet 2', 'Target VNet', 'To VNet', 'Remote VNet', 'Peering VNet', 'Peer VNet', 'Remote Virtual Network']);
    if (!a || !b) continue;
    peerings.push({ a: norm(a), b: norm(b), state: pick(r, ['State', 'Peering State', 'Status']) });
  }

  // ---- NSGs ----
  // Real ARI exports compress the association into a "Related VNETs and Subnets"
  // string like "vnet-foo (snet-bar)" — sometimes with multiple entries comma
  // or newline-separated. We accept either the structured columns or that
  // free-text column. If multiple subnets share an NSG, the first one wins
  // for placement; the rest are reachable later if we add multi-attach.
  const nsgs: Nsg[] = [];
  for (const r of nsgRows) {
    const name = pick(r, ['Name', 'NSG Name', 'Network Security Group']);
    if (!name) continue;
    let subnetName = pick(r, ['Subnet', 'Subnet Name', 'Associated Subnet']);
    let vnetName = pick(r, ['Virtual Network', 'VNET', 'VNet', 'Associated VNet']);
    const nicName = pick(r, ['Network Interface', 'NIC', 'NIC Name', 'Associated NIC']);
    if (!subnetName && !nicName) {
      const related = pick(r, ['Related VNETs and Subnets', 'Related', 'Related Subnets']);
      // Format: "vnet-name (subnet-name)" — possibly multiple, comma/newline-separated.
      const m = related.match(/([^\s,()]+)\s*\(([^)]+)\)/);
      if (m) { vnetName = m[1].trim(); subnetName = m[2].trim(); }
    }
    nsgs.push({
      id: norm(name),
      name,
      rg: pick(r, ['Resource Group', 'ResourceGroup', 'RG']),
      location: pick(r, ['Location', 'Region']),
      subnetId: (vnetName && subnetName) ? subnetId(vnetName, subnetName)
                : (subnetName ? ([...subnetByKey.values()].find(s => norm(s.name) === norm(subnetName))?.id ?? null)
                : null),
      nicName: nicName || null,
    });
  }

  // ---- Public IPs ----
  // Real ARI uses 'Associated Resource' + 'Associated Resource Type'. We treat
  // 'Associated Resource' as a NIC name only if the type clearly says so,
  // otherwise the PIP is unattached (App Gateway / LB / Bastion attachments
  // are handled in Phase C).
  const publicIps: PublicIp[] = [];
  for (const r of pipRows) {
    const name = pick(r, ['Name', 'Public IP Name', 'PublicIP Name']);
    if (!name) continue;
    let nicName = pick(r, ['Network Interface', 'NIC', 'NIC Name', 'Associated NIC', 'Attached To']);
    if (!nicName) {
      const assocType = pick(r, ['Associated Resource Type', 'Resource Type']).toLowerCase();
      const assoc = pick(r, ['Associated Resource', 'Attached Resource']);
      if (assoc && (assocType.includes('networkinterface') || assocType.includes('nic'))) {
        nicName = assoc;
      }
    }
    publicIps.push({
      id: norm(name),
      name,
      rg: pick(r, ['Resource Group', 'ResourceGroup', 'RG']),
      location: pick(r, ['Location', 'Region']),
      ipAddress: pick(r, ['IP Address', 'Address', 'IP', 'Public IP', 'PublicIP']),
      sku: pick(r, ['SKU', 'Sku', 'Tier']) || 'Basic',
      attachedNic: nicName || null,
    });
  }

  // ---- Storage Accounts ----
  const storage: StorageAccount[] = [];
  for (const r of storageRows) {
    const name = pick(r, ['Name', 'Storage Account', 'Account Name']);
    if (!name) continue;
    const tierRaw = pick(r, ['Access Tier', 'Tier', 'Default Access Tier']).toLowerCase();
    const tier: StorageTier = tierRaw.includes('archive') ? 'archive'
                            : tierRaw.includes('cool')    ? 'cool'
                            : tierRaw.includes('hot')     ? 'hot'
                            : 'unknown';
    storage.push({
      id: norm(name),
      name,
      rg: pick(r, ['Resource Group', 'ResourceGroup', 'RG']),
      location: pick(r, ['Location', 'Region']),
      kind: pick(r, ['Kind', 'Storage Kind', 'Account Kind']),
      sku: pick(r, ['SKU', 'Sku', 'Replication']),
      tier,
    });
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

  // ---- Phase 2: Other catalogue resources (driven by sheetCatalogueResolved) ----
  const others: OtherResource[] = [];
  for (const cat of sheetCatalogueResolved) {
    if (!cat.sheet) continue;
    const rows = readSheet(wb, cat.sheet);
    for (const r of rows) {
      const name = pick(r, cat.cols.name);
      if (!name) continue;
      const sku = cat.cols.sku ? pick(r, cat.cols.sku) : '';
      const sizeRaw = cat.cols.sizeGB ? num(pick(r, cat.cols.sizeGB)) : NaN;
      const createdTime = cat.cols.createdTime ? pick(r, cat.cols.createdTime) : '';
      const extras: Record<string, string> = {};
      for (const c of cat.cols.extras) {
        const v = pick(r, [c]);
        if (v) extras[c] = v;
      }
      others.push({
        id: norm(`${cat.kind}::${name}`),
        kind: cat.kind,
        name,
        rg: pick(r, ['Resource Group', 'ResourceGroup', 'RG']),
        subscription: pick(r, ['Subscription', 'Subscription Name']),
        location: pick(r, ['Location', 'Region']),
        sku: sku || undefined,
        sizeGB: Number.isFinite(sizeRaw) ? sizeRaw : undefined,
        createdTime: createdTime || undefined,
        extras,
      });
    }
  }

  // ---- Derive hierarchy: Region -> Subscription -> ResourceGroup --------
  // Every parsed resource carries a (subscription, location, rg) triple. Roll
  // them up into the four-level estate model the SimCity 3000 layout consumes.
  type Bucket = { type: string; sub: string; loc: string; rg: string };
  const bucket: Bucket[] = [];
  for (const v of vms)        bucket.push({ type: 'vm',        sub: v.subscription, loc: v.location, rg: v.rg });
  for (const s of storage)    bucket.push({ type: 'storage',   sub: '',             loc: s.location, rg: s.rg });
  for (const n of nsgs)       bucket.push({ type: 'nsg',       sub: '',             loc: n.location, rg: n.rg });
  for (const p of publicIps)  bucket.push({ type: 'publicIp',  sub: '',             loc: p.location, rg: p.rg });
  for (const o of others)     bucket.push({ type: o.kind,      sub: o.subscription, loc: o.location, rg: o.rg });
  // Storage/NSG/PIP rows lack subscription in some ARI exports — propagate the
  // VM subscription if they share an RG. This keeps single-sub estates (the
  // common case) coherent.
  const subByRg = new Map<string, string>();
  for (const b of bucket) if (b.type === 'vm' && b.sub && b.rg) subByRg.set(b.rg, b.sub);
  for (const b of bucket) if (!b.sub && b.rg && subByRg.has(b.rg)) b.sub = subByRg.get(b.rg)!;

  // Regions
  const regionMap = new Map<string, Region>();
  for (const b of bucket) {
    if (!b.loc) continue;
    const id = norm(b.loc);
    if (!regionMap.has(id)) regionMap.set(id, { id, name: b.loc, subIds: [] });
  }
  if (regionMap.size === 0) regionMap.set('__unknown__', { id: '__unknown__', name: '(unknown region)', subIds: [] });

  // Subscriptions
  const subMap = new Map<string, Subscription>();
  for (const b of bucket) {
    const subName = b.sub || '(no subscription)';
    const id = norm(subName);
    if (!subMap.has(id)) subMap.set(id, { id, name: subName, rgIds: [] });
  }

  // Resource groups (id is sub::rg-name to avoid name collisions across subs)
  const rgMap = new Map<string, ResourceGroup>();
  const rgTypes = new Map<string, Set<string>>();
  for (const b of bucket) {
    const rgName = b.rg || '(no rg)';
    const subName = b.sub || '(no subscription)';
    const subId = norm(subName);
    const rgId = norm(`${subName}::${rgName}`);
    const regionId = b.loc ? norm(b.loc) : '__unknown__';
    if (!rgMap.has(rgId)) {
      rgMap.set(rgId, {
        id: rgId, name: rgName, subscriptionId: subId, regionId,
        resourceTypes: [],
        rciR: 0, rciC: 0, rciI: 0, rciPrimary: 'Mixed',
      });
      rgTypes.set(rgId, new Set());
    }
    rgTypes.get(rgId)!.add(b.type);
  }
  // Fill RCI bias + resourceTypes
  for (const [rgId, types] of rgTypes) {
    const rg = rgMap.get(rgId)!;
    rg.resourceTypes = [...types];
    const bias = computeRciBias(rg.resourceTypes);
    rg.rciR = bias.R; rg.rciC = bias.C; rg.rciI = bias.I; rg.rciPrimary = bias.primary;
  }

  // Wire sub -> rgs and region -> subs
  for (const rg of rgMap.values()) {
    const sub = subMap.get(rg.subscriptionId);
    if (sub && !sub.rgIds.includes(rg.id)) sub.rgIds.push(rg.id);
    const region = regionMap.get(rg.regionId);
    if (region && !region.subIds.includes(rg.subscriptionId)) region.subIds.push(rg.subscriptionId);
  }

  const regionsArr = [...regionMap.values()];
  const subsArr = [...subMap.values()];
  const rgsArr = [...rgMap.values()];

  // Per-kind summary for "others"
  const otherCounts = new Map<string, number>();
  for (const o of others) otherCounts.set(o.kind, (otherCounts.get(o.kind) ?? 0) + 1);
  const othersSummary = [...otherCounts.entries()].map(([k, c]) => `${c} ${k}`).join(' · ');

  log(`Parsed: ${vms.length} VMs · ${vnets.length} VNets · ${subnets.length} subnets · ${peerings.length} peerings · ${nsgs.length} NSGs · ${publicIps.length} PIPs · ${storage.length} storage`);
  if (othersSummary) log(`Catalogue extras parsed: ${othersSummary}`);
  log(`Hierarchy: ${regionsArr.length} regions · ${subsArr.length} subscriptions · ${rgsArr.length} resource groups`);
  if (notes.length) for (const n of notes) log(`  · ${n}`);

  return {
    regions: regionsArr,
    subscriptions: subsArr,
    resourceGroups: rgsArr,
    vms, vnets, subnets, peerings, nsgs, publicIps, storage, others,
    vmsBySubnet, subnetsByVnet, detection, notes,
  };
}
