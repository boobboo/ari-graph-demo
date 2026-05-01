import { readFileSync } from 'node:fs';
import { parseAri } from '../src/parser';
import { buildWorld } from '../src/layout';

export async function run(path: string) {
  const buf = readFileSync(path);
  const arr = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const log = (m: string) => console.log('  ' + m);
  console.log(`\n=== Parsing ${path} ===`);
  const { graph } = parseAri(arr as ArrayBuffer, log);
  console.log(`\n=== Building world ===`);
  const world = buildWorld(graph);

  // ---- Assertions ----
  const fail = (msg: string) => { console.error('FAIL:', msg); process.exitCode = 1; };

  if (graph.vms.length !== 9)      fail(`expected 9 VMs, got ${graph.vms.length}`);
  if (graph.vnets.length !== 3)    fail(`expected 3 vnets, got ${graph.vnets.length}`);
  if (graph.subnets.length !== 5)  fail(`expected 5 subnets, got ${graph.subnets.length}`);
  if (graph.peerings.length !== 2) fail(`expected 2 peerings, got ${graph.peerings.length}`);

  // Every VM must be linked to a subnet (the fixture has full NIC coverage).
  const orphan = graph.vms.filter(v => !v.subnetId);
  if (orphan.length) fail(`expected 0 orphan VMs, got ${orphan.length}: ${orphan.map(v=>v.name).join(',')}`);

  // Tower heights monotonic with SKU expectation: M64ms > E16s_v3 > D8s_v3 > D4s_v3 > B2s > B1s
  const byName = new Map(world.vms.map(v => [v.name, v]));
  const order = ['db-02', 'db-01', 'app-02', 'app-01', 'web-02', 'web-01'];
  let last = Infinity;
  for (const n of order) {
    const v = byName.get(n);
    if (!v) { fail(`missing placed VM ${n}`); continue; }
    if (v.height > last) fail(`height not monotonic at ${n}: ${v.height} > previous ${last}`);
    last = v.height;
  }

  // Print a compact summary table.
  console.log('\nVM towers (name · sku · vCPU · ramGB · height):');
  for (const v of world.vms) {
    console.log(`  ${v.name.padEnd(7)}  ${v.sku.padEnd(20)} ${String(v.vCPU).padStart(3)}c ${String(v.ramGB).padStart(5)}G  h=${v.height}`);
  }

  console.log('\nSubnets:');
  for (const s of world.subnets) {
    const count = world.vms.filter(v => v.subnetId === s.id).length;
    console.log(`  ${s.name.padEnd(12)}  vnet=${s.vnetId.padEnd(12)}  size=${s.size.toFixed(1).padStart(5)}  vms=${count}`);
  }
  console.log('\nVNets:');
  for (const v of world.vnets) {
    console.log(`  ${v.name.padEnd(12)} center=(${v.center[0].toFixed(1)}, ${v.center[1].toFixed(1)}) size=${v.size.toFixed(1)} color=#${v.color.toString(16).padStart(6,'0')}`);
  }
  console.log(`\nWorld bounds: x=[${world.bounds.min[0].toFixed(1)}, ${world.bounds.max[0].toFixed(1)}]  z=[${world.bounds.min[1].toFixed(1)}, ${world.bounds.max[1].toFixed(1)}]`);
  console.log(`Peerings: ${world.peerings.length}`);

  if (process.exitCode === 1) {
    console.error('\nSMOKE TEST FAILED');
  } else {
    console.log('\nSMOKE TEST PASSED');
  }
}
