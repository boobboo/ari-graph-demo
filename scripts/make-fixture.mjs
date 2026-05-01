// Generate a rich synthetic ARI-style workbook for the OS cartographic mode demo.
// Run: `node scripts/make-fixture.mjs`
import * as XLSX from 'xlsx';
import { writeFileSync, mkdirSync } from 'node:fs';

const wb = XLSX.utils.book_new();

// ---- Virtual Machines ----
const vms = [
  // Production subscription — rg-frontend (environment=production, web tier)
  { Name: 'web-01', 'Resource Group': 'rg-frontend', Location: 'westeurope',  'VM Size': 'Standard_B1s',     OS: 'Linux',   Subscription: 'Production',       Tags: 'environment=production;tier=web' },
  { Name: 'web-02', 'Resource Group': 'rg-frontend', Location: 'westeurope',  'VM Size': 'Standard_B2s',     OS: 'Linux',   Subscription: 'Production',       Tags: 'environment=production;tier=web' },
  // Production subscription — rg-app (environment=production, compute tier)
  { Name: 'app-01', 'Resource Group': 'rg-app',      Location: 'westeurope',  'VM Size': 'Standard_D4s_v3',  OS: 'Linux',   Subscription: 'Production',       Tags: 'environment=production;tier=app' },
  { Name: 'app-02', 'Resource Group': 'rg-app',      Location: 'westeurope',  'VM Size': 'Standard_D8s_v3',  OS: 'Linux',   Subscription: 'Production',       Tags: 'environment=production;tier=app' },
  // Production subscription — rg-data (environment=production, data tier)
  { Name: 'db-01',  'Resource Group': 'rg-data',     Location: 'westeurope',  'VM Size': 'Standard_E16s_v3', OS: 'Linux',   Subscription: 'Production',       Tags: 'environment=production;tier=data' },
  { Name: 'db-02',  'Resource Group': 'rg-data',     Location: 'westeurope',  'VM Size': 'Standard_M64ms',   OS: 'Linux',   Subscription: 'Production',       Tags: 'environment=production;tier=data' },
  // Development subscription — rg-dev (environment=development)
  { Name: 'win-01', 'Resource Group': 'rg-dev',      Location: 'northeurope', 'VM Size': 'Standard_D2s_v3',  OS: 'Windows', Subscription: 'Development',      Tags: 'environment=development' },
  { Name: 'win-02', 'Resource Group': 'rg-dev',      Location: 'northeurope', 'VM Size': 'Standard_D4s_v3',  OS: 'Windows', Subscription: 'Development',      Tags: 'environment=development' },
  { Name: 'jump',   'Resource Group': 'rg-dev',      Location: 'northeurope', 'VM Size': 'Standard_B1ms',    OS: 'Windows', Subscription: 'Development',      Tags: 'environment=development' },
];

// ---- Virtual Networks ----
const vnets = [
  { Name: 'vnet-prod',   'Resource Group': 'rg-network', Location: 'westeurope',  'Address Space': '10.0.0.0/16', Subscription: 'Production' },
  { Name: 'vnet-shared', 'Resource Group': 'rg-network', Location: 'westeurope',  'Address Space': '10.2.0.0/16', Subscription: 'Shared Services' },
  { Name: 'vnet-corp',   'Resource Group': 'rg-network', Location: 'northeurope', 'Address Space': '10.1.0.0/16', Subscription: 'Development' },
];

// ---- Subnets ----
const subnets = [
  { 'Virtual Network': 'vnet-prod',   Subnet: 'snet-web',   'Address Range': '10.0.1.0/24' },
  { 'Virtual Network': 'vnet-prod',   Subnet: 'snet-app',   'Address Range': '10.0.2.0/24' },
  { 'Virtual Network': 'vnet-prod',   Subnet: 'snet-data',  'Address Range': '10.0.3.0/24' },
  { 'Virtual Network': 'vnet-shared', Subnet: 'snet-infra', 'Address Range': '10.2.1.0/24' },
  { 'Virtual Network': 'vnet-corp',   Subnet: 'snet-corp',  'Address Range': '10.1.1.0/24' },
];

