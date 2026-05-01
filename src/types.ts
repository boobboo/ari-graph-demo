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
  // Hierarchy (derived in parser from resource location/subscription/RG)
  regions: Region[];
  subscriptions: Subscription[];
  resourceGroups: ResourceGroup[];

  // Resources
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

// ---- Estate hierarchy (PRD §5.1) ---------------------------------------
// Region (Azure region) -> Subscription -> ResourceGroup -> Resource.
// Replaces VNet-as-container with RG-as-district. VNets/Subnets become
// derived network overlays in the World layer.

export interface Region {
  id: string;             // normalised location name
  name: string;           // display name (original casing)
  subIds: string[];       // subscriptions present in this region
}

export interface Subscription {
  id: string;             // normalised name
  name: string;
  rgIds: string[];        // RGs present in this subscription
}

export interface ResourceGroup {
  id: string;             // norm("<sub>::<rg>")
  name: string;           // RG display name
  subscriptionId: string;
  regionId: string;       // a single primary region; resources in other
                          // regions of the same RG are still placed here
                          // but tinted as out-of-region for v2.
  /** Canonical resource types present (vm, storage, nsg, ...). */
  resourceTypes: string[];
  /** R/C/I bias (computed at parse time). */
  rciR: number; rciC: number; rciI: number;
  rciPrimary: 'R' | 'C' | 'I' | 'Mixed';
}

// ---- Placed types ------------------------------------------------------
// Resources are now placed inside their RG. Subnets/VNets are derived from
// resource positions (computed in layout.ts after Pass 4).

export interface PlacedRegion extends Region {
  center: [number, number];
  width: number;
  depth: number;
}

export interface PlacedSubscription extends Subscription {
  center: [number, number];
  width: number;
  depth: number;
  regionId: string;
}

export interface PlacedResourceGroup extends ResourceGroup {
  center: [number, number];
  width: number;
  depth: number;
}

export interface PlacedVm extends Vm {
  pos: [number, number, number];
  height: number;            // legacy composite (kept for backwards-compat)
  rgId: string;              // which RG this VM physically belongs to
  zone: string;              // RCI class from catalogue
  building: string;          // building archetype from catalogue
  storeys: number;           // catalogue-derived storey count
  footprint: number;         // catalogue-derived tile footprint
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
  pos: [number, number];     // ground-plane position inside its RG district
  storeys: number;
  rgId: string;
  zone: string;
  building: string;
  footprint: number;
}

export interface World {
  // Hierarchy (PRD §5.1)
  regions: PlacedRegion[];
  subscriptions: PlacedSubscription[];
  resourceGroups: PlacedResourceGroup[];

  // Buildings — placed inside their RG by the catalogue.
  vms: PlacedVm[];
  storage: PlacedStorage[];
  nsgs: PlacedNsg[];
  publicIps: PlacedPublicIp[];

  // Network overlay — derived in layout, drawn as roads/markers in world.
  subnets: PlacedSubnet[];
  vnets: PlacedVnet[];
  peerings: Peering[];
  nics: PlacedNic[];

  bounds: { min: [number, number]; max: [number, number] };
  vnetById: Map<string, PlacedVnet>;
  subnetById: Map<string, PlacedSubnet>;
  rgById: Map<string, PlacedResourceGroup>;
}
