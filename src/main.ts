import * as THREE from 'three';
import { setupUpload } from './upload';
import { parseAri } from './parser';
import { buildWorld } from './layout';
import { buildScene, type BuiltScene, type ServiceTip, type OverlayMode } from './world';
import { createFlyControls, type FlyControls } from './controls';
import {
  showStats, setLog, clearLog, showLanding,
  setLockPrompt, setCrosshair, setTooltip, escapeHtml,
  renderDemandGraph, setNewsTicker,
} from './ui';
import type { Graph, World, PlacedVm } from './types';

type CameraMode = 'fly' | 'iso';

interface Session {
  renderer: THREE.WebGLRenderer;
  perspectiveCam: THREE.PerspectiveCamera;
  isoCam: THREE.OrthographicCamera;
  cameraMode: CameraMode;
  built: BuiltScene;
  fly: FlyControls;
  rafId: number;
  raycaster: THREE.Raycaster;
  onResize: () => void;
  // Iso-mode state
  isoState: { panKeys: Set<string>; zoomLevel: number; mouseNdc: THREE.Vector2; };
  // For search "fly-to"
  searchIndex: SearchEntry[];
  graph: Graph;
  world: World;
  newsTimer: number | null;
}

interface SearchEntry {
  label: string;
  detail: string;
  pos: THREE.Vector3;
}

let session: Session | null = null;

