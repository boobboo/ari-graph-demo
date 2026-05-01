import type { Vnet, Subnet, Peering } from './types';

export type AzureResourceType =
  | 'vm' | 'vmss' | 'storage' | 'keyvault' | 'sql' | 'cosmos'
  | 'appservice' | 'functionapp' | 'logicapp' | 'apim'
  | 'aks' | 'acr' | 'servicebus' | 'eventhub' | 'eventgrid'
  | 'appgateway' | 'frontdoor' | 'publicip' | 'privateendpoint'
  | 'bastion' | 'vpngateway' | 'expressroute'
  | 'monitor' | 'defender' | 'recovery' | 'ai'
  | 'unknown';

export interface EstateResource {
  id: string;
  name: string;
  type: AzureResourceType;
  rg: string;
  subscription: string;
  location: string;
  tags: Record<string, string>;
  // §5.5 Numeric carriers
  costMonthlyGbp: number;
  criticalityScore: number;   // 0–10
  ageDays: number;
  changeFreq30d: number;      // deployments per 30d
  blastRadiusScore: number;   // 0–10
  // Type-specific
  sku: string;
  size: number;               // vCPU (VM), node count (AKS), SKU tier (DB)
  subtype: string;            // os type, app kind, etc.
  vnetId: string | null;      // network attachment (for VNet hull rendering)
  subnetId: string | null;    // subnet attachment (for field-boundary rendering)
}

// §5.6 RBAC rights-of-way layer
export interface RbacAssignment {
  principalName: string;
  principalType: string;       // User | Group | ServicePrincipal
  roleName: string;            // Owner | Contributor | Reader | …
  subscriptionName: string;    // human-readable subscription name
  rgName: string | null;       // null = subscription-scoped
}

export type ScalarMode = 'cost' | 'criticality' | 'age' | 'blast' | 'change';

export type ScaleTier = 'road' | 'landranger' | 'explorer';

export interface EstateModel {
  resources: EstateResource[];
  subscriptions: string[];              // unique subscription names, ordered by total cost desc
  resourcesByRg: Map<string, EstateResource[]>;
  rgsBySubscription: Map<string, string[]>;
  // Network topology (preserved from Graph for linear feature rendering)
  vnets: Vnet[];
  subnets: Subnet[];
  peerings: Peering[];
  vnetById: Map<string, Vnet>;
  resourcesByVnet: Map<string, EstateResource[]>;
  // §5.6 RBAC rights-of-way
  rbacAssignments: RbacAssignment[];
  notes: string[];
}

export function scalarValue(r: EstateResource, mode: ScalarMode): number {
  switch (mode) {
    case 'cost':        return r.costMonthlyGbp;
    case 'criticality': return r.criticalityScore;
    case 'age':         return r.ageDays / 30;   // normalise to months
    case 'blast':       return r.blastRadiusScore;
    case 'change':      return r.changeFreq30d;
  }
}

export const SCALAR_LABELS: Record<ScalarMode, string> = {
  cost:        'Monthly cost (£)',
  criticality: 'Criticality score',
  age:         'Age (months)',
  blast:       'Blast radius',
  change:      'Change frequency (30d)',
};
