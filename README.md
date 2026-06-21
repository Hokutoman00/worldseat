# WorldSeat

**Strong database consistency you can *break* with one click.**

WorldSeat is a worldwide ticket on-sale where one seat must sell to exactly one fan.
A **Break it** button fires up to 60 simultaneous buyers at a single seat from two AWS
regions at once. The *same naive read-then-write application code* runs on two backends —
the only variable is the database:

- **Amazon Aurora DSQL** (serializable, multi-region active-active) → the seat sells
  **exactly once. oversold = 0.**
- **Amazon DynamoDB Global Tables** (eventual, last-writer-wins) → the same code oversells
  the seat to dozens of people.

A built-in Jepsen-lite **Consistency Witness** delivers the verdict from the *committed*
ledger — never from what the app hoped happened.

▶ **Live:** https://worldseat.vercel.app — buy a seat, then break it.

Built for AWS **Hack the Zero Stack** (Vercel + one AWS database).
**Submitted database: Amazon Aurora DSQL.** DynamoDB Global Tables appears only as an
educational comparison foil — remove it and every product feature still runs on DSQL alone.

---

## Judge Quickstart — 30 seconds

1. Open **https://worldseat.vercel.app** (no login).
2. Backend is **Aurora DSQL** by default. Leave `seat A1`, set `buyers 60`, press **Break it**
   → scoreboard reads **oversold 0**; the Consistency Witness reads `Linearizable ✓`.
3. Flip the backend to **DynamoDB GT · foil**, press **Break it** again
   → the *same code* now reads **oversold > 0** (dozens), and the Witness reads `Violated ✗`.
4. Read the **three independent sources** panel under the verdict — `oversold` is counted from
   the committed ledger (ground truth), not from what the app returned.
5. Architecture + AWS console proof: `docs/architecture.png`, `docs/aws-dsql-us-east-1.png`,
   `docs/aws-dynamodb-globaltable.png`. Falsifiable invariant test: `scripts/stress.mjs`.

That is the whole thesis: **same naive code, only the database changed.** One sells the seat
once; the other oversells it.

---

## Why it's honest

The point of the demo is that nothing is rigged in DSQL's favor:

- **Identical app code on both backends.** A read-then-write with no application-level
  lock, no conditional update, no cleverness — the canonical race condition. The only
  difference is which database executes it.
- **`oversold` is counted from committed ground truth, never app return values.**
  Application responses lie under partition and retry. The number comes from the committed
  `op_log` (DSQL) or a strongly-consistent, cross-region, de-duplicated scan of the
  append-only sales ledger (DynamoDB).
- **The Witness reads the ledger, not the seats table.** Last-writer-wins converges the
  seats table to a single owner and *hides* the damage; the append-only ledger remembers
  that N different people were each told "you got it."

## Architecture

```
Browser ──► Next.js (Vercel, single public URL)
                 │  backend toggle (zero change to app code path)
        ┌────────┴─────────┐
        ▼                  ▼
  Aurora DSQL         DynamoDB Global Tables
  us-east-1 +         us-east-1 + us-east-2
  us-east-2 active    (eventual / LWW)
  us-west-2 witness
  (serializable OCC)
```

See `docs/architecture.png` and `docs/architecture.html`.

## How it works

| Piece | File | What it does |
|---|---|---|
| Naive purchase + OCC retry loop (DSQL) | `app/lib/dsql.ts` | `SELECT status` → `UPDATE sold`, catch SQLSTATE `40001`/`40P01`/`OC###`, retry, re-read `sold`, reject |
| Eventual-consistency backend (foil) | `app/lib/ddb.ts` | identical purchase logic on DynamoDB Global Tables v2 |
| Consistency Witness | `app/lib/witness.ts` | counts confirmed acquisitions per seat from committed history; `doubleSells = Σ max(0, confirmed−1)` |
| Break-it endpoint | `app/app/api/breakit/route.ts` | fires N concurrent buyers split across both regions; computes `oversold` from committed state |
| Committed invariant test | `scripts/stress.mjs` | hammers live deploy at c=8/24/48/60, asserts DSQL `oversold === 0` at every level |

## Run locally

```bash
cd app
npm install
# Configure AWS credentials + cluster endpoints via environment variables
# (see app/lib/dsql.ts and app/lib/ddb.ts for the names; never commit secrets).
npm run dev        # http://localhost:3000
```

Stress the deployed app:

```bash
node scripts/stress.mjs            # defaults to https://worldseat.vercel.app
BASE=http://localhost:3000 node scripts/stress.mjs
```

> **Note on `maxRetries`:** it is timing-dependent and a correct run can legitimately show
> `0`. If a late buyer's transaction begins *after* the winner committed, it reads `sold`
> and rejects cleanly with no OCC abort. Non-zero means two commits genuinely interleaved.
> Either path yields `oversold = 0` — that's the invariant; the retry counter is supporting
> evidence, not the headline.

## Deep dives

- [Make consistency something a judge can break](docs/articles/01-consistency-you-can-break.md)
- [A Jepsen-lite witness: prove "sold once" from committed history](docs/articles/02-jepsen-lite-witness.md)
- [Building on Aurora DSQL multi-region: setup notes](docs/articles/03-aurora-dsql-multiregion-notes.md)

## License

MIT
