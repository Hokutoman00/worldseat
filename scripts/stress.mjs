#!/usr/bin/env node
// WorldSeat invariant stress test — committed, repeatable evidence for the core claim:
//   Aurora DSQL (serializable OCC) holds "one seat sells exactly once" under heavy concurrency,
//   while DynamoDB Global Tables (eventual, LWW) does not — running the SAME naive app code.
//
// It hammers the LIVE deployment's /api/breakit at escalating concurrency and asserts, from the
// COMMITTED ground truth the API returns, that DSQL oversold == 0 every time and naive oversold > 0
// at least once. It also prints DSQL OCC maxRetries so the "OCC serialized a real race" claim is
// shown, not asserted.
//
// Usage:  node scripts/stress.mjs [baseURL]
//   default baseURL = https://worldseat.vercel.app
//   override:        node scripts/stress.mjs http://localhost:3000

const BASE = (process.argv[2] || 'https://worldseat.vercel.app').replace(/\/$/, '');
const LEVELS = [8, 24, 48, 60];
const SEAT = 'A1';

async function breakit(backend, concurrency) {
  const r = await fetch(`${BASE}/api/breakit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ backend, seat: SEAT, concurrency }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${backend} c=${concurrency}: ${j.error}`);
  return j;
}

function line(j) {
  return `c=${String(j.concurrency).padStart(2)}  confirmed=${String(j.confirmed).padStart(2)}` +
         `  oversold=${String(j.oversold).padStart(2)}  maxRetries=${String(j.maxRetries).padStart(2)}` +
         `  ${j.durationMs}ms`;
}

let failures = 0;
let naiveEverOversold = false;
let dsqlMaxRetriesSeen = 0;

console.log(`WorldSeat stress test → ${BASE}\n`);

console.log('Aurora DSQL (strong / serializable OCC) — expect oversold = 0 at every level:');
for (const c of LEVELS) {
  const j = await breakit('dsql', c);
  dsqlMaxRetriesSeen = Math.max(dsqlMaxRetriesSeen, j.maxRetries);
  const ok = j.oversold === 0 && j.confirmed === 1;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${line(j)}`);
}

console.log('\nDynamoDB Global Tables (eventual / LWW) — expect oversold > 0 (the foil):');
for (const c of LEVELS) {
  const j = await breakit('naive', c);
  if (j.oversold > 0) naiveEverOversold = true;
  console.log(`  ${j.oversold > 0 ? 'OVERSOLD' : 'clean   '}  ${line(j)}`);
}
if (!naiveEverOversold) { failures++; console.log('  FAIL  naive never oversold — foil did not reproduce the race'); }

// reset both floors clean after the run
await fetch(`${BASE}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'dsql' }) }).catch(() => {});
await fetch(`${BASE}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend: 'naive' }) }).catch(() => {});

console.log(`\nDSQL max OCC retries observed under load: ${dsqlMaxRetriesSeen}` +
            (dsqlMaxRetriesSeen > 0 ? '  (OCC aborted-and-retried a real conflict)' : ''));
console.log(failures === 0
  ? '\nRESULT: PASS — invariant held on DSQL at every concurrency level; foil reproduced oversell.'
  : `\nRESULT: FAIL — ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
