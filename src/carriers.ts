// PRD §5.4 numeric carriers.
// Cost is synthesised from SKU lookup tables, age from Created Time when
// present, and the rest are seeded from a stable id hash so a given resource
// always renders with the same overlay tint across reloads. Comments call
// out which carriers are real-from-ARI vs synthetic.

import type {
  Carriers, Vm, StorageAccount, Nsg, PublicIp, OtherResource,
} from './types';

// FNV-1a-ish hash → 0..1 (deterministic, no deps)
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

// Roll a 0..1 deterministic value with a per-axis salt so different carriers
// don't all correlate to the same "high tile".
function roll(id: string, salt: string): number {
  return hash01(id + '::' + salt);
}

// Convert a possibly-ARI date string to age in days.
function ageDaysFrom(createdTime: string | undefined, fallbackId: string): number {
  if (!createdTime) {
    return Math.round(roll(fallbackId, 'age') * 1500);
  }
  const t = Date.parse(createdTime);
  if (!Number.isFinite(t)) return Math.round(roll(fallbackId, 'age') * 1500);
  const now = Date.now();
  return Math.max(0, Math.round((now - t) / 86_400_000));
}

// ---- Cost models -------------------------------------------------------
// Numbers are rough westeurope on-demand list prices in GBP/month. They
// are NOT pulled from Cost Management — they're a synthesis from public
// pricing tables for the canonical SKU. The point is to give the cost
// overlay something realistic-shaped to render.

function costForVm(v: Vm): number {
  // ~ £20/vCPU/month + £4/RAM-GB/month for D-series. Inflate for M-series.
  const sku = v.sku?.toLowerCase() ?? '';
  let multiplier = 1;
  if (sku.includes('m')) multiplier = 2.4;          // M-series (memory-optimised)
  else if (sku.includes('e')) multiplier = 1.6;     // E-series
  else if (sku.includes('f')) multiplier = 1.3;     // F-series (compute)
  return Math.round(((v.vCPU || 1) * 20 + (v.ramGB || 1) * 4) * multiplier);
}

function costForStorage(s: StorageAccount): number {
  const sku = s.sku.toLowerCase();
  let perGb = 0.018;                                 // standard hot
  if (sku.includes('premium')) perGb = 0.130;
  else if (s.tier === 'cool') perGb = 0.009;
  else if (s.tier === 'archive') perGb = 0.001;
  // No capacity in ARI export — assume 500 GB-typical to drive a usable spread.
  // Real implementation would join with Cost Management API per resource id.
  const assumedCapacityGb = 500 + Math.round(roll(s.id, 'cap') * 4500);
  return Math.round(assumedCapacityGb * perGb * 30);
}

const FIXED_COST_BY_KIND: Record<string, number> = {
  nsg: 0,                  // free in Azure
  publicIp: 3,             // ~£3/m for a Standard PIP
  keyVault: 1,             // operations-billed; nominal
  sqlDb: 350,              // GP S Gen5 4 vCore-ish
  sqlServer: 0,            // free, the DB pays
  sqlVm: 60,               // licence cost on top of VM compute
  recoveryVault: 80,       // small DR vault
  appGateway: 220,         // Standard tier baseline
  privateEndpoint: 7,
  logAnalytics: 90,
  bastion: 110,
  acr: 4,                  // Basic
  aks: 60,                 // control plane
  appService: 130,         // S1
  functionApp: 12,         // consumption-equivalent baseline
  logicApp: 8,
  serviceBus: 8,
  apim: 290,               // Developer baseline
  defender: 12,
  vmss: 0,                 // pays per instance, like VMs
  databricks: 0,           // pays per cluster, like VMs
  disk: 0,                 // accounted under VM
  availabilitySet: 0,
  routeTable: 0,
  managedIdentity: 0,
};

