export interface Vm {
  id: string;
  name: string;
  rg: string;
  subscription: string;
  location: string;
  sku: string;
  os: 'linux' | 'windows' | 'other';
  vCPU: number;
  ramGB: number;
  subnetId: string | null;
  privateIp: string | null;
  unknownSku: boolean;
}

export interface Subnet {
  id: string;
  name: string;
  vnetId: string;
  cidr: string;
}

export interface Vnet {
  id: string;
  name: string;
  rg: string;
  location: string;
  addressSpace: string;
}

export interface Peering {
  a: string;
  b: string;
  state: string;
}

export interface Graph {
  vms: Vm[];
  vnets: Vnet[];
  subnets: Subnet[];
  peerings: Peering[];
  vmsBySubnet: Map<string, Vm[]>;
  subnetsByVnet: Map<string, Subnet[]>;
  detection: { vm: boolean; vnet: boolean; subnet: boolean; nic: boolean; peering: boolean };
  notes: string[];
}

export interface PlacedVm extends Vm {
  pos: [number, number, number];
  height: number;
}

export interface PlacedSubnet extends Subnet {
  center: [number, number];
  size: number;          // max(width, depth) — kept for label scaling, sprite sizing
  width: number;         // X extent of the subnet ridge
  depth: number;         // Z extent of the subnet ridge
  vnetCenter: [number, number];
}

export interface PlacedVnet extends Vnet {
  center: [number, number];
  size: number;          // max(width, depth)
  width: number;
  depth: number;
  color: number;
}

export interface World {
  vms: PlacedVm[];
  subnets: PlacedSubnet[];
  vnets: PlacedVnet[];
  peerings: Peering[];
  bounds: { min: [number, number]; max: [number, number] };
  vnetById: Map<string, PlacedVnet>;
  subnetById: Map<string, PlacedSubnet>;
}
