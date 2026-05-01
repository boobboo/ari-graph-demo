// Generate a small synthetic ARI-style workbook so the topology renderer
// can be exercised without a real Azure inventory. Run: `node scripts/make-fixture.mjs`.
import * as XLSX from 'xlsx';
import { writeFileSync, mkdirSync } from 'node:fs';

const wb = XLSX.utils.book_new();

const vms = [
  { Name: 'web-01', 'Resource Group': 'rg-frontend', Location: 'westeurope', 'VM Size': 'Standard_B1s',     OS: 'Linux',   Subscription: 'demo-sub' },
  { Name: 'web-02', 'Resource Group': 'rg-frontend', Location: 'westeurope', 'VM Size': 'Standard_B2s',     OS: 'Linux',   Subscription: 'demo-sub' },
  { Name: 'app-01', 'Resource Group': 'rg-app',      Location: 'westeurope', 'VM Size': 'Standard_D4s_v3',  OS: 'Linux',   Subscription: 'demo-sub' },
  { Name: 'app-02', 'Resource Group': 'rg-app',      Location: 'westeurope', 'VM Size': 'Standard_D8s_v3',  OS: 'Linux',   Subscription: 'demo-sub' },
  { Name: 'db-01',  'Resource Group': 'rg-data',     Location: 'westeurope', 'VM Size': 'Standard_E16s_v3', OS: 'Linux',   Subscription: 'demo-sub' },
  { Name: 'db-02',  'Resource Group': 'rg-data',     Location: 'westeurope', 'VM Size': 'Standard_M64ms',   OS: 'Linux',   Subscription: 'demo-sub' },
  { Name: 'win-01', 'Resource Group': 'rg-corp',     Location: 'northeurope','VM Size': 'Standard_D2s_v3',  OS: 'Windows', Subscription: 'demo-sub' },
  { Name: 'win-02', 'Resource Group': 'rg-corp',     Location: 'northeurope','VM Size': 'Standard_D4s_v3',  OS: 'Windows', Subscription: 'demo-sub' },
  { Name: 'jump',   'Resource Group': 'rg-corp',     Location: 'northeurope','VM Size': 'Standard_B1ms',    OS: 'Windows', Subscription: 'demo-sub' },
];

const vnets = [
  { Name: 'vnet-prod', 'Resource Group': 'rg-network', Location: 'westeurope',  'Address Space': '10.0.0.0/16' },
  { Name: 'vnet-corp', 'Resource Group': 'rg-network', Location: 'northeurope', 'Address Space': '10.1.0.0/16' },
];

const subnets = [
  { 'Virtual Network': 'vnet-prod', Subnet: 'snet-web', 'Address Range': '10.0.1.0/24' },
  { 'Virtual Network': 'vnet-prod', Subnet: 'snet-app', 'Address Range': '10.0.2.0/24' },
  { 'Virtual Network': 'vnet-prod', Subnet: 'snet-data','Address Range': '10.0.3.0/24' },
  { 'Virtual Network': 'vnet-corp', Subnet: 'snet-corp','Address Range': '10.1.1.0/24' },
];

const nics = [
  { Name: 'nic-web-01', 'Virtual Machine': 'web-01', 'Virtual Network': 'vnet-prod', Subnet: 'snet-web',  'Private IP': '10.0.1.4' },
  { Name: 'nic-web-02', 'Virtual Machine': 'web-02', 'Virtual Network': 'vnet-prod', Subnet: 'snet-web',  'Private IP': '10.0.1.5' },
  { Name: 'nic-app-01', 'Virtual Machine': 'app-01', 'Virtual Network': 'vnet-prod', Subnet: 'snet-app',  'Private IP': '10.0.2.4' },
  { Name: 'nic-app-02', 'Virtual Machine': 'app-02', 'Virtual Network': 'vnet-prod', Subnet: 'snet-app',  'Private IP': '10.0.2.5' },
  { Name: 'nic-db-01',  'Virtual Machine': 'db-01',  'Virtual Network': 'vnet-prod', Subnet: 'snet-data', 'Private IP': '10.0.3.4' },
  { Name: 'nic-db-02',  'Virtual Machine': 'db-02',  'Virtual Network': 'vnet-prod', Subnet: 'snet-data', 'Private IP': '10.0.3.5' },
  { Name: 'nic-win-01', 'Virtual Machine': 'win-01', 'Virtual Network': 'vnet-corp', Subnet: 'snet-corp', 'Private IP': '10.1.1.4' },
  { Name: 'nic-win-02', 'Virtual Machine': 'win-02', 'Virtual Network': 'vnet-corp', Subnet: 'snet-corp', 'Private IP': '10.1.1.5' },
  { Name: 'nic-jump',   'Virtual Machine': 'jump',   'Virtual Network': 'vnet-corp', Subnet: 'snet-corp', 'Private IP': '10.1.1.6' },
];

