# A Jepsen-lite witness: prove "sold once" from committed history, not app hope

> Target: Dev.to · ~700 words · WorldSeat / Hack the Zero Stack

When you claim a system is correct under concurrency, the dangerous move is to ask the *application* whether it was correct. The app is the least trustworthy witness in the building: it reports what it *intended*, after retries, across a network that drops and reorders. If you count "how many purchase calls returned `confirmed`", you are grading the system on its own self-report. That's how demos lie without anyone meaning to lie.

WorldSeat — a worldwide ticket on-sale built for AWS's Hack the Zero Stack — answers the correctness question with an external checker instead. I call it the **Consistency Witness**, and it's deliberately Jepsen-shaped: it ignores what the app said and reconstructs the truth from the *committed history* in the database.

## The invariant, reduced to something checkable

Full linearizability checking is expensive. But the safety property a ticketing system actually needs collapses to one tiny invariant:

> For one physical seat, there is **at most one** successful exclusive acquisition.

That's it. If two different buyers each hold a confirmed claim to seat A1, the history is not linearizable — there is no single global order of operations in which both acquisitions of the same exclusive resource succeed. You don't need a full happens-before graph to detect it; you need to count confirmed acquisitions per seat.

So the witness does exactly that, against committed state:

```ts
// DSQL: read the committed op_log directly
SELECT seat_id, count(*)::int AS confirmed
FROM op_log
WHERE outcome = 'confirmed'
GROUP BY seat_id;

// then, for every seat:
doubleSells = Σ max(0, confirmed - 1)
linearizable = (doubleSells === 0)
```

`doubleSells` is the number of people who hold a ticket they shouldn't. Zero means every seat was acquired by at most one buyer; anything above zero names the seats with multiple holders.

For the DynamoDB foil the *source* changes but the logic doesn't: the witness reads the append-only sales ledger with `ConsistentRead: true` from **both** regional replicas and unions them, de-duplicated by a globally-unique `sale_id`, so cross-region replication lag can't make a double-sell disappear by simply not having arrived yet.

## Why read the ledger, not the seats table

This is the subtle part, and it's where eventual consistency hides its damage. On the naive DynamoDB backend, the `seats` table eventually converges to a *single* owner per seat — last-writer-wins overwrites the others. If you inspected only the seats table, the system would look *fine*: one seat, one owner. The oversell is invisible there.

The truth lives in the **append-only ledger**, which records every confirmation as it was issued. Three buyers were each told "you got A1" and each got a confirmation code; LWW later picked one to display, but three people are walking to the same chair. The witness reads the ledger precisely because it's the one place the system can't quietly forget what it promised.

## Reconciling two different measurements

WorldSeat shows two numbers that *look* like they should match but measure different scopes, and reconciling them honestly was a design point:

- The **Break-it scoreboard** measures the single seat the last burst targeted.
- The **Witness** sums double-sells across the *whole floor* (every seat with history).

If you've run several bursts on different seats, the floor-wide total is legitimately larger than the last seat's count. Rather than paper over that, the witness accepts an optional `?seat=` focus so it can report the *scope-matched* number for the targeted seat **and** the floor-wide total side by side — and the UI explicitly prints "✓ reconciled" only when scoreboard oversold equals the witness's focus count for that seat. Matching numbers you didn't engineer to match is the difference between a checker and a prop.

## The payoff

Because the verdict is computed from committed history every time you ask, it's not a stored boolean you can fake. On Aurora DSQL it reads **Linearizable ✓** after sixty concurrent buyers hit one seat across two regions. On DynamoDB Global Tables running the *same* code it reads **Violated ✗** and names the over-sold seats. The checker is the same; only the database's consistency model changed the verdict.

See it live: **https://worldseat.vercel.app** — press Break it, then read the Witness.