// ---- NICs (VM → VNet/Subnet attachment) ----
const nics = [
  { Name: 'nic-web-01', 'Virtual Machine': 'web-01', 'Virtual Network': 'vnet-prod',   Subnet: 'snet-web',   'Private IP': '10.0.1.4' },
  { Name: 'nic-web-02', 'Virtual Machine': 'web-02', 'Virtual Network': 'vnet-prod',   Subnet: 'snet-web',   'Private IP': '10.0.1.5' },
  { Name: 'nic-app-01', 'Virtual Machine': 'app-01', 'Virtual Network': 'vnet-prod',   Subnet: 'snet-app',   'Private IP': '10.0.2.4' },
  { Name: 'nic-app-02', 'Virtual Machine': 'app-02', 'Virtual Network': 'vnet-prod',   Subnet: 'snet-app',   'Private IP': '10.0.2.5' },
  { Name: 'nic-db-01',  'Virtual Machine': 'db-01',  'Virtual Network': 'vnet-prod',   Subnet: 'snet-data',  'Private IP': '10.0.3.4' },
  { Name: 'nic-db-02',  'Virtual Machine': 'db-02',  'Virtual Network': 'vnet-prod',   Subnet: 'snet-data',  'Private IP': '10.0.3.5' },
  { Name: 'nic-win-01', 'Virtual Machine': 'win-01', 'Virtual Network': 'vnet-corp',   Subnet: 'snet-corp',  'Private IP': '10.1.1.4' },
  { Name: 'nic-win-02', 'Virtual Machine': 'win-02', 'Virtual Network': 'vnet-corp',   Subnet: 'snet-corp',  'Private IP': '10.1.1.5' },
  { Name: 'nic-jump',   'Virtual Machine': 'jump',   'Virtual Network': 'vnet-corp',   Subnet: 'snet-corp',  'Private IP': '10.1.1.6' },
];

// ---- VNet Peerings ----
const peerings = [
  { 'VNet 1': 'vnet-prod', 'VNet 2': 'vnet-shared', State: 'Connected' },
  { 'VNet 1': 'vnet-prod', 'VNet 2': 'vnet-corp',   State: 'Connected' },
];

// ---- Storage Accounts ----
const storage = [
  { Name: 'stfrontend',    'Resource Group': 'rg-frontend', Location: 'westeurope',  SKU: 'Standard_LRS', Kind: 'StorageV2', Subscription: 'Production',     Tags: 'environment=production' },
  { Name: 'stdatalake',    'Resource Group': 'rg-data',     Location: 'westeurope',  SKU: 'Standard_GRS', Kind: 'StorageV2', Subscription: 'Production',     Tags: 'environment=production;tier=data' },
  { Name: 'stdev',         'Resource Group': 'rg-dev',      Location: 'northeurope', SKU: 'Standard_LRS', Kind: 'BlobStorage', Subscription: 'Development',  Tags: 'environment=development' },
];

// ---- Key Vaults ----
const keyVaults = [
  { Name: 'kv-prod-main',  'Resource Group': 'rg-infra',    Location: 'westeurope',  SKU: 'premium', Subscription: 'Shared Services', Tags: 'environment=production' },
  { Name: 'kv-prod-data',  'Resource Group': 'rg-data',     Location: 'westeurope',  SKU: 'standard', Subscription: 'Production',     Tags: 'environment=production;tier=data' },
];

// ---- SQL Databases ----
const sqlDbs = [
  { Name: 'sql-app-db',   'Resource Group': 'rg-app',  Location: 'westeurope', Server: 'sql-prod-server', Tier: 'Standard S2', Subscription: 'Production',    Tags: 'environment=production;tier=app' },
  { Name: 'sql-dw',       'Resource Group': 'rg-data', Location: 'westeurope', Server: 'sql-prod-server', Tier: 'Premium P1',  Subscription: 'Production',    Tags: 'environment=production;tier=data' },
];

