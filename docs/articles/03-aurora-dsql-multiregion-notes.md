# Building on Aurora DSQL multi-region: the setup notes I wish I'd had

> Target: Medium · ~750 words · WorldSeat / Hack the Zero Stack

I built WorldSeat — a worldwide ticket on-sale that sells one seat to exactly one fan — on **Aurora DSQL** running active-active across two AWS regions. DSQL gave me the one property the whole app depends on: serializable isolation, so naive read-then-write code stays correct under a simultaneous global stampede. Here are the concrete, load-bearing details that aren't obvious from the headline, written down so the next builder spends those hours elsewhere.

## 1. A multi-region cluster needs a *witness* region, and starts life PENDING

You don't just flip a "multi-region" switch. You create one cluster per active region and bind them with a third **witness** region that holds no endpoint but participates in the quorum:

```bash
# region A (active), declaring the witness
aws dsql create-cluster --region us-east-1 \
  --multi-region-properties '{"witnessRegion":"us-west-2"}'
# -> status: PENDING_SETUP

# region B (active), same witness
aws dsql create-cluster --region us-east-2 \
  --multi-region-properties '{"witnessRegion":"us-west-2"}'
```

Each cluster comes up **PENDING_SETUP** and stays there until you peer them. They do not become `ACTIVE` on their own — that surprised me, and it's the first place to look if a cluster seems stuck.

## 2. Peering is a mutual, per-ARN permission

You update each cluster to add the other as a peer ARN. The gotcha: `dsql:AddPeerCluster` is authorized **per peer ARN**, so your IAM policy has to allow the action against the specific cluster ARNs you're peering, not just `dsql:*` on a wildcard you forgot to include. Once both sides reference each other, both flip to `ACTIVE`. Connect to each *regional* endpoint; the witness region has none.

The full IAM set I needed, beyond the default:

```
dsql:CreateCluster  dsql:GetCluster  dsql:UpdateCluster
dsql:AddPeerCluster dsql:DeleteCluster dsql:ListClusters
dsql:DbConnect      dsql:DbConnectAdmin
```

## 3. Auth is an IAM token, not a stored password

DSQL speaks the PostgreSQL wire protocol on port 5432, but you don't manage a password. You mint a short-lived IAM auth token at connect time and hand it to your Postgres driver as the password:

```ts
import { Pool } from 'pg';
import { DsqlSigner } from '@aws-sdk/dsql-signer';

const signer = new DsqlSigner({ hostname: host, region, credentials });
const token  = await signer.getDbConnectAdminAuthToken();

const pool = new Pool({
  host, port: 5432, database: 'postgres', user: 'admin',
  password: token,
  ssl: { rejectUnauthorized: false },
  max, idleTimeoutMillis: 5000, connectionTimeoutMillis: 15000,
});
```

In a serverless deployment (mine runs on Vercel Route Handlers) I mint a fresh pool per request and bound `max` to the burst size, so a "fire 60 buyers at one seat" test maps to a controlled number of real connections.

## 4. DDL has no BEGIN wrapper — each statement is its own transaction

Coming from vanilla Postgres I tried to wrap schema creation in a transaction. DSQL runs each DDL statement as its own implicit transaction, so just issue them directly:

```ts
await c.query(`CREATE TABLE IF NOT EXISTS seats (
  seat_id TEXT PRIMARY KEY, status TEXT NOT NULL, owner TEXT, sold_at TIMESTAMPTZ)`);
await c.query(`CREATE TABLE IF NOT EXISTS op_log (
  id TEXT PRIMARY KEY, seat_id TEXT, buyer TEXT, outcome TEXT,
  attempts INT, t_start DOUBLE PRECISION, t_end DOUBLE PRECISION)`);
```

## 5. The OCC retry loop is the whole point — write it on purpose

DSQL enforces serializability with optimistic concurrency control. When two transactions touch the same row and race to commit, one wins and the other **aborts** with an OCC error (SQLSTATE `40001`/`40P01`, or an `OC###` code). This is not a failure to paper over — it's the mechanism doing its job. Catch it, back off, retry; on retry the loser re-reads the now-`sold` row and correctly rejects:

```ts
catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  if (isOcc(e) && attempts < MAX_RETRY) { await sleep(8 * attempts); continue; }
  throw e;
}
```

`isOcc` matches `40001`, `40P01`, codes starting with `OC`, and `/serializ|concurrent|conflict/i` in the message. With that loop in place, the *naive, unguarded* `UPDATE seats SET status='sold'` — no conditional WHERE, no app-level lock — sells one seat exactly once under 60 concurrent cross-region buyers. The database did the hard part.

## What it bought me

Without DSQL, correctness under a worldwide on-sale would have been *my* code's problem: conditional writes, idempotency keys, a distributed lock, reconciliation jobs. With it, the safety property is a property of the database, and my application code got to stay honest and naive — which is exactly what made the side-by-side demo against DynamoDB Global Tables so stark.

Live: **https://worldseat.vercel.app** · the OCC retry count is shown right on the scoreboard.