function teardown() {
  if (!session) return;
  cancelAnimationFrame(session.rafId);
  if (session.newsTimer !== null) clearInterval(session.newsTimer);
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
  let graph: Graph;
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
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  root.appendChild(renderer.domElement);

  const perspectiveCam = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 6000);
  const built = buildScene(world);
  perspectiveCam.position.copy(built.spawn.pos);
  perspectiveCam.lookAt(built.spawn.lookAt);

  // Orthographic isometric camera (PRD §8). Frustum framed to world bounds.
  const isoCam = new THREE.OrthographicCamera(-100, 100, 60, -60, 0.1, 6000);
  framePerspectiveAsIso(isoCam, world.bounds);

  const fly = createFlyControls(perspectiveCam, renderer.domElement);

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

  // ---- Demand graph (PRD §5.6 RCI demand dashboard) ----
  renderDemandGraph(aggregateRci(graph));

  // ---- News ticker (PRD §5.6) ----
  const newsLines = composeNewsTicker(graph, world);
  let newsIdx = 0;
  if (newsLines.length > 0) {
    setNewsTicker(newsLines[0]);
  }
  const newsTimer = (newsLines.length > 1)
    ? window.setInterval(() => {
        newsIdx = (newsIdx + 1) % newsLines.length;
        setNewsTicker(newsLines[newsIdx]);
      }, 6000)
    : null;

  // ---- Search index ----
  const searchIndex: SearchEntry[] = buildSearchIndex(world);

  const raycaster = new THREE.Raycaster();
  const screenCenter = new THREE.Vector2(0, 0);

  // Iso state
  const isoState = {
    panKeys: new Set<string>(),
    zoomLevel: 1.0,
    mouseNdc: new THREE.Vector2(0, 0),
  };
  document.addEventListener('keydown', (e) => {
    if (session?.cameraMode !== 'iso') return;
    if (['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) {
      isoState.panKeys.add(e.code);
      e.preventDefault();
    }
  });
  document.addEventListener('keyup', (e) => {
    isoState.panKeys.delete(e.code);
  });
  renderer.domElement.addEventListener('wheel', (e) => {
    if (session?.cameraMode !== 'iso') return;
    e.preventDefault();
    isoState.zoomLevel *= (e.deltaY > 0) ? 1.12 : 0.89;
    isoState.zoomLevel = Math.max(0.15, Math.min(8, isoState.zoomLevel));
    applyIsoZoom(isoCam, isoState.zoomLevel, world.bounds);
  }, { passive: false });
  renderer.domElement.addEventListener('mousemove', (e) => {
    if (session?.cameraMode !== 'iso') return;
    const r = renderer.domElement.getBoundingClientRect();
    isoState.mouseNdc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    isoState.mouseNdc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  });

  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const cam: THREE.Camera = session!.cameraMode === 'iso' ? isoCam : perspectiveCam;

    if (session!.cameraMode === 'fly') {
      fly.update(dt);
      if (fly.isLocked()) {
        raycaster.setFromCamera(screenCenter, perspectiveCam);
        runHover(raycaster);
      }
    } else {
      // Iso pan
      const span = Math.max(world.bounds.max[0] - world.bounds.min[0], world.bounds.max[1] - world.bounds.min[1]);
      const panSpeed = span * 0.4;
      let dx = 0, dz = 0;
      if (isoState.panKeys.has('KeyW') || isoState.panKeys.has('ArrowUp'))    dz -= 1;
      if (isoState.panKeys.has('KeyS') || isoState.panKeys.has('ArrowDown'))  dz += 1;
      if (isoState.panKeys.has('KeyA') || isoState.panKeys.has('ArrowLeft'))  dx -= 1;
      if (isoState.panKeys.has('KeyD') || isoState.panKeys.has('ArrowRight')) dx += 1;
      if (dx || dz) {
        const len = Math.hypot(dx, dz) || 1;
        isoCam.position.x += (dx / len) * panSpeed * dt;
        isoCam.position.z += (dz / len) * panSpeed * dt;
        isoCam.lookAt(isoCam.position.x, 0, isoCam.position.z - 1);
      }
      // Hover via mouse-ndc raycast in iso mode.
      raycaster.setFromCamera(isoState.mouseNdc, isoCam);
      runHover(raycaster);
    }

    renderer.render(built.scene, cam);
    session!.rafId = requestAnimationFrame(tick);
  };

  function runHover(rc: THREE.Raycaster) {
    const vmHits = rc.intersectObjects(built.vmTowers, false);
    const serviceHits = built.serviceTargets.length
      ? rc.intersectObjects(built.serviceTargets, false)
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

  const onResize = () => {
    perspectiveCam.aspect = window.innerWidth / window.innerHeight;
    perspectiveCam.updateProjectionMatrix();
    applyIsoZoom(isoCam, isoState.zoomLevel, world.bounds);
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  session = {
    renderer, perspectiveCam, isoCam, cameraMode: 'fly',
    built, fly, rafId: 0, raycaster, onResize, isoState, searchIndex,
    graph, world, newsTimer,
  };
  session.rafId = requestAnimationFrame(tick);

  // ---- Wire overlay panel buttons (PRD §5.6) ----
  document.querySelectorAll<HTMLButtonElement>('.ovbtn[data-overlay]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.overlay as OverlayMode;
      built.setOverlay(mode);
      document.querySelectorAll('.ovbtn[data-overlay]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // ---- Camera mode toggle ----
  const camFly = document.getElementById('cam-fly')!;
  const camIso = document.getElementById('cam-iso')!;
  const setCamMode = (m: CameraMode) => {
    if (!session) return;
    session.cameraMode = m;
    camFly.classList.toggle('active', m === 'fly');
    camIso.classList.toggle('active', m === 'iso');
    if (m === 'iso') {
      // Release pointer-lock if active
      if (session.fly.isLocked()) (session.fly.controls as unknown as { unlock(): void }).unlock();
      setLockPrompt(false);
      setCrosshair(false);
      framePerspectiveAsIso(session.isoCam, session.world.bounds);
      applyIsoZoom(session.isoCam, session.isoState.zoomLevel, session.world.bounds);
    } else {
      setLockPrompt(true);
    }
  };
  camFly.addEventListener('click', () => setCamMode('fly'));
  camIso.addEventListener('click', () => setCamMode('iso'));

  // ---- Search ----
  const searchInput = document.getElementById('search') as HTMLInputElement;
  const searchResults = document.getElementById('search-results')!;
  searchInput.value = '';
  searchResults.innerHTML = '';
  searchInput.oninput = () => {
    const q = searchInput.value.trim().toLowerCase();
    if (q.length < 2) { searchResults.innerHTML = ''; return; }
    const hits = searchIndex.filter(e => e.label.toLowerCase().includes(q)).slice(0, 12);
    searchResults.innerHTML = hits.map((h, i) =>
      `<div class="hit" data-i="${i}"><b>${escapeHtml(h.label)}</b> <span style="color:#9fb1c7">${escapeHtml(h.detail)}</span></div>`
    ).join('');
    searchResults.querySelectorAll<HTMLDivElement>('.hit').forEach(el => {
      el.addEventListener('click', () => {
        const idx = Number(el.dataset.i);
        const hit = hits[idx];
        if (!hit || !session) return;
        flyTo(session, hit.pos);
      });
    });
  };

  // ---- PNG export (PRD §8) ----
  const exportBtn = document.getElementById('export-png')!;
  exportBtn.onclick = () => {
    if (!session) return;
    // Render once at current resolution, then export.
    const cam: THREE.Camera = session.cameraMode === 'iso' ? session.isoCam : session.perspectiveCam;
    session.renderer.render(session.built.scene, cam);
    session.renderer.domElement.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ari-city-${Date.now()}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  };
}

function aggregateRci(graph: Graph): { R: number; C: number; I: number } {
  let R = 0, C = 0, I = 0;
  for (const rg of graph.resourceGroups) {
    R += rg.rciR; C += rg.rciC; I += rg.rciI;
  }
  const total = R + C + I;
  if (total === 0) return { R: 1/3, C: 1/3, I: 1/3 };
  return { R: R/total, C: C/total, I: I/total };
}

function composeNewsTicker(graph: Graph, world: World): string[] {
  // Auto-generated commentary per PRD §5.6 (Advisor system idiom).
  const out: string[] = [];
  // Cost concentration
  const rgCosts = new Map<string, number>();
  const accrue = (rgId: string, c: number) => rgCosts.set(rgId, (rgCosts.get(rgId) ?? 0) + c);
  for (const v of world.vms)        accrue(v.rgId, v.carriers.costMonthlyGbp);
  for (const s of world.storage)    accrue(s.rgId, s.carriers.costMonthlyGbp);
  for (const o of world.others)     accrue(o.rgId, o.carriers.costMonthlyGbp);
  const top = [...rgCosts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) {
    const rg = graph.resourceGroups.find(r => r.id === top[0]);
    if (rg) out.push(`<span class="src">📰 Cost</span>: top district by spend is <b>${escapeHtml(rg.name)}</b> at ~£${Math.round(top[1]).toLocaleString()}/month.`);
  }
  // Coverage gaps
  const hasKv = world.others.some(o => o.kind === 'keyVault');
  const hasRv = world.others.some(o => o.kind === 'recoveryVault');
  const hasLa = world.others.some(o => o.kind === 'logAnalytics');
  if (!hasKv) out.push('<span class="src">📰 Security</span>: no Key Vault detected — secrets governance unevenly distributed.');
  if (!hasRv) out.push('<span class="src">📰 Resilience</span>: no Recovery Vault detected — no centralised backup posture.');
  if (!hasLa) out.push('<span class="src">📰 Ops</span>: no Log Analytics workspace — telemetry not centralised.');
  // RCI imbalance
  const rci = aggregateRci(graph);
  if (rci.I > 0.7) out.push('<span class="src">📰 Architecture</span>: estate is heavily Industrial — consider App Service / Function App for workloads that don\'t need a full VM.');
  if (rci.R > 0.7) out.push('<span class="src">📰 Architecture</span>: estate skews Residential — light-touch app hosts dominate.');
  // Storage concentration
  if (world.storage.length > 50) out.push(`<span class="src">📰 Sprawl</span>: ${world.storage.length} storage accounts in this estate — many candidates for consolidation under a tagged set.`);
  // Sub count
  if (graph.subscriptions.length > 5) out.push(`<span class="src">📰 Layout</span>: ${graph.subscriptions.length} subscriptions in scope — consider landing-zone hierarchy review.`);
  if (out.length === 0) out.push('<span class="src">📰</span> Estate looks balanced. No standout concerns.');
  return out;
}

function buildSearchIndex(world: World): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const v of world.vms) out.push({
    label: v.name, detail: `VM · ${v.sku} · ${v.rg}`,
    pos: new THREE.Vector3(v.pos[0], v.storeys * 0.8, v.pos[2]),
  });
  for (const s of world.storage) out.push({
    label: s.name, detail: `Storage · ${s.kind || 'StorageV2'} · ${s.rg}`,
    pos: new THREE.Vector3(s.pos[0], 2, s.pos[1]),
  });
  for (const n of world.nsgs) out.push({
    label: n.name, detail: `NSG · ${n.rg}`,
    pos: new THREE.Vector3(n.pos[0], 1, n.pos[1]),
  });
  for (const p of world.publicIps) out.push({
    label: p.name, detail: `Public IP · ${p.ipAddress || ''} · ${p.rg}`,
    pos: new THREE.Vector3(p.pos[0], 1, p.pos[1]),
  });
  for (const o of world.others) out.push({
    label: o.name, detail: `${o.kind} · ${o.rg}`,
    pos: new THREE.Vector3(o.pos[0], 1, o.pos[1]),
  });
  for (const r of world.resourceGroups) out.push({
    label: r.name, detail: `RG · ${r.rciPrimary}`,
    pos: new THREE.Vector3(r.center[0], 5, r.center[1]),
  });
  return out;
}

function flyTo(s: Session, target: THREE.Vector3) {
  // Animate camera over ~0.6s. Works in both modes.
  if (s.cameraMode === 'iso') {
    s.isoCam.position.set(target.x, s.isoCam.position.y, target.z);
    s.isoCam.lookAt(target.x, 0, target.z - 1);
  } else {
    // Pull back so we can see the target, plus a little above.
    const offset = new THREE.Vector3(8, 12, 14);
    const dest = target.clone().add(offset);
    animateVec3(s.perspectiveCam.position, dest, 0.6);
    s.perspectiveCam.lookAt(target);
  }
}

function animateVec3(target: THREE.Vector3, dest: THREE.Vector3, durationSec: number) {
  const start = target.clone();
  const t0 = performance.now();
  const step = () => {
    const t = (performance.now() - t0) / (durationSec * 1000);
    if (t >= 1) { target.copy(dest); return; }
    const e = t * t * (3 - 2 * t); // smoothstep
    target.lerpVectors(start, dest, e);
    requestAnimationFrame(step);
  };
  step();
}

function framePerspectiveAsIso(cam: THREE.OrthographicCamera, bounds: { min: [number, number]; max: [number, number] }) {
  const cx = (bounds.min[0] + bounds.max[0]) / 2;
  const cz = (bounds.min[1] + bounds.max[1]) / 2;
  const span = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]);
  // Classic SimCity 3000 angle: ~30° down, 45° around.
  const dist = span * 0.9;
  cam.position.set(cx + dist, dist * 0.85, cz + dist);
  cam.lookAt(cx, 0, cz);
}

