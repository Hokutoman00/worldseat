// Consistency Witness (Jepsen-lite). Linearizability of a ticket sale reduces to a simple,
// checkable invariant: for one physical seat there must be at most ONE successful exclusive
// acquisition. We compute the verdict from the REAL committed history (DSQL op_log / DynamoDB
// sales ledger) — never hardcoded. doubleSells = sum over seats of max(0, confirmed - 1).
import { makePool, seatTableOwnerCount as dsqlOwners } from './dsql';
import { salesBySeat, seatTableOwnerCount as ddbOwners } from './ddb';
import type { Backend, WitnessVerdict } from './types';

export async function witnessDsql(focusSeat?: string): Promise<WitnessVerdict> {
  const pool = await makePool(2);
  try {
    const c = await pool.connect();
    let rows: { seat_id: string; confirmed: number }[];
    try {
      const r = await c.query(
        `SELECT seat_id, count(*)::int AS confirmed FROM op_log WHERE outcome='confirmed' GROUP BY seat_id`
      );
      rows = r.rows as any;
    } finally { c.release(); }
    // Cross-source check: corroborate the committed ledger (rows) against a DIFFERENT table — the
    // mutable seats table — for the focus seat. Independent evidence, not a re-count of the ledger.
    const seatTableShows = focusSeat ? await dsqlOwners(pool, focusSeat) : 0;
    return buildVerdict('dsql', rows, focusSeat, seatTableShows);
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function witnessNaive(focusSeat?: string): Promise<WitnessVerdict> {
  const counts = await salesBySeat();
  const rows = [...counts.entries()].map(([seat_id, confirmed]) => ({ seat_id, confirmed }));
  const seatTableShows = focusSeat ? await ddbOwners(focusSeat) : 0;
  return buildVerdict('naive', rows, focusSeat, seatTableShows);
}

function buildVerdict(backend: Backend, rows: { seat_id: string; confirmed: number }[], focusSeat?: string, seatTableShows = 0): WitnessVerdict {
  const violations = rows.filter((r) => r.confirmed > 1).sort((a, b) => b.confirmed - a.confirmed);
  const doubleSells = violations.reduce((s, v) => s + (v.confirmed - 1), 0);
  const linearizable = doubleSells === 0;
  // Scope-matched view of the seat the Break-it scoreboard just measured. confirmed=0 if untouched.
  let focus: WitnessVerdict['focus'] = null;
  if (focusSeat) {
    const confirmed = rows.find((r) => r.seat_id === focusSeat)?.confirmed ?? 0;
    focus = { seat_id: focusSeat, confirmed, oversold: Math.max(0, confirmed - 1), seatTableShows, hidden: Math.max(0, confirmed - seatTableShows) };
  }
  return {
    backend,
    linearizable,
    doubleSells,
    seatsChecked: rows.length,
    violations: violations.slice(0, 20),
    focus,
    verdict: linearizable ? 'Linearizable ✓' : `Violated ✗ (${doubleSells} double-sell${doubleSells === 1 ? '' : 's'})`,
    explanation: linearizable
      ? 'Every seat in the recorded history was acquired by at most one buyer. Strong consistency held under concurrency.'
      : `${violations.length} seat(s) were each confirmed to more than one buyer. Multiple ticket holders exist for the same physical seat.`,
  };
}

export async function witness(backend: Backend, focusSeat?: string): Promise<WitnessVerdict> {
  return backend === 'dsql' ? witnessDsql(focusSeat) : witnessNaive(focusSeat);
}
