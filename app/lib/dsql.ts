// Aurora DSQL backend (the hero: multi-region, strong consistency, OCC).
// The purchase logic is DELIBERATELY the same naive read-then-write the DynamoDB foil uses.
// The ONLY thing that prevents oversell here is DSQL's serializable isolation: concurrent
// conflicting commits abort the loser (OCC) -> the app retries -> it now reads 'sold' -> rejects.
import { Pool, PoolClient } from 'pg';
import { DsqlSigner } from '@aws-sdk/dsql-signer';
import { DSQL, awsCreds, allSeatIds } from './config';
import type { Seat, PurchaseResult, Ticket } from './types';

const MAX_RETRY = 25;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function adminToken(host: string, region: string): Promise<string> {
  const signer = new DsqlSigner({ hostname: host, region, credentials: awsCreds() as any });
  return await signer.getDbConnectAdminAuthToken();
}

// One pool per request (serverless). max bounds concurrent DSQL connections for Break-it.
export async function makePool(max = 10, which: 'A' | 'B' = 'A'): Promise<Pool> {
  const host = which === 'A' ? DSQL.hostA : DSQL.hostB;
  const region = which === 'A' ? DSQL.regionA : DSQL.regionB;
  const password = await adminToken(host, region);
  return new Pool({
    host, port: 5432, database: 'postgres', user: 'admin', password,
    ssl: { rejectUnauthorized: false },
    max, idleTimeoutMillis: 5000, connectionTimeoutMillis: 15000,
  });
}

function isOcc(e: any): boolean {
  const code = (e && e.code) || '';
  const msg = String((e && e.message) || e || '');
  return code === '40001' || code === '40P01' || String(code).startsWith('OC') ||
         /OC0|serializ|concurrent|conflict/i.test(msg);
}

export async function ensureSchema(pool: Pool): Promise<void> {
  const c = await pool.connect();
  try {
    // DSQL runs each DDL as its own implicit transaction (no BEGIN wrapper).
    await c.query(`CREATE TABLE IF NOT EXISTS seats (seat_id TEXT PRIMARY KEY, status TEXT NOT NULL, owner TEXT, sold_at TIMESTAMPTZ)`);
    await c.query(`CREATE TABLE IF NOT EXISTS op_log (id TEXT PRIMARY KEY, seat_id TEXT, buyer TEXT, outcome TEXT, attempts INT, t_start DOUBLE PRECISION, t_end DOUBLE PRECISION)`);
  } finally { c.release(); }
}

export async function reset(pool: Pool, seats?: string[]): Promise<number> {
  await ensureSchema(pool);
  const ids = seats && seats.length ? seats : allSeatIds();
  const c = await pool.connect();
  try {
    await c.query('DELETE FROM op_log');
    await c.query('DELETE FROM seats');
    // batch insert
    const values = ids.map((_, i) => `($${i + 1}, 'available')`).join(',');
    await c.query(`INSERT INTO seats (seat_id, status) VALUES ${values}`, ids);
    return ids.length;
  } finally { c.release(); }
}

// Free a single seat back to 'available' (used before a Break-it burst on that seat).
export async function freeSeat(pool: Pool, seat: string): Promise<void> {
  await ensureSchema(pool);
  const c = await pool.connect();
  try {
    await c.query(`INSERT INTO seats (seat_id, status, owner, sold_at) VALUES ($1,'available',NULL,NULL)
                   ON CONFLICT (seat_id) DO UPDATE SET status='available', owner=NULL, sold_at=NULL`, [seat]);
    await c.query('DELETE FROM op_log WHERE seat_id=$1', [seat]);
  } finally { c.release(); }
}

export async function getSeats(pool: Pool): Promise<Seat[]> {
  await ensureSchema(pool);
  const c = await pool.connect();
  try {
    const r = await c.query('SELECT seat_id, status, owner FROM seats ORDER BY seat_id');
    return r.rows as Seat[];
  } finally { c.release(); }
}

// NAIVE read-then-write. DSQL's OCC must serialize concurrent buyers of the same seat.
export async function purchase(pool: Pool, seat: string, buyer: string, region: string): Promise<PurchaseResult> {
  const client: PoolClient = await pool.connect();
  const t0 = Date.now();
  let attempts = 0;
  let outcome: PurchaseResult['outcome'] = 'error';
  try {
    while (true) {
      attempts++;
      try {
        await client.query('BEGIN');
        const r = await client.query('SELECT status FROM seats WHERE seat_id=$1', [seat]);
        const status = r.rows[0]?.status;
        if (status !== 'available') { await client.query('ROLLBACK'); outcome = 'rejected'; break; }
        // naive: write without a status guard in the WHERE clause -> rely on the DB, not app cleverness
        await client.query('UPDATE seats SET status=$1, owner=$2, sold_at=now() WHERE seat_id=$3', ['sold', buyer, seat]);
        await client.query('COMMIT');
        outcome = 'confirmed'; break;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch {}
        if (isOcc(e) && attempts < MAX_RETRY) { await sleep(8 * attempts); continue; }
        outcome = 'error'; break;
      }
    }
    const t1 = Date.now();
    const opId = `${seat}#${buyer}#${t1}#${Math.random().toString(36).slice(2)}`;
    try {
      await client.query(
        'INSERT INTO op_log (id, seat_id, buyer, outcome, attempts, t_start, t_end) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [opId, seat, buyer, outcome, attempts, t0, t1]
      );
    } catch {}
    return { outcome, attempts, region, buyer, seat, ms: t1 - t0, ticketId: outcome === 'confirmed' ? opId : undefined };
  } finally {
    client.release();
  }
}

// Owners the mutable seats table currently DISPLAYS for this seat (0 available / 1 sold). On DSQL
// this equals the ledger holder count (serializability lets exactly one buyer win), so the seats
// table and the ledger AGREE — the cross-source check passes honestly instead of by construction.
export async function seatTableOwnerCount(pool: Pool, seat: string): Promise<number> {
  await ensureSchema(pool);
  const c = await pool.connect();
  try {
    const r = await c.query(`SELECT 1 FROM seats WHERE seat_id=$1 AND status='sold' AND owner IS NOT NULL`, [seat]);
    return r.rowCount ?? 0;
  } finally { c.release(); }
}

// A buyer's real tickets, read back from the committed op_log (ground truth — not app memory).
export async function ticketsByBuyer(pool: Pool, buyer: string): Promise<Ticket[]> {
  await ensureSchema(pool);
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT id, seat_id, t_end FROM op_log WHERE buyer=$1 AND outcome='confirmed' ORDER BY t_end`,
      [buyer]
    );
    return r.rows.map((row: any) => ({ seat_id: row.seat_id, ticketId: row.id, ts: Number(row.t_end) }));
  } finally { c.release(); }
}
