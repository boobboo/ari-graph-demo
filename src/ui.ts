import type { Graph, World } from './types';

export function showStats(graph: Graph, world: World) {
  const el = document.getElementById('stats')!;
  el.style.display = 'block';
  const unknownSku = graph.vms.filter(v => v.unknownSku).length;
  const orphans = graph.vms.filter(v => !v.subnetId).length;
  const lines: string[] = [];
  // Hierarchy summary (PRD §5.1: Region → Subscription → RG → Resource)
  lines.push(`<b>${graph.regions.length}</b> region${graph.regions.length === 1 ? '' : 's'}  ·  <b>${graph.subscriptions.length}</b> sub${graph.subscriptions.length === 1 ? '' : 's'}  ·  <b>${graph.resourceGroups.length}</b> RG${graph.resourceGroups.length === 1 ? '' : 's'}`);
  // Resource counts
  lines.push(`<b>${graph.vms.length}</b> VMs  ·  <b>${graph.storage.length}</b> storage  ·  <b>${graph.nsgs.length}</b> NSGs  ·  <b>${graph.publicIps.length}</b> public IPs`);
  // Network overlay summary
  lines.push(`<span class="k">${graph.vnets.length}</span> VNet${graph.vnets.length === 1 ? '' : 's'}  ·  <span class="k">${world.subnets.length}</span> subnets  ·  <span class="k">${graph.peerings.length}</span> peerings`);
  if (unknownSku) lines.push(`<span class="k">${unknownSku}</span> unrecognised SKUs`);
  if (orphans)   lines.push(`<span class="k">${orphans}</span> VMs not linked to a subnet`);
  for (const note of graph.notes) lines.push(`<span style="color:#9fb1c7">${escapeHtml(note)}</span>`);
  el.innerHTML = lines.join('<br/>');
}

export function setLog(line: string) {
  const log = document.getElementById('log')!;
  log.textContent += (log.textContent ? '\n' : '') + line;
  log.scrollTop = log.scrollHeight;
}

export function clearLog() {
  document.getElementById('log')!.textContent = '';
}

export function showLanding(show: boolean) {
  const landing = document.getElementById('landing')!;
  landing.style.display = show ? 'flex' : 'none';
  document.getElementById('legend')!.style.display = show ? 'none' : 'block';
  document.getElementById('reset')!.style.display = show ? 'none' : 'inline-block';
  document.getElementById('overlay-panel')!.style.display = show ? 'none' : 'block';
  document.getElementById('demand-graph')!.style.display = show ? 'none' : 'block';
  document.getElementById('news-ticker')!.style.display = show ? 'none' : 'block';
}

export function renderDemandGraph(rg: { R: number; C: number; I: number }) {
  const bars = document.getElementById('demand-bars')!;
  const fmt = (v: number) => `${Math.round(v * 100)}%`;
  const row = (label: string, value: number, color: string) => `
    <div class="demand-bar-row">
      <span class="label">${label}</span>
      <span class="bar"><span class="fill" style="width:${value * 100}%;background:${color}"></span></span>
      <span class="pct">${fmt(value)}</span>
    </div>`;
  bars.innerHTML =
    row('Residential', rg.R, '#a6c97a') +
    row('Commercial',  rg.C, '#7aa9bf') +
    row('Industrial',  rg.I, '#c89556');
}

export function setNewsTicker(line: string) {
  const el = document.getElementById('news-ticker')!;
  el.innerHTML = line;
}

export function setLockPrompt(show: boolean) {
  document.getElementById('lockprompt')!.style.display = show ? 'block' : 'none';
}

export function setCrosshair(show: boolean) {
  document.getElementById('crosshair')!.style.display = show ? 'block' : 'none';
}

export function setTooltip(html: string | null) {
  const el = document.getElementById('tooltip')!;
  if (!html) { el.style.display = 'none'; return; }
  el.innerHTML = html;
  el.style.display = 'block';
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  }[ch]!));
}
