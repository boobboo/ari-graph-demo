import { OS } from './palette';
import type { AzureResourceType } from '../estate-model';
import type { ResourceSymbol, SymbolShape } from './types';
import type { EstateResource } from '../estate-model';

interface CatalogueEntry {
  shape: SymbolShape;
  fill: string;
  abbrev: string;
  description: string;
  category: string;
  baseSize: number;
}

const CAT: Record<AzureResourceType, CatalogueEntry> = {
  vm:              { shape: 'square',      fill: OS.vmLinux,    abbrev: 'VM',  description: 'Virtual Machine (isolated farmhouse)',     category: 'settlement', baseSize: 8 },
  vmss:            { shape: 'squares',     fill: OS.vmLinux,    abbrev: 'VMSS',description: 'VM Scale Set (hamlet)',                    category: 'settlement', baseSize: 10 },
  storage:         { shape: 'reservoir',   fill: '#B5D4F0',     abbrev: 'ST',  description: 'Storage Account (reservoir)',              category: 'water',      baseSize: 10 },
  keyvault:        { shape: 'castle',      fill: '#E8C8B0',     abbrev: 'KV',  description: 'Key Vault (castle, fortified)',            category: 'antiquity',  baseSize: 10 },
  sql:             { shape: 'quarry',      fill: '#D8D0C8',     abbrev: 'SQL', description: 'SQL Database (quarry)',                    category: 'general',    baseSize: 9 },
  cosmos:          { shape: 'quarry',      fill: '#D8D0C8',     abbrev: 'COS', description: 'Cosmos DB (quarry)',                       category: 'general',    baseSize: 9 },
  appservice:      { shape: 'spire',       fill: '#F0E8D0',     abbrev: 'AS',  description: 'App Service (village with church spire)',  category: 'settlement', baseSize: 10 },
  functionapp:     { shape: 'building',    fill: '#F0E8D0',     abbrev: 'FA',  description: 'Function App (isolated building)',         category: 'general',    baseSize: 8 },
  logicapp:        { shape: 'junction',    fill: '#E8E8D8',     abbrev: 'LA',  description: 'Logic App (footpath junction)',            category: 'general',    baseSize: 8 },
  apim:            { shape: 'market',      fill: '#F0D8C0',     abbrev: 'APM', description: 'API Management (market town)',             category: 'settlement', baseSize: 12 },
  aks:             { shape: 'builtup-area',fill: '#FFC0B5',     abbrev: 'AKS', description: 'AKS Cluster (built-up area)',              category: 'settlement', baseSize: 14 },
  acr:             { shape: 'silo',        fill: '#E8D8B8',     abbrev: 'ACR', description: 'Container Registry (granary/silo)',        category: 'general',    baseSize: 8 },
  servicebus:      { shape: 'post',        fill: '#D8E8D8',     abbrev: 'SB',  description: 'Service Bus (postal sorting office)',      category: 'general',    baseSize: 8 },
  eventhub:        { shape: 'post',        fill: '#D8E8D8',     abbrev: 'EH',  description: 'Event Hub (postal sorting office)',        category: 'general',    baseSize: 8 },
  eventgrid:       { shape: 'post',        fill: '#D8E8D8',     abbrev: 'EG',  description: 'Event Grid (postal sorting office)',       category: 'general',    baseSize: 8 },
  appgateway:      { shape: 'tollbooth',   fill: '#E8D8E8',     abbrev: 'AGW', description: 'App Gateway (toll booth)',                 category: 'general',    baseSize: 10 },
  frontdoor:       { shape: 'tollbooth',   fill: '#E8D8E8',     abbrev: 'FD',  description: 'Front Door (toll booth)',                  category: 'general',    baseSize: 10 },
  publicip:        { shape: 'lighthouse',  fill: '#FFFFD0',     abbrev: 'PIP', description: 'Public IP (lighthouse)',                   category: 'tourist',    baseSize: 10 },
  privateendpoint: { shape: 'bridge',      fill: '#D8D8C8',     abbrev: 'PE',  description: 'Private Endpoint (bridge over ravine)',    category: 'general',    baseSize: 8 },
  bastion:         { shape: 'police',      fill: '#D0D8FF',     abbrev: 'BAS', description: 'Bastion (police station)',                 category: 'general',    baseSize: 10 },
  vpngateway:      { shape: 'square',      fill: '#FFE0D0',     abbrev: 'VPN', description: 'VPN Gateway (fortified crossing)',         category: 'general',    baseSize: 9 },
  expressroute:    { shape: 'square',      fill: '#D0E0FF',     abbrev: 'ER',  description: 'ExpressRoute (motorway junction)',         category: 'general',    baseSize: 9 },
  monitor:         { shape: 'trig',        fill: 'none',        abbrev: 'MON', description: 'Azure Monitor / Log Analytics (trig point)',category: 'relief',    baseSize: 10 },
  defender:        { shape: 'fort',        fill: '#FFE8E8',     abbrev: 'DEF', description: 'Defender for Cloud (hilltop fort)',        category: 'antiquity',  baseSize: 10 },
  recovery:        { shape: 'hospital',    fill: '#E8FFE8',     abbrev: 'RSV', description: 'Recovery Services Vault (hospital)',       category: 'tourist',    baseSize: 10 },
  ai:              { shape: 'observatory', fill: '#E8E8FF',     abbrev: 'AI',  description: 'Azure AI / ML (observatory)',              category: 'tourist',    baseSize: 10 },
  unknown:         { shape: 'circle',      fill: OS.vmOther,    abbrev: '?',   description: 'Unknown resource',                        category: 'general',    baseSize: 7 },
};

function vmSizeFromResource(r: EstateResource): number {
  const vcpu = r.size ?? 1;
  if (vcpu >= 64) return 14;
  if (vcpu >= 16) return 12;
  if (vcpu >= 8)  return 10;
  if (vcpu >= 4)  return 8;
  return 6;
}

export function resourceToSymbol(r: EstateResource): ResourceSymbol {
  const entry = CAT[r.type] ?? CAT.unknown;
  let size = entry.baseSize;
  let fill = entry.fill;

  if (r.type === 'vm') {
    size = vmSizeFromResource(r);
    fill = r.subtype === 'windows' ? OS.vmWindows
         : r.subtype === 'linux'   ? OS.vmLinux
         : OS.vmOther;
  } else if (r.type === 'aks') {
    const nodes = r.size ?? 3;
    size = Math.min(18, 10 + Math.floor(nodes / 2));
  } else if (r.type === 'vmss') {
    size = Math.min(14, 8 + Math.floor((r.size ?? 2) / 3));
  }

  return {
    shape: entry.shape,
    size,
    fill,
    stroke: OS.vmStroke,
    label: r.name,
    abbrev: entry.abbrev,
    description: entry.description,
    category: entry.category,
  };
}

export function isTrigPoint(r: EstateResource): boolean {
  // Monitor/Log Analytics are the designated trig point resources
  if (r.type === 'monitor') return true;
  // Large VMs and AKS clusters are also elevated
  if (r.type === 'vm' && (r.size ?? 0) >= 16) return true;
  if (r.type === 'aks') return true;
  return false;
}

// Returns the full catalogue for legend generation
export function catalogueEntries(): Array<{ type: AzureResourceType; entry: CatalogueEntry }> {
  return Object.entries(CAT).map(([t, e]) => ({ type: t as AzureResourceType, entry: e }));
}

export { CAT };