function applyIsoZoom(cam: THREE.OrthographicCamera, zoom: number, bounds: { min: [number, number]; max: [number, number] }) {
  const span = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]);
  const aspect = window.innerWidth / window.innerHeight;
  const half = (span * 0.65) * zoom;
  cam.left = -half * aspect;
  cam.right = half * aspect;
  cam.top = half;
  cam.bottom = -half;
  cam.near = 0.1;
  cam.far = span * 4 + 1000;
  cam.updateProjectionMatrix();
}

function formatVm(vm: PlacedVm): string {
  const rows: string[] = [];
  rows.push(`<b>${escapeHtml(vm.name)}</b>`);
  rows.push(`${escapeHtml(vm.sku || '?')} · ${vm.vCPU} vCPU · ${formatRam(vm.ramGB)} GB`);
  rows.push(`OS: ${escapeHtml(vm.os)}`);
  if (vm.rg) rows.push(`RG: ${escapeHtml(vm.rg)}`);
  if (vm.location) rows.push(`Region: ${escapeHtml(vm.location)}`);
  if (vm.privateIp) rows.push(`IP: ${escapeHtml(vm.privateIp)}`);
  rows.push(`<i>~£${vm.carriers.costMonthlyGbp.toLocaleString()}/m · util ${vm.carriers.utilisationPct}%</i>`);
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
    rows.push(`<i>unauth attempts (30d): ${n.carriers.unauthAttempts}</i>`);
  } else if (tip.kind === 'publicIp') {
    const p = tip.data;
    rows.push(`<b>${escapeHtml(p.name)}</b> · Public IP`);
    if (p.ipAddress) rows.push(`IP: <code>${escapeHtml(p.ipAddress)}</code>`);
    if (p.sku) rows.push(`SKU: ${escapeHtml(p.sku)}`);
    if (p.attachedNic) rows.push(`NIC: ${escapeHtml(p.attachedNic)}`);
    rows.push(`<i>£${p.carriers.costMonthlyGbp}/m</i>`);
  } else if (tip.kind === 'storage') {
    const s = tip.data;
    rows.push(`<b>${escapeHtml(s.name)}</b> · Storage`);
    if (s.kind) rows.push(`Kind: ${escapeHtml(s.kind)}`);
    if (s.sku) rows.push(`SKU: ${escapeHtml(s.sku)}`);
    if (s.tier && s.tier !== 'unknown') rows.push(`Tier: ${escapeHtml(s.tier)}`);
    if (s.rg) rows.push(`RG: ${escapeHtml(s.rg)}`);
    rows.push(`<i>~£${s.carriers.costMonthlyGbp}/m</i>`);
  } else {
    const o = tip.data;
    rows.push(`<b>${escapeHtml(o.name)}</b> · ${escapeHtml(o.kind)}`);
    if (o.sku) rows.push(`SKU: ${escapeHtml(o.sku)}`);
    if (o.sizeGB) rows.push(`Size: ${o.sizeGB} GB`);
    if (o.rg) rows.push(`RG: ${escapeHtml(o.rg)}`);
    if (o.emitsCoverage) rows.push(`<i>Coverage: ${o.emitsCoverage.service} · radius ${o.emitsCoverage.radius}u</i>`);
    rows.push(`<i>~£${o.carriers.costMonthlyGbp}/m</i>`);
    for (const [k, v] of Object.entries(o.extras).slice(0, 3)) {
      rows.push(`${escapeHtml(k)}: ${escapeHtml(v)}`);
    }
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
