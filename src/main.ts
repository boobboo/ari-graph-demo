import * as THREE from 'three';
import { setupUpload } from './upload';
import { parseAri } from './parser';
import { buildWorld } from './layout';
import { buildScene, type BuiltScene, type ServiceTip } from './world';
import { createFlyControls, type FlyControls } from './controls';
import {
  showStats, setLog, clearLog, showLanding,
  setLockPrompt, setCrosshair, setTooltip, escapeHtml,
} from './ui';

interface Session {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  built: BuiltScene;
  fly: FlyControls;
  rafId: number;
  raycaster: THREE.Raycaster;
  onResize: () => void;
}

let session: Session | null = null;

function teardown() {
  if (!session) return;
  cancelAnimationFrame(session.rafId);
  window.removeEventListener('resize', session.onResize);
  session.fly.dispose();
  session.built.dispose();
  session.renderer.dispose();
  session.renderer.domElement.remove();
  session = null;
}

async function loadFile(buf: ArrayBuffer, name: string) {
  clearLog();
  setLog(`Reading ${name}…`);
  let graph;
  try {
    graph = parseAri(buf, setLog);
  } catch (err) {
    setLog(`Parse failed: ${(err as Error).message}`);
    return;
  }
  if (graph.vms.length === 0) {
    setLog(`No VMs detected in this workbook. Is the Compute / Virtual Machines tab present?`);
    return;
  }
  const world = buildWorld(graph);
  setLog(`Building world… (${world.vms.length} towers, span ${Math.round(world.bounds.max[0] - world.bounds.min[0])} × ${Math.round(world.bounds.max[1] - world.bounds.min[1])} units)`);

  teardown();

  const root = document.getElementById('canvas-root')!;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  root.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 2000);
  const built = buildScene(world);
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

  const raycaster = new THREE.Raycaster();
  const screenCenter = new THREE.Vector2(0, 0);

  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    fly.update(dt);

    // Hover tooltip via raycast from screen centre. We test VM towers AND
    // service-building targets (NSGs, Public IPs, Storage car parks) and pick
    // whichever the ray hits first.
    if (fly.isLocked()) {
      raycaster.setFromCamera(screenCenter, camera);
      const vmHits = raycaster.intersectObjects(built.vmTowers, false);
      const serviceHits = built.serviceTargets.length
        ? raycaster.intersectObjects(built.serviceTargets, false)
        : [];
      const vmDist = vmHits[0]?.distance ?? Infinity;
      const svcDist = serviceHits[0]?.distance ?? Infinity;
      if (vmDist === Infinity && svcDist === Infinity) {
        setTooltip(null);
      } else if (vmDist <= svcDist) {
        const hit = vmHits[0];
        if (typeof hit.instanceId === 'number') {
          const inst = hit.object as THREE.InstancedMesh;
          const list = built.vmInstanceMap.get(inst);
          const vm = list?.[hit.instanceId];
          if (vm) setTooltip(formatVm(vm));
        }
      } else {
        const tip = built.serviceLookup.get(serviceHits[0].object);
        if (tip) setTooltip(formatService(tip));
      }
    }

    renderer.render(built.scene, camera);
    session!.rafId = requestAnimationFrame(tick);
  };

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  session = { renderer, camera, built, fly, rafId: 0, raycaster, onResize };
  session.rafId = requestAnimationFrame(tick);
}

function formatVm(vm: { name: string; sku: string; vCPU: number; ramGB: number; os: string; rg: string; subscription: string; location: string; privateIp: string | null; subnetId: string | null }): string {
  const rows: string[] = [];
  rows.push(`<b>${escapeHtml(vm.name)}</b>`);
  rows.push(`${escapeHtml(vm.sku || '?')} · ${vm.vCPU} vCPU · ${formatRam(vm.ramGB)} GB`);
  rows.push(`OS: ${escapeHtml(vm.os)}`);
  if (vm.rg) rows.push(`RG: ${escapeHtml(vm.rg)}`);
  if (vm.location) rows.push(`Region: ${escapeHtml(vm.location)}`);
  if (vm.subscription) rows.push(`Sub: ${escapeHtml(vm.subscription)}`);
  if (vm.privateIp) rows.push(`IP: ${escapeHtml(vm.privateIp)}`);
  if (vm.subnetId) rows.push(`Subnet: ${escapeHtml(vm.subnetId)}`);
  return rows.join('<br/>');
}

function formatRam(gb: number): string {
  return gb >= 100 ? gb.toFixed(0) : gb.toFixed(1).replace(/\.0$/, '');
}

function formatService(tip: ServiceTip): string {
  const rows: string[] = [];
  if (tip.kind === 'nsg') {
    const n = tip.data;
    rows.push(`<b>${escapeHtml(n.name)}</b> · NSG`);
    if (n.subnetId) rows.push(`Attached: subnet <code>${escapeHtml(n.subnetId)}</code>`);
    else if (n.nicName) rows.push(`Attached: NIC <code>${escapeHtml(n.nicName)}</code>`);
    if (n.rg) rows.push(`RG: ${escapeHtml(n.rg)}`);
    if (n.location) rows.push(`Region: ${escapeHtml(n.location)}`);
  } else if (tip.kind === 'publicIp') {
    const p = tip.data;
    rows.push(`<b>${escapeHtml(p.name)}</b> · Public IP`);
    if (p.ipAddress) rows.push(`IP: <code>${escapeHtml(p.ipAddress)}</code>`);
    if (p.sku) rows.push(`SKU: ${escapeHtml(p.sku)}`);
    if (p.attachedNic) rows.push(`NIC: ${escapeHtml(p.attachedNic)}`);
    if (p.rg) rows.push(`RG: ${escapeHtml(p.rg)}`);
  } else {
    const s = tip.data;
    rows.push(`<b>${escapeHtml(s.name)}</b> · Storage`);
    if (s.kind) rows.push(`Kind: ${escapeHtml(s.kind)}`);
    if (s.sku) rows.push(`SKU: ${escapeHtml(s.sku)}`);
    if (s.tier && s.tier !== 'unknown') rows.push(`Tier: ${escapeHtml(s.tier)}`);
    if (s.rg) rows.push(`RG: ${escapeHtml(s.rg)}`);
    if (s.location) rows.push(`Region: ${escapeHtml(s.location)}`);
  }
  return rows.join('<br/>');
}

// ---- Wire up landing page ----
const drop = document.getElementById('drop') as HTMLElement;
const input = document.getElementById('file') as HTMLInputElement;
const pick = document.getElementById('pick') as HTMLButtonElement;
const reset = document.getElementById('reset') as HTMLButtonElement;

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
  showLanding(true);
});
