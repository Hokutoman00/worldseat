import { NextRequest, NextResponse } from 'next/server';
import { makePool, freeSeat as dsqlFree, purchase as dsqlBuy, seatTableOwnerCount as dsqlOwners } from '@/lib/dsql';
import { freeSeat as ddbFree, purchase as ddbBuy, salesBySeat, seatTableOwnerCount as ddbOwners, NAIVE_REGIONS } from '@/lib/ddb';
import { DSQL } from '@/lib/config';
import type { Backend, BreakItResult, PurchaseResult } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Break-it: free ONE seat, then slam it with `concurrency` simultaneous buyers split across
// BOTH active-active regions. oversold is read from the COMMITTED ground truth (op_log / sales
// ledger), never from app-side hope. DSQL -> OCC serializes -> oversold 0. Naive GT -> eventual
// reads + LWW -> multiple confirmed holders -> oversold > 0.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const backend = (body.backend || 'dsql') as Backend;
  const seat: string = body.seat || 'A1';
  const concurrency: number = Math.min(Math.max(Number(body.concurrency) || 24, 2), 60);
  const t0 = Date.now();

  try {
    if (backend === 'dsql') {
      const poolA = await makePool(concurrency, 'A');
      const poolB = await makePool(concurrency, 'B');
      try {
        await dsqlFree(poolA, seat);
        const tasks: Promise<PurchaseResult>[] = [];
        for (let i = 0; i < concurrency; i++) {
          const useB = i % 2 === 1;
          const pool = useB ? poolB : poolA;
          const region = useB ? DSQL.regionB : DSQL.regionA;
          tasks.push(dsqlBuy(pool, seat, `buyer-${i}`, region));
        }
        const outcomes = await Promise.all(tasks);
        // ground truth: count confirmed rows in op_log for this seat
        const c = await poolA.connect();
        let confirmedTruth = 0;
        try {
          const r = await c.query(
            `SELECT count(*)::int AS n FROM op_log WHERE seat_id=$1 AND outcome='confirmed'`,
            [seat]
          );
          confirmedTruth = r.rows[0]?.n ?? 0;
        } finally { c.release(); }
        const seatTableShows = await dsqlOwners(poolA, seat); // 3rd source: the mutable seats table
        return NextResponse.json(summarize(backend, seat, concurrency, [DSQL.regionA, DSQL.regionB], outcomes, confirmedTruth, seatTableShows, t0));
      } finally {
        await poolA.end().catch(() => {});
        await poolB.end().catch(() => {});
      }
    }

    // naive DynamoDB Global Tables
    await ddbFree(seat);
    const tasks: Promise<PurchaseResult>[] = [];
    for (let i = 0; i < concurrency; i++) {
      const region = NAIVE_REGIONS[i % NAIVE_REGIONS.length];
      tasks.push(ddbBuy(seat, `buyer-${i}`, region));
    }
    const outcomes = await Promise.all(tasks);
    // ground truth: append-only ledger rows for this seat (LWW on the seats table hides the harm)
    const counts = await salesBySeat();
    const confirmedTruth = counts.get(seat) ?? 0;
    const seatTableShows = await ddbOwners(seat); // 3rd source: what the LWW seats table displays
    return NextResponse.json(summarize(backend, seat, concurrency, NAIVE_REGIONS, outcomes, confirmedTruth, seatTableShows, t0));
  } catch (e: any) {
    return NextResponse.json({ backend, seat, error: String(e?.message || e) }, { status: 500 });
  }
}

function summarize(
  backend: Backend, seat: string, concurrency: number, regions: string[],
  outcomes: PurchaseResult[], confirmedTruth: number, seatTableShows: number, t0: number
): BreakItResult {
  const confirmed = confirmedTruth; // from committed ground truth, not app hope
  const appBelieved = outcomes.filter((o) => o.outcome === 'confirmed').length; // app-side hope
  const rejected = outcomes.filter((o) => o.outcome === 'rejected').length;
  const errors = outcomes.filter((o) => o.outcome === 'error').length;
  const oversold = Math.max(0, confirmed - 1);
  const hiddenBySeatsTable = Math.max(0, confirmed - seatTableShows);
  const maxRetries = outcomes.reduce((m, o) => Math.max(m, (o.attempts || 1) - 1), 0);
  return {
    backend, seat, concurrency, regions,
    confirmed, rejected, errors, oversold, maxRetries,
    appBelieved, ledgerHolders: confirmed, seatTableShows, hiddenBySeatsTable,
    durationMs: Date.now() - t0, outcomes,
    verdict: oversold === 0
      ? `oversold = 0 — exactly one ticket for seat ${seat}, even under ${concurrency} simultaneous buyers across ${regions.length} regions.`
      : `oversold = ${oversold} — ${confirmed} buyers each hold a ticket for the single physical seat ${seat}.`,
  };
}
