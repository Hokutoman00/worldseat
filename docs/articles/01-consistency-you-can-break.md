# Make database consistency something a judge can *break* with one click

> Target: builder.aws (AWS Builder Center) · ~750 words · WorldSeat / Hack the Zero Stack

Most demos of "strong consistency" ask you to take it on faith. A slide says *serializable*, a diagram has some arrows, and you nod. You never see the property do anything, because when consistency works, *nothing happens* — that's the whole point. It's invisible plumbing.

WorldSeat makes the plumbing adversarial. It's a worldwide ticket on-sale where one seat must sell to exactly one fan. There's a button labeled **Break it**. Press it and the app fires dozens of simultaneous buyers at a single seat, from two AWS regions at once, and counts how many people walked away holding a ticket for the same physical chair.

The trick that makes this honest: **both backends run the identical naive application code.** A read-then-write with no application-level locking, no conditional update, no cleverness:

```ts
const r = await client.query('SELECT status FROM seats WHERE seat_id=$1', [seat]);
if (r.rows[0]?.status !== 'available') { rollback(); return 'rejected'; }
await client.query('UPDATE seats SET status=$1, owner=$2 WHERE seat_id=$3', ['sold', buyer, seat]);
```

That is the canonical race condition. Two buyers both read `available`, both write `sold`, both think they won. On any database without serializable isolation, you just sold one seat twice.

The only variable in WorldSeat is **which AWS database executes that code**:

- **Aurora DSQL** — distributed SQL, multi-region active-active, *serializable* isolation enforced by optimistic concurrency control (OCC). When two transactions conflict, one commits and the other aborts with `OC001`/`40001`. The app catches it, retries, re-reads `sold`, and correctly rejects the second buyer.
- **DynamoDB Global Tables** — multi-region, *eventually consistent*, last-writer-wins. Two buyers in two regions each read `available` from their local replica and each write their own `sold`. Both succeed. Replication later reconciles to a single owner on the seats table — which quietly *hides* the damage — but the append-only sales ledger remembers that two different people were each told "you got it."

Here is the live result from the committed stress test (`node scripts/stress.mjs`), hammering seat A1 at escalating concurrency against the production deployment:

```
Aurora DSQL (strong / serializable OCC):
  c= 8  confirmed=1  oversold=0
  c=24  confirmed=1  oversold=0   maxRetries=1
  c=48  confirmed=1  oversold=0   maxRetries=1
  c=60  confirmed=1  oversold=0   maxRetries=1

DynamoDB Global Tables (eventual / LWW):
  c= 8  confirmed= 8  oversold= 7
  c=24  confirmed=12  oversold=11
  c=60  confirmed=33  oversold=32
```

Same code. Same seat. Same concurrency. The database's consistency model is the entire difference between *one* ticket and *thirty-three*.

A note on `maxRetries`, because honesty cuts both ways: it is *timing-dependent*, and a perfectly correct run can show **0**. When a late buyer's transaction begins after the winner has already committed, it simply reads `sold` and rejects cleanly — no commit conflict, no retry needed. A non-zero `maxRetries` means two commits genuinely interleaved and OCC aborted the loser. **Either path yields oversold = 0** — that's the claim. The retry counter is supporting evidence that a real race sometimes occurs under the hood, not the headline; the headline is the invariant.

## Why "oversold" is counted from committed state, not hope

It would be easy — and dishonest — to count oversells from what the app *thinks* happened (how many requests returned `confirmed`). Application return values lie under partition and retry. So WorldSeat never trusts them. The `oversold` number is computed by reading the **committed ground truth**:

- On DSQL, a `SELECT count(*) FROM op_log WHERE seat_id=$1 AND outcome='confirmed'`.
- On DynamoDB, a strongly-consistent scan of the sales ledger across *both* regional replicas, unioned and de-duplicated by a globally-unique `sale_id`, so cross-region replication lag can't undercount.

`oversold = confirmed_in_committed_ledger − 1`. One real seat; everything beyond one is a person who will show up to a venue and find someone already sitting there.

## What this teaches that a slide can't

The reason ticketing on-sales melt down — the reason "I had it in my cart and then it was gone" is a universal experience — is precisely this race, at the scale of a stadium and the speed of a fan base refreshing in unison. WorldSeat lets you feel the difference between a database that *serializes the stampede for you* and one that makes you, the application developer, responsible for inventing correctness on top of eventual consistency.

DSQL's value here isn't "it's fast" or "it's managed." It's that it lets you write the *naive, obvious* code and still be correct under a worldwide simultaneous on-sale — and you can watch it hold the line, live, at sixty concurrent buyers across two regions, by pressing a button.

Try it: **https://worldseat.vercel.app** — buy a seat, then break it.