// ---- App Services ----
const appServices = [
  { Name: 'app-frontend',  'Resource Group': 'rg-frontend', Location: 'westeurope',  SKU: 'B2',  Kind: 'app',          Subscription: 'Production',     Tags: 'environment=production' },
  { Name: 'app-api',       'Resource Group': 'rg-app',      Location: 'westeurope',  SKU: 'P2v3',Kind: 'app',          Subscription: 'Production',     Tags: 'environment=production;tier=app' },
];

// ---- Function Apps ----
const functionApps = [
  { Name: 'func-events',   'Resource Group': 'rg-app',      Location: 'westeurope',  SKU: 'Y1',   Subscription: 'Production',     Tags: 'environment=production;tier=app' },
  { Name: 'func-dev',      'Resource Group': 'rg-dev',      Location: 'northeurope', SKU: 'Y1',   Subscription: 'Development',    Tags: 'environment=development' },
];

// ---- AKS Clusters ----
const aksClusters = [
  { Name: 'aks-prod',      'Resource Group': 'rg-app', Location: 'westeurope', 'VM Size': 'Standard_D4s_v3', 'Node Count': 4, 'Kubernetes Version': '1.29', Subscription: 'Production', Tags: 'environment=production;tier=app' },
];

// ---- Application Gateways ----
const appGateways = [
  { Name: 'agw-prod',      'Resource Group': 'rg-infra', Location: 'westeurope', SKU: 'WAF_v2', Tier: 'WAF_v2', Subscription: 'Shared Services', Tags: 'environment=production' },
];

// ---- Event Hubs ----
const eventHubs = [
  { Name: 'evh-prod-ingest',  'Resource Group': 'rg-app',  Location: 'westeurope',  SKU: 'Standard', Subscription: 'Production',    Tags: 'environment=production;tier=app' },
  { Name: 'evh-prod-telemetry','Resource Group': 'rg-data', Location: 'westeurope',  SKU: 'Standard', Subscription: 'Production',    Tags: 'environment=production;tier=data' },
  { Name: 'evh-dev',          'Resource Group': 'rg-dev',  Location: 'northeurope', SKU: 'Basic',    Subscription: 'Development',   Tags: 'environment=development' },
];

// ---- Service Bus ----
const serviceBus = [
  { Name: 'sb-prod-orders',  'Resource Group': 'rg-app',  Location: 'westeurope',  SKU: 'Standard', Subscription: 'Production',    Tags: 'environment=production;tier=app' },
  { Name: 'sb-prod-notify',  'Resource Group': 'rg-app',  Location: 'westeurope',  SKU: 'Premium',  Subscription: 'Production',    Tags: 'environment=production;tier=app' },
];

// ---- Log Analytics Workspaces ----
const logAnalytics = [
  { Name: 'log-shared-central', 'Resource Group': 'rg-infra', Location: 'westeurope', SKU: 'PerGB2018', Subscription: 'Shared Services', Tags: 'environment=production' },
  { Name: 'log-dev',            'Resource Group': 'rg-dev',   Location: 'northeurope', SKU: 'Free',      Subscription: 'Development',      Tags: 'environment=development' },
];

// ---- Public IP Addresses ----
const publicIps = [
  { Name: 'pip-agw-prod',   'Resource Group': 'rg-infra',    Location: 'westeurope',  SKU: 'Standard', 'IP Address': '51.105.22.10',  Subscription: 'Shared Services', Tags: 'environment=production' },
  { Name: 'pip-vpngw-prod', 'Resource Group': 'rg-network',  Location: 'westeurope',  SKU: 'Standard', 'IP Address': '51.105.22.11',  Subscription: 'Production',      Tags: 'environment=production' },
  { Name: 'pip-bastion',    'Resource Group': 'rg-infra',    Location: 'westeurope',  SKU: 'Standard', 'IP Address': '51.105.22.12',  Subscription: 'Shared Services', Tags: 'environment=production' },
];

// ---- ExpressRoute Circuits ----
const expressRoutes = [
  { Name: 'er-corp-london',  'Resource Group': 'rg-network', Location: 'westeurope', SKU: 'Standard', 'Bandwidth (Mbps)': '1000', Provider: 'BT', Subscription: 'Production', Tags: 'environment=production' },
];

