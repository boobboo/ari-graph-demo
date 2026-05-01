import * as THREE from 'three';
import { setupUpload } from './upload';
import { parseAri } from './parser';
import { buildWorld } from './layout';
import { buildScene, type BuiltScene } from './world';
import { createFlyControls, type FlyControls } from './controls';
import {
  showStats, setLog, clearLog, showLanding,
  setLockPrompt, setCrosshair, setTooltip, escapeHtml,
} from './ui';
import { mountOsMap, exportSvg, exportPng } from './os-map/index';
import type { Graph } from './types';
import type { EstateModel, ScalarMode, ScaleTier } from './estate-model';

interface Session {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  built: BuiltScene;
  fly: FlyControls;
  rafId: number;
  raycaster: THREE.Raycaster;
  onResize: () => void;
}

type ViewMode = 'terrain' | 'osmap';

let session: Session | null = null;
let currentGraph: Graph | null = null;
let currentEstate: EstateModel | null = null;
let viewMode: ViewMode = 'terrain';
let currentSvg: SVGSVGElement | null = null;

let scalarMode: ScalarMode = 'cost';
let scaleTier: ScaleTier = 'landranger';
let a3Active = false;

// ---- DOM refs ----
const canvasRoot   = document.getElementById('canvas-root')!;
const osMapRoot    = document.getElementById('os-map-root')!;
const modeBar      = document.getElementById('mode-bar')!;
const btnTerrain   = document.getElementById('btn-terrain')!;
const btnOsMap     = document.getElementById('btn-osmap')!;
const drop         = document.getElementById('drop') as HTMLElement;
const input        = document.getElementById('file') as HTMLInputElement;
const pick         = document.getElementById('pick') as HTMLButtonElement;
const reset        = document.getElementById('reset') as HTMLButtonElement;
const osControls   = document.getElementById('os-controls')!;
const scalarSel    = document.getElementById('scalar-mode') as HTMLSelectElement;
const btnRoad      = document.getElementById('btn-road')!;
const btnLand      = document.getElementById('btn-land')!;
const btnExplorer  = document.getElementById('btn-explorer')!;
const btnExport    = document.getElementById('btn-export')!;
const btnPng       = document.getElementById('btn-png')!;
const btnA3        = document.getElementById('btn-a3')!;

// ---- OS Map controls ----

function refreshOsMap(): void {
  if (viewMode !== 'osmap' || !currentEstate) return;
  osMapRoot.innerHTML = '';
  const fixedSize = a3Active ? { w: 1587, h: 1122 } : undefined;
  currentSvg = mountOsMap(currentEstate, osMapRoot, scalarMode, scaleTier, fixedSize);
}

function setScaleTier(tier: ScaleTier): void {
  scaleTier = tier;
  btnRoad.classList.toggle('active', tier === 'road');
  btnLand.classList.toggle('active', tier === 'landranger');
  btnExplorer.classList.toggle('active', tier === 'explorer');
  refreshOsMap();
}

scalarSel.addEventListener('change', () => {
  scalarMode = scalarSel.value as ScalarMode;
  refreshOsMap();
});
btnRoad.addEventListener('click',     () => setScaleTier('road'));
btnLand.addEventListener('click',     () => setScaleTier('landranger'));
btnExplorer.addEventListener('click', () => setScaleTier('explorer'));
btnExport.addEventListener('click', () => {
  if (currentSvg) exportSvg(currentSvg);
});
btnPng.addEventListener('click', () => {
  if (currentSvg) exportPng(currentSvg);
});
btnA3.addEventListener('click', () => {
  a3Active = !a3Active;
  btnA3.classList.toggle('active', a3Active);
  refreshOsMap();
});

// ---- Mode switching ----

function setViewMode(mode: ViewMode): void {
  viewMode = mode;
  if (mode === 'terrain') {
    canvasRoot.style.display = 'block';
    osMapRoot.style.display  = 'none';
    osControls.style.display = 'none';
    btnTerrain.classList.add('active');
    btnOsMap.classList.remove('active');
    if (session) setLockPrompt(true);
  } else {
    canvasRoot.style.display = 'none';
    osMapRoot.style.display  = 'flex';
    osControls.style.display = 'flex';
    btnTerrain.classList.remove('active');
    btnOsMap.classList.add('active');
    setLockPrompt(false);
    setCrosshair(false);
    setTooltip(null);
    refreshOsMap();
  }
}

btnTerrain.addEventListener('click', () => setViewMode('terrain'));
btnOsMap.addEventListener('click',   () => setViewMode('osmap'));

// ---- Three.js session ----

