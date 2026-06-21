'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Backend, Seat, BreakItResult, WitnessVerdict, Ticket } from '@/lib/types';

const ROWS = 'ABCDEFGH'.split('');
const COLS = 12;
const FACE = 150; // ticket face value (USD) — turns "oversold" into the money/human stakes a judge feels
// A real naive (DynamoDB GT) Break-it run captured live on this deployment, 2026-06-21:
// 60 simultaneous buyers on one seat -> 48 oversold (eventual consistency / last-writer-wins).
// Shown as a clearly-labelled, dimmed preview so the punchline is legible BEFORE anyone clicks —
// a fresh Break-it replaces it with live numbers. Honest: measured, not invented. DSQL is invariably
// 0; the foil's oversold count varies run to run but is always > 0.
const EX = { buyers: 60, oversold: 48, confirmed: 49, ledger: 49, seatTableShows: 1, hidden: 48, seat: 'A1' };

export default function Page() {
  const [backend, setBackend] = useState<Backend>('dsql');
  const [seats, setSeats] = useState<Record<string, Seat>>({});
  const [target, setTarget] = useState('A1');
  const [concurrency, setConcurrency] = useState(24);
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<BreakItResult | null>(null);
  const [witness, setWitness] = useState<WitnessVerdict | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [buyer, setBuyer] = useState('');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [confirm, setConfirm] = useState<{ seat: string; code: string } | null>(null);

  const push = (m: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 40));

  // Give every visitor a stable guest id (set after mount to avoid a hydration mismatch).
  useEffect(() => { setBuyer((b) => b || `guest-${Math.random().toString(36).slice(2, 7)}`); }, []);

  const loadSeats = useCallback(async (b: Backend) => {
    setErr(null);
    const r = await fetch(`/api/seats?backend=${b}`, { cache: 'no-store' });
    const j = await r.json();
    if (j.error) { setErr(j.error); return; }
    const map: Record<string, Seat> = {};
    for (const s of j.seats as Seat[]) map[s.seat_id] = s;
    setSeats(map);
  }, []);

  const loadTickets = useCallback(async (b: Backend, who: string) => {
    if (!who) { setTickets([]); return; }
    const r = await fetch(`/api/tickets?backend=${b}&buyer=${encodeURIComponent(who)}`, { cache: 'no-store' });
    const j = await r.json();
    if (!j.error) setTickets((j.tickets || []) as Ticket[]);
  }, []);

  useEffect(() => { loadSeats(backend); setLast(null); setWitness(null); setConfirm(null); }, [backend, loadSeats]);
  useEffect(() => { if (buyer) loadTickets(backend, buyer); }, [backend, buyer, loadTickets]);

  const switchBackend = (b: Backend) => { if (b !== backend && !busy) setBackend(b); };

  const reset = async () => {
    setBusy('reset'); setErr(null); setLast(null); setWitness(null); setConfirm(null);
    try {
      const r = await fetch('/api/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend }) });
      const j = await r.json();
      if (j.error) setErr(j.error); else push(`reset — ${j.reset} seats available`);
      await loadSeats(backend);
      await loadTickets(backend, buyer);
    } finally { setBusy(null); }
  };

  const buyOne = async (seat: string) => {
    if (busy || seats[seat]?.status === 'sold') return;
    setBusy('buy'); setErr(null);
    try {
      const r = await fetch('/api/purchase', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend, seat, buyer }) });
      const j = await r.json();
      if (j.error) { setErr(j.error); return; }
      setFlash(seat); setTimeout(() => setFlash(null), 500);
      push(`buy ${seat} — ${j.outcome}${j.attempts ? ` (${j.attempts} attempt${j.attempts > 1 ? 's' : ''})` : ''}`);
      if (j.outcome === 'confirmed' && j.ticketId) setConfirm({ seat, code: String(j.ticketId) });
      else if (j.outcome === 'rejected') { setConfirm(null); setErr(`seat ${seat} is already taken — pick another`); }
      await loadSeats(backend);
      await loadTickets(backend, buyer);
    } finally { setBusy(null); }
  };

  const breakIt = async () => {
    setBusy('break'); setErr(null); setWitness(null);
    push(`break-it: ${concurrency} simultaneous buyers on seat ${target} (both regions)`);
    try {
      const r = await fetch('/api/breakit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ backend, seat: target, concurrency }) });
      const j = await r.json();
      if (j.error) { setErr(j.error); return; }
      setLast(j as BreakItResult);
      push((j as BreakItResult).verdict);
      await loadSeats(backend);
      const w = await fetch(`/api/witness?backend=${backend}&seat=${encodeURIComponent(target)}`, { cache: 'no-store' }).then((x) => x.json());
      if (!w.error) setWitness(w as WitnessVerdict);
    } finally { setBusy(null); }
  };

  const soldCount = useMemo(() => Object.values(seats).filter((s) => s.status === 'sold').length, [seats]);

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>WorldSeat<span className="dot">.</span></h1>
        <div className="hero">
          <div className="herocell ok">
            <div className="herok">Aurora DSQL<span className="herotag">product</span></div>
            <div className="herov">0</div>
            <div className="herou">oversold · 60 simultaneous buyers, one seat</div>
            <div className="heron">every single run</div>
          </div>
          <div className="herovs">same code<br />only the database<br />changed</div>
          <div className="herocell bad">
            <div className="herok">DynamoDB GT<span className="herotag">foil</span></div>
            <div className="herov">48</div>
            <div className="herou">oversold · 60 simultaneous buyers, one seat</div>
            <div className="heron">this run · eventual consistency, always &gt; 0</div>
          </div>
        </div>
        <p className="lede">
          One AWS database — <b>Amazon Aurora DSQL</b> — holding a worldwide ticket on-sale together.
          The <b>DynamoDB</b> toggle is a <b>comparison foil</b> that runs the identical code so you can
          watch eventual consistency oversell the same seat. It is not part of the product: remove the
          foil and every feature — seat map, buy, My&nbsp;tickets, Break-it, the Witness — still runs on
          DSQL alone.
        </p>
        <p>
          A worldwide ticket on-sale where one seat must sell to exactly one fan. <b>Click any open
          seat to buy it</b> — you get a confirmation code and it appears under <span className="kbd">My
          tickets</span>. Then press <span className="kbd">Break it</span> to simulate a real on-sale
          stampede: dozens of fans hitting the same seat in the same second from two regions. The
          contrast is honest — <b>both backends run the same naive read-then-write code</b>; only the
          database&apos;s consistency model decides whether that seat gets sold twice.
        </p>
      </header>

      <div className="toolbar">
        <div className="tgroup">
          <span className="tlabel">Backend</span>
          <div className="seg">
            <button className={`dsql ${backend === 'dsql' ? 'on dsql' : ''}`} onClick={() => switchBackend('dsql')}>
              Aurora DSQL · strong
            </button>
            <button className={`naive ${backend === 'naive' ? 'on naive' : ''}`} onClick={() => switchBackend('naive')}
              title="Comparison foil — not the product database. Same naive code, eventual consistency, so you can watch it oversell.">
              DynamoDB GT · foil
            </button>
          </div>
          <label className="field">you
            <input className="wide" value={buyer} onChange={(e) => setBuyer(e.target.value)} placeholder="your name" />
          </label>
        </div>

        <div className="tdiv" />

        <div className="tgroup">
          <span className="tlabel">Stress test</span>
          <label className="field">seat
            <input value={target} onChange={(e) => setTarget(e.target.value.toUpperCase())} />
          </label>
          <label className="field">buyers
            <input type="number" min={2} max={60} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} />
          </label>
          <button className="btn danger" disabled={!!busy} onClick={breakIt}>
            {busy === 'break' ? 'breaking…' : 'Break it'}
          </button>
          <button className="btn" disabled={!!busy} onClick={reset}>{busy === 'reset' ? 'resetting…' : 'Reset floor'}</button>
        </div>
      </div>
      <p className="subnote">2-region active-active · us-east-1 + us-east-2 — click any open seat to buy it, or fire a stampede at one seat with <span className="kbd">Break it</span> →</p>

      {err && <div className="err">error: {err}</div>}

      <div className="grid2">
        <section className="panel">
          <h2>The floor · {soldCount} sold / {ROWS.length * COLS}</h2>
          <div className="stage">— STAGE —</div>
          <div className="rows">
            {ROWS.map((row) => (
              <div className="row" key={row}>
                <span className="rowlab">{row}</span>
                {Array.from({ length: COLS }, (_, i) => {
                  const id = `${row}${i + 1}`;
                  const s = seats[id];
                  const sold = s?.status === 'sold';
                  const cls = ['seat', sold ? 'sold' : '', id === target ? 'target' : '', id === flash ? 'flash' : ''].join(' ').trim();
                  return (
                    <button key={id} className={cls} disabled={!!busy || sold}
                      title={sold ? `${id} — sold to ${s?.owner ?? '?'}` : `${id} — click to buy`}
                      onClick={() => buyOne(id)}>
                      {i + 1}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="legend">
            <span><i style={{ background: 'var(--panel-2)', border: '1px solid var(--line)' }} />available</span>
            <span><i style={{ background: '#20262e' }} />sold</span>
            <span><i style={{ background: 'transparent', outline: '2px solid var(--accent)' }} />Break-it target (type one in <b>target</b> above)</span>
          </div>

          {confirm && (
            <div className="confirm">
              <span className="tag">✓ Ticket confirmed — seat {confirm.seat}</span>
              <p>Confirmation code <code>{confirm.code}</code> · holder <b>{buyer}</b>. Read back from the committed ledger below, not app memory.</p>
            </div>
          )}

          <div className="tickets">
            <h2>My tickets · {buyer || '—'}</h2>
            {tickets.length === 0 ? (
              <p className="hint">No tickets yet. Click a seat and press <b>Buy</b>.</p>
            ) : (
              <ul>
                {tickets.map((t) => (
                  <li key={t.ticketId}>
                    <b>{t.seat_id}</b>
                    <code>{t.ticketId}</code>
                    {t.region && <span className="reg">{t.region}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <aside className="panel">
          <h2>Break-it scoreboard</h2>
          {last ? (
            <>
              <div className="score">
                <div className="cell"><div className="k">buyers fired</div><div className="v">{last.concurrency}</div></div>
                <div className="cell"><div className="k">oversold</div><div className={`v ${last.oversold === 0 ? 'zero' : 'over'}`}>{last.oversold}</div></div>
                <div className="cell"><div className="k">confirmed holders</div><div className="v">{last.confirmed}</div></div>
                <div className="cell"><div className="k">max OCC retries</div><div className="v">{last.maxRetries}</div></div>
              </div>
              <div className={`stakes ${last.oversold > 0 ? 'bad' : 'ok'}`}>
                {last.oversold > 0 ? (
                  <>
                    <b>${(last.oversold * FACE).toLocaleString()}</b> in duplicate sales. {last.oversold} fan{last.oversold === 1 ? '' : 's'} reach
                    the gate holding a valid code for seat {last.seat} — already filled. At ${FACE} a ticket that&apos;s refunds,
                    chargebacks and {last.oversold} ruined night{last.oversold === 1 ? '' : 's'}, <i>per seat, per second of the on-sale</i>.
                  </>
                ) : (
                  <>
                    <b>$0</b> in duplicate sales. All {last.confirmed} confirmed code{last.confirmed === 1 ? '' : 's'} map to {last.confirmed} real
                    seat{last.confirmed === 1 ? '' : 's'} — nobody is turned away at the gate. Same code, same stampede; the database is the only thing that changed.
                  </>
                )}
              </div>
              <div className={`verdict ${last.oversold === 0 ? 'lin' : 'vio'}`}>
                <span className="tag">{last.oversold === 0 ? 'oversold = 0' : `oversold = ${last.oversold}`}</span>
                <p>{last.verdict}</p>
                <div className="sources">
                  <div className="srchead">three independent sources for seat {last.seat}</div>
                  <div className="srcrow"><span>App believed (what the code thought it sold)</span><b>{last.appBelieved}</b></div>
                  <div className="srcrow"><span>Ledger committed (append-only ground truth)</span><b>{last.ledgerHolders}</b></div>
                  <div className="srcrow"><span>Seats table shows (what a fan would see)</span><b>{last.seatTableShows}</b></div>
                  <div className={`srcrow gap ${last.hiddenBySeatsTable > 0 ? 'bad' : 'ok'}`}>
                    <span>{last.hiddenBySeatsTable > 0 ? 'hidden by last-writer-wins' : 'all three agree — nothing hidden'}</span>
                    <b>{last.hiddenBySeatsTable}</b>
                  </div>
                </div>
                <p className="caption">
                  {last.hiddenBySeatsTable > 0
                    ? `The seats table displays ONE owner, so the app looks fine — but the ledger proves ${last.ledgerHolders} fans hold seat ${last.seat}. ${last.hiddenBySeatsTable} of them were silently overwritten and will collide at the venue. That gap is the corruption last-writer-wins hides.`
                    : last.maxRetries > 0
                      ? `All three sources agree at 1. OCC did real work: ${last.maxRetries} losing commit${last.maxRetries === 1 ? '' : 's'} hit a conflict, aborted, retried, re-read “sold”, and backed off. Serializable isolation, not app cleverness.`
                      : `All three sources agree at 1. Every late buyer simply read “sold” and was turned away — no commit conflict was even needed this run. Serializability, not guesswork.`}
                </p>
              </div>
            </>
          ) : (
            <div className="preview">
              <div className="pvbadge">Example · a real <b>DynamoDB GT · eventual</b> run (60 buyers, one seat) — press <span className="kbd">Break it</span> for your own live numbers</div>
              <div className="score">
                <div className="cell"><div className="k">buyers fired</div><div className="v">{EX.buyers}</div></div>
                <div className="cell"><div className="k">oversold</div><div className="v over">{EX.oversold}</div></div>
                <div className="cell"><div className="k">confirmed holders</div><div className="v">{EX.confirmed}</div></div>
                <div className="cell"><div className="k">max OCC retries</div><div className="v">0</div></div>
              </div>
              <div className="stakes bad">
                <b>${(EX.oversold * FACE).toLocaleString()}</b> in duplicate sales. {EX.oversold} fans reach the gate
                holding a valid code for one seat already filled — refunds, chargebacks and {EX.oversold} ruined
                nights, <i>per seat, per second of the on-sale</i>.
              </div>
              <div className="sources">
                <div className="srchead">three independent sources for seat {EX.seat}</div>
                <div className="srcrow"><span>App believed (what the code thought it sold)</span><b>{EX.confirmed}</b></div>
                <div className="srcrow"><span>Ledger committed (append-only ground truth)</span><b>{EX.ledger}</b></div>
                <div className="srcrow"><span>Seats table shows (what a fan would see)</span><b>{EX.seatTableShows}</b></div>
                <div className="srcrow gap bad"><span>hidden by last-writer-wins</span><b>{EX.hidden}</b></div>
              </div>
              <div className="ab">
                <div className="abcell ok"><div className="abk">Aurora DSQL · strong <span className="abtag">product</span></div><div className="abv">0</div><div className="abu">oversold</div></div>
                <div className="abx">vs</div>
                <div className="abcell bad"><div className="abk">DynamoDB GT · eventual <span className="abtag">foil</span></div><div className="abv">{EX.oversold}</div><div className="abu">oversold</div></div>
              </div>
              <p className="hint">Identical code, same stampede — <b>only the database changed</b>. Hit <b>Break it</b> to reproduce either, live.</p>
            </div>
          )}

          {witness && (
            <div className={`verdict ${witness.linearizable ? 'lin' : 'vio'}`} style={{ marginTop: 12 }}>
              <span className="tag">Consistency Witness: {witness.verdict}</span>
              {witness.focus && (
                (() => {
                  const f = witness.focus!;
                  const hidden = f.hidden > 0;
                  return (
                    <p className={`reconcile ${hidden ? 'bad' : 'ok'}`}>
                      {hidden ? '✗ corruption proven' : '✓ cross-checked'} — seat {f.seat_id}: the committed ledger holds{' '}
                      <b>{f.confirmed}</b> buyer{f.confirmed === 1 ? '' : 's'}, but the seats table — a different table —
                      displays <b>{f.seatTableShows}</b> owner{f.seatTableShows === 1 ? '' : 's'}.{' '}
                      {hidden
                        ? <>That {f.hidden}-holder gap is real double-selling the app’s own screen hides.</>
                        : <>Two independent tables agree: exactly one holder. No double-sell to hide.</>}
                    </p>
                  );
                })()
              )}
              <p>{witness.explanation}</p>
              <p style={{ color: 'var(--faint)' }}>
                Jepsen-lite — computed from {witness.seatsChecked} seat histor{witness.seatsChecked === 1 ? 'y' : 'ies'} in the
                committed ledger, not from app-side hope.
                {witness.doubleSells !== (witness.focus?.oversold ?? witness.doubleSells) && (
                  <> Floor-wide this session: <b>{witness.doubleSells}</b> double-sell{witness.doubleSells === 1 ? '' : 's'} across {witness.violations.length} seat{witness.violations.length === 1 ? '' : 's'} (Reset floor to clear).</>
                )}
              </p>
            </div>
          )}

          <div className="log">
            {busy && <div className="busy">▌ {busy}…</div>}
            {log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </aside>
      </div>

      <div className="honesty">
        <b>Honesty guard.</b> <code>oversold</code> is counted straight from committed table state — the
        DSQL <code>op_log</code> and the append-only DynamoDB <code>sales_naive</code> ledger — never from
        what the app hoped happened. The naive seats table shows a single owner (last-writer-wins hides the
        damage); the ledger is the ground truth of how many people really hold that one seat.
        Dollar figures multiply that measured oversold count by a <b>$150</b> face value — a representative
        major-event ticket price; it scales linearly, so the exact dollar amount is illustrative while the
        oversold count itself is the measured fact.
      </div>
    </div>
  );
}
