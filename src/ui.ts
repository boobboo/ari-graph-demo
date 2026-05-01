import type { Graph, World } from './types';

export function showStats(graph: Graph, world: World) {
  const el = document.getElementById('stats')!;
  el.style.display = 'block';
  const unknownSku = graph.vms.filter(v => v.unknownSku).length;
  const orphans = graph.vms.filter(v => !v.subnetId).length;
  const lines: string[] = [];
  lines.push(`<b>${graph.vms.length}</b> VMs  ·  <b>${world.subnets.length}</b> subnets  ·  <b>${graph.vnets.length}</b> VNets`);
  const services: string[] = [];
  services.push(`<span class="k">${graph.peerings.length}</span> peerings`);
  if (graph.nsgs.length)      services.push(`<span class="k">${graph.nsgs.length}</span> NSGs`);
  if (graph.publicIps.length) services.push(`<span class="k">${graph.publicIps.length}</span> public IPs`);
  if (graph.storage.length)   services.push(`<span class="k">${graph.storage.length}</span> storage acct${graph.storage.length === 1 ? '' : 's'}`);
  lines.push(services.join('  ·  '));
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