// ---- VPN Gateways ----
const vpnGateways = [
  { Name: 'vpngw-prod',  'Resource Group': 'rg-network', Location: 'westeurope',  SKU: 'VpnGw2', 'VPN Type': 'RouteBased', Subscription: 'Production',    Tags: 'environment=production' },
  { Name: 'vpngw-dev',   'Resource Group': 'rg-network', Location: 'northeurope', SKU: 'Basic',  'VPN Type': 'RouteBased', Subscription: 'Development',   Tags: 'environment=development' },
];

// ---- RBAC Role Assignments ----
const roleAssignments = [
  // Subscription-scoped assignments
  { 'Principal Name': 'ops-team',       'Principal Type': 'Group',            'Role Definition Name': 'Contributor', Subscription: 'Production',      'Resource Group': '' },
  { 'Principal Name': 'devops-sp',      'Principal Type': 'ServicePrincipal', 'Role Definition Name': 'Owner',       Subscription: 'Production',      'Resource Group': '' },
  { 'Principal Name': 'audit-reader',   'Principal Type': 'User',             'Role Definition Name': 'Reader',      Subscription: 'Shared Services', 'Resource Group': '' },
  { 'Principal Name': 'dev-team',       'Principal Type': 'Group',            'Role Definition Name': 'Contributor', Subscription: 'Development',     'Resource Group': '' },
  { 'Principal Name': 'sec-auditor',    'Principal Type': 'User',             'Role Definition Name': 'Reader',      Subscription: 'Production',      'Resource Group': '' },
  // RG-scoped assignments
  { 'Principal Name': 'data-engineers', 'Principal Type': 'Group',            'Role Definition Name': 'Owner',       Subscription: 'Production',      'Resource Group': 'rg-data' },
  { 'Principal Name': 'frontend-devs',  'Principal Type': 'Group',            'Role Definition Name': 'Contributor', Subscription: 'Production',      'Resource Group': 'rg-frontend' },
  { 'Principal Name': 'readonly-bot',   'Principal Type': 'ServicePrincipal', 'Role Definition Name': 'Reader',      Subscription: 'Production',      'Resource Group': 'rg-app' },
  { 'Principal Name': 'junior-devs',    'Principal Type': 'Group',            'Role Definition Name': 'Reader',      Subscription: 'Development',     'Resource Group': 'rg-dev' },
];

// ---- Assemble workbook ----
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(vms),            'Virtual Machines');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(vnets),          'Virtual Network');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(subnets),        'Subnets');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(nics),           'Network Interface');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(peerings),       'VNET Peerings');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(storage),        'Storage Accounts');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(keyVaults),      'Key Vaults');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sqlDbs),         'SQL Databases');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(appServices),    'App Services');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(functionApps),   'Function Apps');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(aksClusters),    'AKS');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(appGateways),    'Application Gateways');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(eventHubs),      'Event Hubs');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(serviceBus),     'Service Bus');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(logAnalytics),   'Log Analytics');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(publicIps),      'Public IP Addresses');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(expressRoutes),  'ExpressRoute Circuits');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(vpnGateways),    'Virtual Network Gateways');
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(roleAssignments),'Role Assignments');

mkdirSync('fixtures', { recursive: true });
const out = 'fixtures/sample-ari.xlsx';
XLSX.writeFile(wb, out);
console.log(`Wrote ${out}`);
console.log(`  ${vms.length} VMs, ${storage.length} Storage, ${keyVaults.length} KVs, ` +
            `${sqlDbs.length} SQL, ${appServices.length} AppSvc, ${functionApps.length} Func, ` +
            `${aksClusters.length} AKS, ${appGateways.length} AGW`);
console.log(`  ${eventHubs.length} EventHubs, ${serviceBus.length} ServiceBus, ` +
            `${logAnalytics.length} Monitor, ${publicIps.length} PIPs, ` +
            `${expressRoutes.length} ER, ${vpnGateways.length} VPNGw, ` +
            `${roleAssignments.length} RBAC assignments`);
console.log(`  Subscriptions: Production, Shared Services, Development`);
console.log(`  RGs: rg-frontend, rg-app, rg-data, rg-infra, rg-network, rg-dev`);
