import * as XLSX from 'xlsx';
import type { Graph, Vm, Vnet, Subnet, Peering } from './types';
import type { EstateResource, EstateModel, RbacAssignment } from './estate-model';
import type { AzureResourceType } from './estate-model';
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

function pick(row: Row, aliases: string[]): string {
  if (!row) return '';
  const map: Record<string, unknown> = {};
  for (const k of Object.keys(row)) map[norm(k)] = row[k];
  for (const a of aliases) {
    const v = map[norm(a)];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
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

function pickTags(row: Row): Record<string, string> {
  const raw = pick(row, ['Tags', 'Tag']);
  const result: Record<string, string> = {};
  if (!raw) return result;
  for (const pair of raw.split(/[;,]/)) {
    const [k, v] = pair.split(/[=:]/);
    if (k && v) result[k.trim().toLowerCase()] = v.trim();
  }
  return result;
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

const subnetId = (vnet: string, subnet: string) => `${norm(vnet)}::${norm(subnet)}`;

// ---- Cost heuristics (monthly £ estimates) ----
function vmCostEstimate(vcpu: number, ramGb: number, sku: string): number {
  const s = sku.toLowerCase();
  const hourly = s.includes('_m') ? vcpu * 0.18
    : s.includes('_e') ? vcpu * 0.08
    : s.includes('_d') ? vcpu * 0.06
    : vcpu * 0.04;
  return Math.round(hourly * 730);
}

const COST_BY_TYPE: Record<string, number> = {
  storage: 12, keyvault: 4, sql: 55, cosmos: 30, appservice: 35,
  functionapp: 6, logicapp: 8, apim: 250, aks: 180, acr: 20,
  servicebus: 18, eventhub: 25, eventgrid: 5, appgateway: 85,
  frontdoor: 60, publicip: 3, privateendpoint: 8, bastion: 45,
  vpngateway: 90, expressroute: 400, monitor: 22, defender: 15,
  recovery: 18, ai: 60, vmss: 80, unknown: 10,
};

function criticalityHeuristic(type: AzureResourceType, tags: Record<string, string>): number {
  const env = tags['environment'] ?? tags['env'] ?? '';
  const base: Record<string, number> = {
    keyvault: 9, appgateway: 8, frontdoor: 8, aks: 7, apim: 7,
    sql: 8, cosmos: 7, monitor: 6, defender: 8, recovery: 7,
    vm: 5, storage: 5, appservice: 5, functionapp: 4,
    servicebus: 6, eventhub: 6, bastion: 6, vpngateway: 7,
    expressroute: 8, publicip: 5,
  };
  const b = base[type] ?? 4;
  const envMult = env.includes('prod') ? 1.2 : env.includes('dev') ? 0.6 : 1.0;
  return Math.min(10, b * envMult);
}

function blastRadiusHeuristic(type: AzureResourceType): number {
  const scores: Record<string, number> = {
    keyvault: 9, frontdoor: 9, appgateway: 8, apim: 8,
    sql: 7, cosmos: 7, aks: 7, monitor: 6, servicebus: 6, eventhub: 6,
    appservice: 5, vm: 4, storage: 5, functionapp: 4,
    vpngateway: 8, expressroute: 9, publicip: 6,
  };
  return scores[type] ?? 3;
}

// ---- Generic resource builder ----
function makeResource(
  type: AzureResourceType,
  name: string,
  rg: string,
  subscription: string,
  location: string,
  tags: Record<string, string>,
  sku: string,
  size: number,
  subtype: string,
  costOverride?: number,
  vnetId?: string,
  subnetIdVal?: string,
): EstateResource {
  const ageDaysRaw = num(tags['age_days'] ?? '');
  const changeFreqRaw = num(tags['change_freq_30d'] ?? '');
  const baseCost = costOverride ?? COST_BY_TYPE[type] ?? 10;
  return {
    id: `${norm(subscription)}/${norm(rg)}/${norm(name)}`,
    name,
    type,
    rg,
    subscription,
    location,
    tags,
    costMonthlyGbp: baseCost,
    criticalityScore: criticalityHeuristic(type, tags),
    ageDays: Number.isFinite(ageDaysRaw) ? ageDaysRaw : 180,
    changeFreq30d: Number.isFinite(changeFreqRaw) ? changeFreqRaw : (tags['environment']?.includes('dev') ? 8 : 2),
    blastRadiusScore: blastRadiusHeuristic(type),
    sku,
    size,
    subtype,
    vnetId: vnetId ?? null,
    subnetId: subnetIdVal ?? null,
  };
}

export function parseAri(
  buf: ArrayBuffer,
  log: (msg: string) => void,
): { graph: Graph; estate: EstateModel } {
  const wb = XLSX.read(buf, { type: 'array' });
  log(`Workbook: ${wb.SheetNames.length} sheets — ${wb.SheetNames.join(', ')}`);

  // ---- Sheet detection ----
  const vmSheet      = findSheet(wb, ['Virtual Machines', 'VM', 'Compute']);
  const vnetSheet    = findSheet(wb, ['Virtual Network', 'VNET', 'VirtualNetworks']);
  const subnetSheet  = findSheet(wb, ['Subnets', 'Subnet']);
  const nicSheet     = findSheet(wb, ['Network Interface', 'NetworkInterface', 'NIC', 'NICs']);
  const peerSheet    = findSheet(wb, ['VNET Peerings', 'Peering', 'Peerings']);
  const storageSheet = findSheet(wb, ['Storage Accounts', 'Storage', 'Blobs']);
  const kvSheet      = findSheet(wb, ['Key Vaults', 'KeyVaults', 'KeyVault']);
  const sqlSheet     = findSheet(wb, ['SQL Databases', 'SQL DBs', 'SQL', 'Databases']);
  const appSvcSheet  = findSheet(wb, ['App Services', 'Web Apps', 'Sites', 'AppServices']);
  const aksSheet     = findSheet(wb, ['AKS', 'Kubernetes', 'Managed Clusters', 'ManagedClusters']);
  const funcSheet    = findSheet(wb, ['Function Apps', 'Functions', 'FunctionApps']);
  const agwSheet     = findSheet(wb, ['Application Gateways', 'App Gateways', 'AppGateways', 'AGW']);
  // New sheets
  const ehSheet      = findSheet(wb, ['Event Hubs', 'EventHubs', 'Event Hub Namespaces']);
  const sbSheet      = findSheet(wb, ['Service Bus', 'ServiceBus', 'Service Bus Namespaces']);
  const monSheet     = findSheet(wb, ['Log Analytics', 'LogAnalytics', 'Monitor', 'Workspaces']);
  const pipSheet     = findSheet(wb, ['Public IP', 'Public IP Addresses', 'PublicIP', 'PublicIPs']);
  const erSheet      = findSheet(wb, ['ExpressRoute', 'Express Route', 'ExpressRoute Circuits']);
  const vpngwSheet   = findSheet(wb, ['Virtual Network Gateways', 'VPN Gateways', 'VPN Gateway', 'VPNGateways']);
  const rbacSheet    = findSheet(wb, ['Role Assignments', 'RBAC', 'RoleAssignments']);

  log(`Sheets — VM:${vmSheet ?? '—'}  Storage:${storageSheet ?? '—'}  KV:${kvSheet ?? '—'}  ` +
      `EH:${ehSheet ?? '—'}  SB:${sbSheet ?? '—'}  MON:${monSheet ?? '—'}  ` +
      `PIP:${pipSheet ?? '—'}  ER:${erSheet ?? '—'}  VPN:${vpngwSheet ?? '—'}  RBAC:${rbacSheet ?? '—'}`);

  const vmRows      = readSheet(wb, vmSheet);
  const vnetRows    = readSheet(wb, vnetSheet);
  const subnetRows  = readSheet(wb, subnetSheet);
  const nicRows     = readSheet(wb, nicSheet);
  const peerRows    = readSheet(wb, peerSheet);
  const storageRows = readSheet(wb, storageSheet);
  const kvRows      = readSheet(wb, kvSheet);
  const sqlRows     = readSheet(wb, sqlSheet);
  const appSvcRows  = readSheet(wb, appSvcSheet);
  const aksRows     = readSheet(wb, aksSheet);
  const funcRows    = readSheet(wb, funcSheet);
  const agwRows     = readSheet(wb, agwSheet);
  const ehRows      = readSheet(wb, ehSheet);
  const sbRows      = readSheet(wb, sbSheet);
  const monRows     = readSheet(wb, monSheet);
  const pipRows     = readSheet(wb, pipSheet);
  const erRows      = readSheet(wb, erSheet);
  const vpngwRows   = readSheet(wb, vpngwSheet);
  const rbacRows    = readSheet(wb, rbacSheet);

  const detection = {
    vm:      Boolean(vmSheet),
    vnet:    Boolean(vnetSheet),
    subnet:  Boolean(subnetSheet),
    nic:     Boolean(nicSheet),
    peering: Boolean(peerSheet),
  };

  // ---- VNets ----
  const vnetByKey = new Map<string, Vnet>();
  for (const r of vnetRows) {
    const name = pick(r, ['Name', 'VNet Name', 'Virtual Network Name', 'VNET']);
    if (!name) continue;
    const v: Vnet = {
      id: norm(name),
      name,
      rg:           pick(r, ['Resource Group', 'ResourceGroup', 'RG']),
      location:     pick(r, ['Location', 'Region']),
      addressSpace: pick(r, ['Address Space', 'AddressSpace', 'CIDR', 'Address Prefixes', 'Address Prefix']),
    };
    vnetByKey.set(v.id, v);
  }

  // ---- Subnets ----
  const subnetByKey = new Map<string, Subnet>();
  const addSubnet = (vnetName: string, name: string, cidr: string) => {
    if (!vnetName || !name) return;
    const vnetIdNorm = norm(vnetName);
    const id = subnetId(vnetName, name);
    if (!subnetByKey.has(id)) subnetByKey.set(id, { id, name, vnetId: vnetIdNorm, cidr });
    if (!vnetByKey.has(vnetIdNorm))
      vnetByKey.set(vnetIdNorm, { id: vnetIdNorm, name: vnetName, rg: '', location: '', addressSpace: '' });
  };

  for (const r of subnetRows) {
    addSubnet(
      pick(r, ['Virtual Network', 'VNet', 'VNET', 'VNet Name', 'Network']),
      pick(r, ['Subnet', 'Subnet Name', 'Name']),
      pick(r, ['Address Range', 'Subnet Address', 'CIDR', 'Subnet Range', 'Address Prefix']),
    );
  }
  for (const r of vnetRows) {
    const sn = pick(r, ['Subnet', 'Subnet Name']);
    if (sn) addSubnet(pick(r, ['Name', 'VNet Name', 'Virtual Network Name']), sn,
                      pick(r, ['Subnet Address', 'Subnet Range', 'Subnet CIDR']));
  }

  // ---- NICs ----
  const nicByVm = new Map<string, { subnetKey: string; ip: string; vnetId: string }>();
  for (const r of nicRows) {
    const vmName    = pick(r, ['Virtual Machine', 'VM Name', 'VM', 'Owner', 'Attached To']);
    const subnetName = pick(r, ['Subnet', 'Subnet Name']);
    const vnetName  = pick(r, ['Virtual Network', 'VNET', 'VNet', 'Network']);
    const ip        = pick(r, ['Private IP', 'Private IP Address', 'IP', 'Primary IP']);
    if (!vmName) continue;
    if (vnetName && subnetName) {
      addSubnet(vnetName, subnetName, '');
      nicByVm.set(norm(vmName), { subnetKey: subnetId(vnetName, subnetName), ip, vnetId: norm(vnetName) });
    } else if (subnetName) {
      const candidate = [...subnetByKey.values()].find(s => norm(s.name) === norm(subnetName));
      if (candidate) nicByVm.set(norm(vmName), { subnetKey: candidate.id, ip, vnetId: candidate.vnetId });
    }
  }

  // ---- VMs ----
  const vms: Vm[] = [];
  const estateResources: EstateResource[] = [];
  let unknownSkuCount = 0;

  for (const r of vmRows) {
    const name = pick(r, ['Name', 'VM Name', 'Virtual Machine']);
    if (!name) continue;
    const sku    = pick(r, ['VM Size', 'Size', 'SKU', 'VM SKU']);
    const vCpuCol = num(pick(r, ['vCPUs', 'vCPU', 'CPU', 'Cores']));
    const ramCol  = num(pick(r, ['Memory', 'Memory (GB)', 'RAM', 'RAM (GB)', 'Memory GB']));

    let vCPU = vCpuCol, ramGB = ramCol, unknownSku = false;
    if (!Number.isFinite(vCPU) || !Number.isFinite(ramGB) || vCPU <= 0 || ramGB <= 0) {
      const fb = lookupSku(sku);
      if (!Number.isFinite(vCPU) || vCPU <= 0) vCPU = fb.vCPU;
      if (!Number.isFinite(ramGB) || ramGB <= 0) ramGB = fb.ramGB;
      if (!fb.known && sku) { unknownSku = true; unknownSkuCount++; }
    }

    const rg           = pick(r, ['Resource Group', 'ResourceGroup', 'RG']);
    const subscription = pick(r, ['Subscription', 'Subscription Name']);
    const location     = pick(r, ['Location', 'Region']);
    const os           = classifyOs(pick(r, ['OS', 'Operating System', 'OS Type', 'Image Reference', 'Image']));
    const tags         = pickTags(r);
    const id           = norm(name);
    const nic          = nicByVm.get(id);

    let subnetIdLink: string | null = nic?.subnetKey ?? null;
    if (!subnetIdLink) {
      const vmVnet   = pick(r, ['Virtual Network', 'VNET', 'VNet']);
      const vmSubnet = pick(r, ['Subnet']);
      if (vmVnet && vmSubnet) { addSubnet(vmVnet, vmSubnet, ''); subnetIdLink = subnetId(vmVnet, vmSubnet); }
    }

    vms.push({ id, name, rg, subscription, location, sku, os, vCPU, ramGB,
               subnetId: subnetIdLink, privateIp: nic?.ip ?? null, unknownSku });

    estateResources.push(makeResource(
      'vm', name, rg, subscription, location, tags, sku, vCPU, os,
      vmCostEstimate(vCPU, ramGB, sku), nic?.vnetId ?? undefined, subnetIdLink ?? undefined,
    ));
  }

  // ---- Storage Accounts ----
  for (const r of storageRows) {
    const name = pick(r, ['Name', 'Storage Account Name', 'Account Name']);
    if (!name) continue;
    estateResources.push(makeResource(
      'storage', name,
      pick(r, ['Resource Group', 'RG', 'ResourceGroup']),
      pick(r, ['Subscription', 'Subscription Name']),
      pick(r, ['Location', 'Region']),
      pickTags(r),
      pick(r, ['SKU', 'Sku', 'Replication', 'Kind']),
      0, pick(r, ['Kind', 'Type']),
    ));
  }

  // ---- Key Vaults ----
  for (const r of kvRows) {
    const name = pick(r, ['Name', 'Key Vault Name', 'Vault Name']);
    if (!name) continue;
    estateResources.push(makeResource(
      'keyvault', name,
      pick(r, ['Resource Group', 'RG', 'ResourceGroup']),
      pick(r, ['Subscription', 'Subscription Name']),
      pick(r, ['Location', 'Region']),
      pickTags(r),
      pick(r, ['SKU', 'Tier', 'Pricing Tier']),
      0, '',
    ));
  }

  // ---- SQL Databases ----
  for (const r of sqlRows) {
    const name = pick(r, ['Name', 'Database Name', 'DB Name']);
    if (!name) continue;
    const tier = pick(r, ['Tier', 'SKU', 'Edition', 'Service Objective', 'Service Tier']);
    const cost = tier.toLowerCase().includes('premium') ? 350 :
                 tier.toLowerCase().includes('business') ? 200 : 55;
    estateResources.push(makeResource(
      'sql', name,
      pick(r, ['Resource Group', 'RG', 'ResourceGroup']),
      pick(r, ['Subscription', 'Subscription Name']),
      pick(r, ['Location', 'Region']),
      pickTags(r),
      tier, 0, pick(r, ['Server', 'Server Name']),
      cost,
    ));
  }

  // ---- App Services ----
  for (const r of appSvcRows) {
    const name = pick(r, ['Name', 'App Name', 'Site Name']);
    if (!name) continue;
    const kind = pick(r, ['Kind', 'App Kind', 'Type']).toLowerCase();
    const type: AzureResourceType = kind.includes('function') ? 'functionapp' : 'appservice';
    estateResources.push(makeResource(
      type, name,
      pick(r, ['Resource Group', 'RG', 'ResourceGroup']),
      pick(r, ['Subscription', 'Subscription Name']),
      pick(r, ['Location', 'Region']),
      pickTags(r),
      pick(r, ['SKU', 'Tier', 'App Service Plan', 'Plan SKU', 'Size']),
      0, kind,
    ));
  }

  // ---- AKS Clusters ----
  for (const r of aksRows) {
    const name = pick(r, ['Name', 'Cluster Name', 'AKS Name']);
    if (!name) continue;
    const nodeCount = num(pick(r, ['Node Count', 'Nodes', 'Agent Count', 'System Node Count']));
    estateResources.push(makeResource(
      'aks', name,
      pick(r, ['Resource Group', 'RG', 'ResourceGroup']),
      pick(r, ['Subscription', 'Subscription Name']),
      pick(r, ['Location', 'Region']),
      pickTags(r),
      pick(r, ['VM Size', 'Node VM Size', 'SKU', 'Node Size']),
      Number.isFinite(nodeCount) ? nodeCount : 3,
      pick(r, ['Kubernetes Version', 'Version']),
      COST_BY_TYPE['aks']! * (Number.isFinite(nodeCount) ? nodeCount : 3),
    ));
  }

  // ---- Function Apps (dedicated sheet) ----
  for (const r of funcRows) {
    const name = pick(r, ['Name', 'Function App Name', 'App Name']);
    if (!name) continue;
    estateResources.push(makeResource(
      'functionapp', name,
      pick(r, ['Resource Group', 'RG', 'ResourceGroup']),
      pick(r, ['Subscription', 'Subscription Name']),
      pick(r, ['Location', 'Region']),
      pickTags(r),
      pick(r, ['SKU', 'Hosting Plan', 'Plan']),
      0, 'functionapp',
    ));
  }

  // ---- Application Gateways ----
  for (const r of agwRows) {
    const name = pick(r, ['Name', 'Gateway Name', 'App Gateway Name']);
    if (!name) continue;
    estateResources.push(makeResource(
      'appgateway', name,
      pick(r, ['Resource Group', 'RG', 'ResourceGroup']),
      pick(r, ['Subscription', 'Subscription Name']),
      pick(r, ['Location', 'Region']),
      pickTags(r),
      pick(r, ['SKU', 'Tier', 'Size']),
      0, '',
    ));
  }

  // ---- Event Hubs ----
  for (const r of ehRows) {
    const name = pick(r, ['Name', 'Namespace', 'Event Hub Namespace', 'Event Hub Name']);
    if (!name) continue;
    estateResources.push(makeResource(
      'eventhub', name,
      pick(r, ['Resource Group', 'RG', 'ResourceGroup']),
      pick(r, ['Subscription', 'Subscription Name']),
      pick(r, ['Location', 'Region']),
      pickTags(r),
      pick(r, ['SKU', 'Tier', 'Pricing Tier']),
      0, '',
    ));
  }

  // ---- Service Bus ----
  for (const r of sbRows) {
    const name = pick(r, ['Name', 'Namespace', 'Service Bus Namespace']);
    if (!name) continue;
    estateResources.push(makeResource(
      'servicebus', name,
      pick(r, ['Resource Group', 'RG', 'ResourceGroup']),
      pick(r, ['Subscription', 'Subscription Name']),
      pick(r, ['Location', 'Region']),
      pickTags(r),
      pick(r, ['SKU', 'Tier']),
      0, '',
    ));
  }

  // ---- Log Analytics / Monitor ----
  for (const r of monRows) {
    const name = pick(r, ['Name', 'Workspace Name', 'Log Analytics Workspace']);
    if (!name) continue;
    estateResources.push(makeResource(
      'monitor', name,
      pick(r, ['Resource Group', 'RG', 'ResourceGroup']),
      pick(r, ['Subscription', 'Subscription Name']),
      pick(r, ['Location', 'Region']),
      pickTags(r),
      pick(r, ['SKU', 'Tier']),
      0, '',
    ));
  }

  // ---- Public IP Addresses ----
  for (const r of pipRows) {
    const name = pick(r, ['Name', 'Public IP Name', 'IP Name']);
    if (!name) continue;
    estateResources.push(makeResource(
      'publicip', name,
      pick(r, ['Resource Group', 'RG', 'ResourceGroup']),
      pick(r, ['Subscription', 'Subscription Name']),
      pick(r, ['Location', 'Region']),
      pickTags(r),
      pick(r, ['SKU', 'Tier']),
      0, pick(r, ['IP Address', 'IP']),
    ));
  }

  // ---- ExpressRoute Circuits ----
  for (const r of erRows) {
    const name = pick(r, ['Name', 'Circuit Name', 'ExpressRoute Name']);
    if (!name) continue;
    estateResources.push(makeResource(
      'expressroute', name,
      pick(r, ['Resource Group', 'RG', 'ResourceGroup']),
      pick(r, ['Subscription', 'Subscription Name']),
      pick(r, ['Location', 'Region']),
      pickTags(r),
      pick(r, ['SKU', 'Tier', 'Bandwidth']),
      num(pick(r, ['Bandwidth', 'Bandwidth (Mbps)'])) || 0,
      pick(r, ['Provider', 'Service Provider']),
    ));
  }

  // ---- VPN Gateways ----
  for (const r of vpngwRows) {
    const name = pick(r, ['Name', 'Gateway Name', 'VPN Gateway Name']);
    if (!name) continue;
    estateResources.push(makeResource(
      'vpngateway', name,
      pick(r, ['Resource Group', 'RG', 'ResourceGroup']),
      pick(r, ['Subscription', 'Subscription Name']),
      pick(r, ['Location', 'Region']),
      pickTags(r),
      pick(r, ['SKU', 'Tier']),
      0, pick(r, ['VPN Type', 'Type']),
    ));
  }

  // ---- Peerings ----
  const peerings: Peering[] = [];
  for (const r of peerRows) {
    const a = pick(r, ['VNet 1', 'Source VNet', 'From VNet', 'Local VNet', 'Virtual Network', 'VNET']);
    const b = pick(r, ['VNet 2', 'Target VNet', 'To VNet', 'Remote VNet', 'Peer VNet', 'Remote Virtual Network']);
    if (!a || !b) continue;
    peerings.push({ a: norm(a), b: norm(b), state: pick(r, ['State', 'Peering State', 'Status']) });
  }

  // ---- RBAC Role Assignments ----
  const rbacAssignments: RbacAssignment[] = [];
  for (const r of rbacRows) {
    const principal = pick(r, ['Principal Name', 'Principal', 'User', 'Object Name', 'Display Name']);
    const role      = pick(r, ['Role Definition Name', 'Role Name', 'Role', 'Permission']);
    const scope     = pick(r, ['Scope', 'Resource Scope', 'Assignment Scope']);
    const sub       = pick(r, ['Subscription', 'Subscription Name']);
    const rg        = pick(r, ['Resource Group', 'RG', 'ResourceGroup']);
    if (!principal || !role) continue;

    // Parse RG from scope if not provided directly
    let rgName = rg || null;
    if (!rgName && scope) {
      const m = scope.match(/\/resourceGroups?\/([^/]+)/i);
      if (m) rgName = m[1] ?? null;
    }
    let subscriptionName = sub;
    if (!subscriptionName && scope) {
      const m = scope.match(/\/subscriptions?\/([^/]+)/i);
      if (m) subscriptionName = m[1] ?? '';
    }

    if (!subscriptionName) continue;
    rbacAssignments.push({
      principalName: principal,
      principalType: pick(r, ['Principal Type', 'Object Type', 'Type']) || 'User',
      roleName: role,
      subscriptionName,
      rgName,
    });
  }

  // ---- Group structures for Graph (3D terrain) ----
  const subnets = [...subnetByKey.values()];
  const vnets   = [...vnetByKey.values()];

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

  // ---- Group structures for EstateModel (OS map) ----
  const resourcesByRg = new Map<string, EstateResource[]>();
  const rgsBySubscription = new Map<string, string[]>();

  for (const res of estateResources) {
    const key = `${res.subscription}||${res.rg}`;
    if (!resourcesByRg.has(key)) resourcesByRg.set(key, []);
    resourcesByRg.get(key)!.push(res);

    if (!rgsBySubscription.has(res.subscription)) rgsBySubscription.set(res.subscription, []);
    const rgs = rgsBySubscription.get(res.subscription)!;
    if (!rgs.includes(res.rg)) rgs.push(res.rg);
  }

  // Subscriptions ordered by total cost descending
  const subscriptions = [...rgsBySubscription.keys()].sort((a, b) => {
    const costA = [...resourcesByRg.entries()]
      .filter(([k]) => k.startsWith(a + '||'))
      .reduce((s, [, rs]) => s + rs.reduce((c, r) => c + r.costMonthlyGbp, 0), 0);
    const costB = [...resourcesByRg.entries()]
      .filter(([k]) => k.startsWith(b + '||'))
      .reduce((s, [, rs]) => s + rs.reduce((c, r) => c + r.costMonthlyGbp, 0), 0);
    return costB - costA;
  });

  const vnetById = new Map(vnets.map(v => [v.id, v]));

  const resourcesByVnet = new Map<string, EstateResource[]>();
  for (const res of estateResources) {
    if (!res.vnetId) continue;
    if (!resourcesByVnet.has(res.vnetId)) resourcesByVnet.set(res.vnetId, []);
    resourcesByVnet.get(res.vnetId)!.push(res);
  }

  // ---- Notes ----
  const orphanCount = vms.filter(v => !v.subnetId).length;
  const notes: string[] = [];
  if (unknownSkuCount > 0) notes.push(`${unknownSkuCount} VM(s) had unrecognised SKUs.`);
  if (orphanCount > 0)     notes.push(`${orphanCount} VM(s) could not be linked to a subnet.`);
  if (!detection.nic)      notes.push(`No NIC sheet found — VM/subnet links inferred from VM sheet.`);

  const totalResources = estateResources.length;
  log(`Parsed: ${vms.length} VMs · ${vnets.length} VNets · ${subnets.length} subnets · ` +
      `${peerings.length} peerings · ${rbacAssignments.length} RBAC assignments · ` +
      `${totalResources} total resources across ${subscriptions.length} subscription(s)`);
  if (notes.length) for (const n of notes) log(`  · ${n}`);

  const graph: Graph = { vms, vnets, subnets, peerings, vmsBySubnet, subnetsByVnet, detection, notes };
  const estate: EstateModel = {
    resources: estateResources,
    subscriptions,
    resourcesByRg,
    rgsBySubscription,
    vnets,
    subnets,
    peerings,
    vnetById,
    resourcesByVnet,
    rbacAssignments,
    notes,
  };

  return { graph, estate };
}
