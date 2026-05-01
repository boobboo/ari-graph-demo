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
  nicName: string | null;     // free-text NIC name (resolves PublicIP/NSG attachments back to a VM)
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

export interface Nsg {
  id: string;
  name: string;
  rg: string;
  location: string;
  subnetId: string | null;    // subnet-attached NSG: "<vnet>::<subnet>"
  nicName: string | null;     // NIC-attached NSG: free-text NIC name
}

export interface PublicIp {
  id: string;
  name: string;
  rg: string;
  location: string;
  ipAddress: string;
  sku: string;                // Basic / Standard
  attachedNic: string | null; // free-text NIC name (other attachment kinds = future)
}

export type StorageTier = 'hot' | 'cool' | 'archive' | 'unknown';

export interface StorageAccount {
  id: string;
  name: string;
  rg: string;
  location: string;
  kind: string;               // StorageV2 / BlobStorage / FileStorage / etc
  sku: string;                // Standard_LRS / Premium_ZRS / etc
  tier: StorageTier;
}

export interface Graph {
  vms: Vm[];
  vnets: Vnet[];
  subnets: Subnet[];
  peerings: Peering[];
  nsgs: Nsg[];
  publicIps: PublicIp[];
  storage: StorageAccount[];
  vmsBySubnet: Map<string, Vm[]>;
  subnetsByVnet: Map<string, Subnet[]>;
  detection: {
    vm: boolean; vnet: boolean; subnet: boolean; nic: boolean; peering: boolean;
    nsg: boolean; publicIp: boolean; storage: boolean;
  };
  notes: string[];
}

export interface PlacedVm extends Vm {
  pos: [number, number, number];
  height: number;
}

export interface PlacedSubnet extends Subnet {
  center: [number, number];
  size: number;
  vnetCenter: [number, number];
}

export interface PlacedVnet extends Vnet {
  center: [number, number];
  size: number;
  color: number;
}

// A NIC's "shopfront" position: derived in layout.ts from a VM and the subnet
// road direction. One per NIC; a multi-NIC VM gets multiple of these.
export interface PlacedNic {
  vmId: string;
  subnetId: string | null;
  privateIp: string;
  pos: [number, number];     // ground-plane position of the shopfront
  facing: [number, number];  // unit vector pointing AWAY from the tower (toward the road)
}

export interface PlacedNsg extends Nsg {
  pos: [number, number];     // ground-plane position
  facing: [number, number];  // direction the barrier arm sweeps across (perpendicular to the road)
  // What this NSG is attached to in placed-world coordinates.
  attachedSubnetId: string | null;
  attachedVmId: string | null;
}

export interface PlacedPublicIp extends PublicIp {
  pos: [number, number];     // ground-plane position (next to its NIC shopfront, or at services strip)
  attachedVmId: string | null;
}

export interface PlacedStorage extends StorageAccount {
  pos: [number, number];     // ground-plane position in the services strip
  storeys: number;           // how many floors of car park to draw
}

export interface World {
  vms: PlacedVm[];
  subnets: PlacedSubnet[];
  vnets: PlacedVnet[];
  peerings: Peering[];
  nics: PlacedNic[];
  nsgs: PlacedNsg[];
  publicIps: PlacedPublicIp[];
  storage: PlacedStorage[];
  bounds: { min: [number, number]; max: [number, number] };
  vnetById: Map<string, PlacedVnet>;
  subnetById: Map<string, PlacedSubnet>;
}
