# EVIDENCE — WorldSeat (H0: Hack the Zero Stack)

One page a judge can use to verify every claim. All numbers below are measured, not asserted —
each links to something runnable or viewable.

**Submitted database: Amazon Aurora DSQL.** DynamoDB Global Tables appears only as an educational
comparison foil; remove it and every product feature still runs on Aurora DSQL alone.

---

## 1. Live, no login

▶ **https://worldseat.vercel.app** — buy a seat, then press **Break it**.
Default backend is Aurora DSQL. See `README.md` → *Judge Quickstart (30 seconds)*.

## 2. The headline, measured

Same naive read-then-write code on both backends; the only variable is the database.

| Backend | 60 simultaneous buyers, one seat | Verdict |
|---|---|---|
| **Aurora DSQL** (serializable OCC) | **oversold = 0** — every run | `Linearizable ✓` |
| **DynamoDB GT** (eventual / LWW) | **oversold > 0** — 48 (captured run) · 41 (latest recheck); varies, always > 0 | `Violated ✗` |

## 3. Falsifiable invariant test (live)

`node scripts/stress.mjs` hammers the live deployment at concurrency 8/24/48/60 and asserts
`oversold === 0` on DSQL at every level, and `oversold > 0` on the foil. Captured 2026-06-21:

```
WorldSeat stress test → https://worldseat.vercel.app

Aurora DSQL (strong / serializable OCC) — expect oversold = 0 at every level:
  PASS  c= 8  confirmed= 1  oversold= 0  maxRetries= 0  1235ms
  PASS  c=24  confirmed= 1  oversold= 0  maxRetries= 1  753ms
  PASS  c=48  confirmed= 1  oversold= 0  maxRetries= 1  1194ms
  PASS  c=60  confirmed= 1  oversold= 0  maxRetries= 1  851ms

DynamoDB Global Tables (eventual / LWW) — expect oversold > 0 (the foil):
  OVERSOLD  c= 8  confirmed= 8  oversold= 7  maxRetries= 0  1357ms
  OVERSOLD  c=24  confirmed=25  oversold=24  maxRetries= 0  634ms
  OVERSOLD  c=48  confirmed=44  oversold=43  maxRetries= 0  1008ms
  OVERSOLD  c=60  confirmed=49  oversold=48  maxRetries= 0  1800ms

DSQL max OCC retries observed under load: 1  (OCC aborted-and-retried a real conflict)

RESULT: PASS — invariant held on DSQL at every concurrency level; foil reproduced oversell.
```

> **Captured run vs. latest recheck.** The block above is one captured run (foil peaked at
> **oversold = 48** at c=60). An independent recheck reproduced the same shape with the foil peaking
> at **oversold = 41** — DSQL stayed at **oversold = 0** at every level in both. The foil number is
> genuinely run-to-run variable under eventual consistency / last-writer-wins; what never varies is
> the pair *DSQL = 0 / foil > 0*. That is the invariant, and it is the point.

The `maxRetries = 1` on DSQL is the proof that two commits genuinely interleaved and the loser was
*aborted by serializability* — not that the app got lucky. It is honestly variable (a late buyer that
simply reads `sold` wins the race with zero conflicts); the invariant that holds every time is
**oversold = 0**, not the retry counter.

## 4. Production build

`npm run build` (in `app/`) compiles clean; route `/` ships at ~5.2 kB / 92.4 kB First Load JS,
all `/api/*` routes server-rendered on demand. See `BUILD-NOTES.md`.

## 5. AWS console proof (account ID redacted)

- `docs/aws-dsql-us-east-1.png` — Aurora DSQL cluster **ACTIVE** in us-east-1, peered to us-east-2,
  witness region us-west-2. Top nav bar (account name/ID) is masked.
- `docs/aws-dynamodb-globaltable.png` — DynamoDB `seats_naive` Global Table with two ACTIVE regional
  replicas. Top nav bar is masked.
- `docs/architecture.png` — system diagram (Vercel → backend toggle → DSQL / DynamoDB GT).

## 6. Demo video

▶ **https://youtu.be/2OD3Ye1jEqo** — 2:57 (< 3:00 cap), real frames from the live app (public).

## 7. Why it can't be rigged in DSQL's favor

- **Identical app code on both backends** — read-then-write with no app-level lock, no conditional
  update (`app/lib/dsql.ts`, `app/lib/ddb.ts`). Only the database executing it differs.
- **`oversold` counted from committed ground truth**, never app return values — the DSQL `op_log` and
  the append-only DynamoDB `sales_naive` ledger (`app/app/api/breakit/route.ts`).
- **Three independent sources** shown in the UI: app-believed / ledger-committed / seats-table-shows.
  Last-writer-wins converges the seats table to one owner and *hides* the damage; the ledger remembers
  that N people were each told "you got it." The gap is the corruption.