const peerings = [
  { 'VNet 1': 'vnet-prod', 'VNet 2': 'vnet-corp', State: 'Connected' },
];

// Network Security Groups: subnet-attached gates protecting the web/data tiers,
// plus one NIC-attached NSG on the corp jump host.
const nsgs = [
  { Name: 'nsg-web',   'Resource Group': 'rg-network', Location: 'westeurope',  'Virtual Network': 'vnet-prod', Subnet: 'snet-web',  'Network Interface': '' },
  { Name: 'nsg-app',   'Resource Group': 'rg-network', Location: 'westeurope',  'Virtual Network': 'vnet-prod', Subnet: 'snet-app',  'Network Interface': '' },
  { Name: 'nsg-data',  'Resource Group': 'rg-network', Location: 'westeurope',  'Virtual Network': 'vnet-prod', Subnet: 'snet-data', 'Network Interface': '' },
  { Name: 'nsg-jump',  'Resource Group': 'rg-network', Location: 'northeurope', 'Virtual Network': '',          Subnet: '',          'Network Interface': 'nic-jump' },
];

// Public IPs: one per web frontend, plus one on the jump host for inbound RDP.
const publicIps = [
  { Name: 'pip-web-01', 'Resource Group': 'rg-frontend', Location: 'westeurope',  'IP Address': '20.50.10.10', SKU: 'Standard', 'Network Interface': 'nic-web-01' },
  { Name: 'pip-web-02', 'Resource Group': 'rg-frontend', Location: 'westeurope',  'IP Address': '20.50.10.11', SKU: 'Standard', 'Network Interface': 'nic-web-02' },
  { Name: 'pip-jump',   'Resource Group': 'rg-corp',     Location: 'northeurope', 'IP Address': '20.50.20.5',  SKU: 'Basic',    'Network Interface': 'nic-jump'   },
];

// Storage Accounts spread across the four RGs, mixing tiers and SKUs.
const storage = [
  { Name: 'stwebassets01', 'Resource Group': 'rg-frontend', Location: 'westeurope',  Kind: 'StorageV2',   SKU: 'Standard_LRS', 'Access Tier': 'Hot'  },
  { Name: 'stappstate01',  'Resource Group': 'rg-app',      Location: 'westeurope',  Kind: 'StorageV2',   SKU: 'Standard_ZRS', 'Access Tier': 'Hot'  },
  { Name: 'stdbbackup01',  'Resource Group': 'rg-data',     Location: 'westeurope',  Kind: 'BlobStorage', SKU: 'Standard_GRS', 'Access Tier': 'Cool' },
  { Name: 'stdbarchive01', 'Resource Group': 'rg-data',     Location: 'westeurope',  Kind: 'BlobStorage', SKU: 'Standard_LRS', 'Access Tier': 'Archive' },
  { Name: 'stcorpfiles01', 'Resource Group': 'rg-corp',     Location: 'northeurope', Kind: 'FileStorage', SKU: 'Premium_LRS',  'Access Tier': 'Hot'  },
];

XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(vms),       'Virtual Machines');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(vnets),     'Virtual Network');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(subnets),   'Subnets');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(nics),      'Network Interface');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(peerings),  'VNET Peerings');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(nsgs),      'Network Security Groups');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(publicIps), 'Public IPs');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(storage),   'Storage Accounts');

mkdirSync('fixtures', { recursive: true });
const out = 'fixtures/sample-ari.xlsx';
XLSX.writeFile(wb, out);
console.log('Wrote', out);
