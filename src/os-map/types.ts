import type { AzureResourceType, ScalarMode, ScaleTier } from '../estate-model';
export type { AzureResourceType, ScalarMode, ScaleTier };

export type LandUse = 'forest' | 'arable' | 'moorland' | 'water' | 'builtup' | 'marsh';

export type SymbolShape =
  | 'square' | 'squares' | 'circle' | 'diamond' | 'trig'
  | 'reservoir' | 'castle' | 'quarry' | 'spire' | 'building'
  | 'junction' | 'market' | 'builtup-area' | 'silo' | 'post'
  | 'tollbooth' | 'lighthouse' | 'bridge' | 'police' | 'hospital'
  | 'fort' | 'observatory';

export interface ResourceSymbol {
  shape: SymbolShape;
  size: number;
  fill: string;
  stroke: string;
  label: string;
  abbrev: string;         // short abbreviation (KV, LA, AGW…)
  description: string;    // OS tooltip text
  category: string;       // settlement | water | tourist | general | relief | antiquity
}

export interface MapCounty {
  id: string;             // subscription name
  name: string;
  polygon: Array<[number, number]>;
  centroid: [number, number];
  totalCost: number;
}

export interface MapParish {
  id: string;             // "subscription||rg"
  name: string;
  subscriptionId: string;
  polygon: Array<[number, number]>;
  centroid: [number, number];
  landUse: LandUse;
  environment: string;    // from tags
}

export interface MapResource {
  id: string;
  name: string;
  type: AzureResourceType;
  parishId: string | null;
  countyId: string | null;
  pos: [number, number];
  elevation: number;      // current scalar value
  scalars: Record<ScalarMode, number>;
  symbol: ResourceSymbol;
  tooltip: string;
  gridRef: string;        // OSGB-style grid reference
  isTrigPoint: boolean;
  subnetId: string | null; // for field-boundary hull grouping
}

export interface VnetHull {
  vnetId: string;
  name: string;
  hull: Array<[number, number]>;
  centroid: [number, number];
  color: string;
}

// §5.3 Subnet as field boundary
export interface SubnetHull {
  subnetId: string;
  name: string;
  vnetId: string;
  hull: Array<[number, number]>;
}

// §5.6 Hydrography (Pass 5) — data-flow rivers
export interface HydroFeature {
  id: string;
  points: Array<[number, number]>;
  width: number;
  widthType: 'spring' | 'stream' | 'river' | 'estuary';
}

// §5.6 Rights-of-way — RBAC access layer
export type RbacRole = 'reader' | 'contributor' | 'owner';
export interface RbacPath {
  id: string;
  polygon: Array<[number, number]>;
  role: RbacRole;
  scope: 'subscription' | 'rg';
}

export interface LinearFeature {
  id: string;
  type: 'peering' | 'river' | 'expressroute' | 'vpn';
  points: Array<[number, number]>;
  color: string;
  width: number;
  dash: string;
  label?: string;
}

export interface ElevationField {
  gridW: number;
  gridH: number;
  values: Float32Array;
  min: number;
  max: number;
}

export interface ContourFeature {
  value: number;
  isIndex: boolean;
  type: 'MultiPolygon';
  coordinates: Array<Array<Array<[number, number]>>>;
}

export interface CartoucheData {
  title: string;
  subtitle: string;
  date: string;
  scaleLabel: string;
  estateStats: string;
  sheetRef: string;       // e.g. "Sheet 1 of 1"
}

export interface MapScene {
  mapW: number;
  mapH: number;
  counties: MapCounty[];
  parishes: MapParish[];
  resources: MapResource[];
  vnetHulls: VnetHull[];
  subnetHulls: SubnetHull[];
  linear: LinearFeature[];
  hydro: HydroFeature[];
  rbacPaths: RbacPath[];
  elevation: ElevationField;
  contours: ContourFeature[];
  cartouche: CartoucheData;
  scalarMode: ScalarMode;
  scaleTier: ScaleTier;
}
