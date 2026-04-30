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

XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(vms),      'Virtual Machines');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(vnets),    'Virtual Network');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(subnets),  'Subnets');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(nics),     'Network Interface');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(peerings), 'VNET Peerings');

mkdirSync('fixtures', { recursive: true });
const out = 'fixtures/sample-ari.xlsx';
XLSX.writeFile(wb, out);
console.log('Wrote', out);
