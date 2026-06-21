export type Backend = 'dsql' | 'naive';

export interface Seat {
  seat_id: string;
  status: 'available' | 'sold';
  owner?: string | null;
  region?: string | null;
}

export interface PurchaseResult {
  outcome: 'confirmed' | 'rejected' | 'error';
  attempts?: number;
  region?: string;
  buyer?: string;
  ms?: number;
  seat?: string;
  ticketId?: string; // confirmation code = the committed ledger row id (only when confirmed)
}

export interface Ticket {
  seat_id: string;
  ticketId: string;
  region?: string;
  ts?: number;
}

export interface BreakItResult {
  backend: Backend;
  seat: string;
  concurrency: number;
  regions: string[];
  confirmed: number;        // ledger ground truth: distinct committed holders of this seat
  rejected: number;
  errors: number;
  oversold: number;         // confirmed - 1 (tickets sold beyond the single real seat)
  maxRetries: number;
  durationMs: number;
  outcomes: PurchaseResult[];
  verdict: string;
  // Three structurally-INDEPENDENT signals for the contested seat, so the honesty claim is
  // demonstrated (cross-source) rather than asserted (one source echoing itself):
  appBelieved: number;      // (1) app-side hope: outcomes the app code THOUGHT it confirmed
  ledgerHolders: number;    // (2) committed append-only ledger (== confirmed) = real harm
  seatTableShows: number;   // (3) distinct owners the mutable LWW *seats* table displays (0 or 1)
  hiddenBySeatsTable: number; // ledgerHolders - seatTableShows = double-sells the seats table HIDES
}

export interface WitnessVerdict {
  backend: Backend;
  linearizable: boolean;
  doubleSells: number;       // floor-wide, summed over every seat in the committed history
  seatsChecked: number;
  violations: { seat_id: string; confirmed: number }[];
  verdict: string;     // 'Linearizable ✓' | 'Violated ✗ (N double-sells)'
  explanation: string;
  // When the witness is queried with ?seat=, the scope-matched view of just that seat. The witness
  // corroborates the committed LEDGER (confirmed) against a STRUCTURALLY DIFFERENT table — the
  // mutable LWW seats table (seatTableShows) — so the verdict is independent evidence, not an echo
  // of the scoreboard's own ledger count. hidden = confirmed - seatTableShows.
  focus?: { seat_id: string; confirmed: number; oversold: number; seatTableShows: number; hidden: number } | null;
}