function costForOther(o: OtherResource): number {
  const base = FIXED_COST_BY_KIND[o.kind] ?? 5;
  // Modest stage uplift: Premium SKU + 60%, Standard +20%, Basic baseline.
  const sku = (o.sku ?? '').toLowerCase();
  let mult = 1;
  if (sku.includes('premium')) mult = 1.6;
  else if (sku.includes('isolated')) mult = 2.4;
  else if (sku.includes('standard')) mult = 1.2;
  // Disks: sized per-GB.
  if (o.kind === 'disk' && o.sizeGB) {
    const skuLow = (o.sku ?? '').toLowerCase();
    let perGb = 0.04;
    if (skuLow.includes('premium')) perGb = 0.13;
    else if (skuLow.includes('ultra')) perGb = 0.30;
    return Math.round(o.sizeGB * perGb);
  }
  return Math.round(base * mult);
}

// ---- Public API: build Carriers per kind --------------------------------

export function carriersForVm(v: Vm): Carriers {
  return {
    costMonthlyGbp: costForVm(v),
    utilisationPct: Math.round(roll(v.id, 'util') * 100),
    ageDays: Math.round(roll(v.id, 'age') * 1200),       // VMs have no Created Time in standard ARI
    defenderDelta: Math.round(roll(v.id, 'def') * 60),
    unauthAttempts: Math.round(roll(v.id, 'unauth') * 80),
    changeFreq: Math.round(roll(v.id, 'churn') * 40),
  };
}

export function carriersForStorage(s: StorageAccount): Carriers {
  return {
    costMonthlyGbp: costForStorage(s),
    utilisationPct: Math.round(roll(s.id, 'util') * 100),
    ageDays: Math.round(roll(s.id, 'age') * 1500),
    defenderDelta: Math.round(roll(s.id, 'def') * 50),
    unauthAttempts: Math.round(roll(s.id, 'unauth') * 30),
    changeFreq: Math.round(roll(s.id, 'churn') * 15),
  };
}

export function carriersForNsg(n: Nsg): Carriers {
  return {
    costMonthlyGbp: 0,
    utilisationPct: Math.round(roll(n.id, 'util') * 100),
    ageDays: Math.round(roll(n.id, 'age') * 800),
    defenderDelta: Math.round(roll(n.id, 'def') * 40),
    unauthAttempts: Math.round(roll(n.id, 'unauth') * 200),  // checkpoints SEE the attempts
    changeFreq: Math.round(roll(n.id, 'churn') * 20),
  };
}

export function carriersForPublicIp(p: PublicIp): Carriers {
  return {
    costMonthlyGbp: p.sku.toLowerCase().includes('standard') ? 4 : 2,
    utilisationPct: Math.round(roll(p.id, 'util') * 100),
    ageDays: Math.round(roll(p.id, 'age') * 1000),
    defenderDelta: Math.round(roll(p.id, 'def') * 30),
    unauthAttempts: Math.round(roll(p.id, 'unauth') * 500),
    changeFreq: Math.round(roll(p.id, 'churn') * 10),
  };
}

export function carriersForOther(o: OtherResource): Carriers {
  return {
    costMonthlyGbp: costForOther(o),
    utilisationPct: Math.round(roll(o.id, 'util') * 100),
    ageDays: ageDaysFrom(o.createdTime, o.id),
    defenderDelta: Math.round(roll(o.id, 'def') * 50),
    unauthAttempts: Math.round(roll(o.id, 'unauth') * 100),
    changeFreq: Math.round(roll(o.id, 'churn') * 30),
  };
}

// ---- Coverage emitters (PRD §5.6 service coverage radii) ----------------
// Civic resources radiate a coverage zone. Resources outside the union of
// relevant radii render as "underserved" — exactly how SimCity 3000 shows
// neglected districts. Radii are in world units, tuned for the layout's
// TILE pitch.

export function coverageFor(o: OtherResource): { radius: number; service: 'secrets' | 'backup' | 'security' | 'monitoring' } | undefined {
  switch (o.kind) {
    case 'keyVault':      return { radius: 32, service: 'secrets' };
    case 'recoveryVault': return { radius: 36, service: 'backup' };
    case 'defender':      return { radius: 48, service: 'security' };
    case 'logAnalytics':  return { radius: 40, service: 'monitoring' };
    default: return undefined;
  }
}