function teardown(): void {
  if (!session) return;
  cancelAnimationFrame(session.rafId);
  window.removeEventListener('resize', session.onResize);
  session.fly.dispose();
  session.built.dispose();
  session.renderer.dispose();
  session.renderer.domElement.remove();
  session = null;
}

async function loadFile(buf: ArrayBuffer, name: string): Promise<void> {
  clearLog();
  setLog(`Reading ${name}…`);
  let graph: Graph;
  let estate: EstateModel;
  try {
    ({ graph, estate } = parseAri(buf, setLog));
  } catch (err) {
    setLog(`Parse failed: ${(err as Error).message}`);
    return;
  }
  if (graph.vms.length === 0 && estate.resources.length === 0) {
    setLog('No resources detected. Is this a valid ARI workbook?');
    return;
  }

  currentGraph  = graph;
  currentEstate = estate;
  currentSvg    = null;

  const world = buildWorld(graph, estate);
  setLog(`Building world… (${world.vms.length} towers)`);

  teardown();
  osMapRoot.innerHTML = '';

  // Build 3D terrain
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  canvasRoot.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
  const built  = buildScene(world);
  camera.position.copy(built.spawn.pos);
  camera.lookAt(built.spawn.lookAt);

  const fly = createFlyControls(camera, renderer.domElement);

  fly.controls.addEventListener('lock', () => {
    setLockPrompt(false);
    setCrosshair(true);
  });
  fly.controls.addEventListener('unlock', () => {
    setLockPrompt(true);
    setCrosshair(false);
    setTooltip(null);
  });

  showStats(graph, world);
  showLanding(false);
  setLockPrompt(true);
  modeBar.style.display = 'flex';

  // Reset to terrain view on new file load
  setViewMode('terrain');

  const raycaster = new THREE.Raycaster();
  const screenCenter = new THREE.Vector2(0, 0);

  let last = performance.now();
  const tick = (): void => {
    const now = performance.now();
    const dt  = Math.min(0.05, (now - last) / 1000);
    last = now;
    fly.update(dt);

    if (fly.isLocked()) {
      raycaster.setFromCamera(screenCenter, camera);
      const hits = raycaster.intersectObjects(built.vmTowers, false);
      if (hits.length > 0 && typeof hits[0].instanceId === 'number') {
        const inst = hits[0].object as THREE.InstancedMesh;
        const list = built.vmInstanceMap.get(inst);
        if (list) {
          const vm = list[hits[0].instanceId];
          if (vm) setTooltip(formatVm(vm));
        }
      } else {
        setTooltip(null);
      }
    }

    renderer.render(built.scene, camera);
    session!.rafId = requestAnimationFrame(tick);
  };

  const onResize = (): void => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  session = { renderer, camera, built, fly, rafId: 0, raycaster, onResize };
  session.rafId = requestAnimationFrame(tick);
}

function formatVm(vm: {
  name: string; sku: string; vCPU: number; ramGB: number; os: string;
  rg: string; subscription: string; location: string; privateIp: string | null; subnetId: string | null;
}): string {
  const rows: string[] = [];
  rows.push(`<b>${escapeHtml(vm.name)}</b>`);
  rows.push(`${escapeHtml(vm.sku || '?')} · ${vm.vCPU} vCPU · ${formatRam(vm.ramGB)} GB`);
  rows.push(`OS: ${escapeHtml(vm.os)}`);
  if (vm.rg)           rows.push(`RG: ${escapeHtml(vm.rg)}`);
  if (vm.location)     rows.push(`Region: ${escapeHtml(vm.location)}`);
  if (vm.subscription) rows.push(`Sub: ${escapeHtml(vm.subscription)}`);
  if (vm.privateIp)    rows.push(`IP: ${escapeHtml(vm.privateIp)}`);
  if (vm.subnetId)     rows.push(`Subnet: ${escapeHtml(vm.subnetId)}`);
  return rows.join('<br/>');
}

function formatRam(gb: number): string {
  return gb >= 100 ? gb.toFixed(0) : gb.toFixed(1).replace(/\.0$/, '');
}

// ---- Wire up landing page ----

setupUpload({
  drop,
  input,
  pick,
  onFile: (buf, name) => { loadFile(buf, name); },
});

reset.addEventListener('click', () => {
  teardown();
  clearLog();
  setTooltip(null);
  setLockPrompt(false);
  setCrosshair(false);
  modeBar.style.display   = 'none';
  osControls.style.display = 'none';
  osMapRoot.innerHTML = '';
  currentGraph  = null;
  currentEstate = null;
  currentSvg    = null;
  showLanding(true);
});
