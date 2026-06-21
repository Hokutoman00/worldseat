import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'WorldSeat — Proof',
  description: 'One page a judge can use to verify every WorldSeat claim: measured oversold=0 on Aurora DSQL, the foil that oversells, live stress test, and AWS console proof.',
};

const STRESS = `WorldSeat stress test → https://worldseat.vercel.app

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

RESULT: PASS — invariant held on DSQL at every concurrency level; foil reproduced oversell.`;

export default function EvidencePage() {
  return (
    <div className="wrap proof">
      <header className="masthead">
        <h1>WorldSeat<span className="dot">.</span> <span className="proofkicker">Proof panel</span></h1>
        <p className="lede">
          <b>Submitted database: Amazon Aurora DSQL.</b> DynamoDB Global Tables appears only as an
          educational comparison foil — remove it and every product feature still runs on Aurora DSQL
          alone. Every number on this page is <b>measured</b>, not asserted, and links to something
          runnable or viewable.
        </p>
        <p className="proofnav">
          <Link href="/">← back to the live app</Link>
          <span className="sep">·</span>
          <a href="https://worldseat.vercel.app" target="_blank" rel="noreferrer">live app</a>
          <span className="sep">·</span>
          <a href="https://youtu.be/2OD3Ye1jEqo" target="_blank" rel="noreferrer">demo video (2:57)</a>
          <span className="sep">·</span>
          <a href="https://github.com/Hokutoman00/worldseat" target="_blank" rel="noreferrer">source repo</a>
        </p>
      </header>

      <section className="panel proofsec">
        <h2>1 · The headline, measured</h2>
        <p className="proofp">Same naive read-then-write code on both backends; the only variable is the database.</p>
        <div className="hero">
          <div className="herocell ok">
            <div className="herok">Aurora DSQL<span className="herotag">product</span></div>
            <div className="herov">0</div>
            <div className="herou">oversold · 60 simultaneous buyers, one seat</div>
            <div className="heron">every single run · Linearizable ✓</div>
          </div>
          <div className="herovs">same code<br />only the database<br />changed</div>
          <div className="herocell bad">
            <div className="herok">DynamoDB GT<span className="herotag">foil</span></div>
            <div className="herov">48</div>
            <div className="herou">oversold · 60 simultaneous buyers, one seat</div>
            <div className="heron">this run · eventual consistency, always &gt; 0 · Violated ✗</div>
          </div>
        </div>
      </section>

      <section className="panel proofsec">
        <h2>2 · Falsifiable invariant test (live)</h2>
        <p className="proofp">
          <code>node scripts/stress.mjs</code> hammers the live deployment at concurrency 8/24/48/60 and
          asserts <code>oversold === 0</code> on DSQL at every level, and <code>oversold &gt; 0</code> on
          the foil. Captured 2026-06-21:
        </p>
        <pre className="proofpre">{STRESS}</pre>
        <p className="proofp">
          The <code>maxRetries = 1</code> on DSQL is the proof that two commits genuinely interleaved and
          the loser was <i>aborted by serializability</i> — not that the app got lucky. The foil&apos;s
          oversold count is genuinely run-to-run variable under last-writer-wins (48 captured · 41 on an
          independent recheck); what never varies is the pair <b>DSQL = 0 / foil &gt; 0</b>.
        </p>
      </section>

      <section className="panel proofsec">
        <h2>3 · Why it can&apos;t be rigged in DSQL&apos;s favor</h2>
        <ul className="prooful">
          <li><b>Identical app code on both backends</b> — read-then-write with no app-level lock and no
            conditional update (<code>app/lib/dsql.ts</code>, <code>app/lib/ddb.ts</code>). Only the
            database executing it differs.</li>
          <li><b><code>oversold</code> counted from committed ground truth</b>, never app return values —
            the DSQL <code>op_log</code> and the append-only DynamoDB <code>sales_naive</code> ledger
            (<code>app/app/api/breakit/route.ts</code>).</li>
          <li><b>Three independent sources</b> shown in the UI: app-believed / ledger-committed /
            seats-table-shows. Last-writer-wins converges the seats table to one owner and <i>hides</i> the
            damage; the ledger remembers that N people were each told &ldquo;you got it.&rdquo; The gap is
            the corruption.</li>
        </ul>
      </section>

      <section className="panel proofsec">
        <h2>4 · AWS console proof <span className="proofmask">account ID masked</span></h2>
        <figure className="prooffig">
          <img src="/aws-dsql-us-east-1.png" alt="Aurora DSQL cluster ACTIVE in us-east-1, peered to us-east-2, witness us-west-2" />
          <figcaption>Aurora DSQL cluster <b>ACTIVE</b> in us-east-1, peered to us-east-2, witness region us-west-2.</figcaption>
        </figure>
        <figure className="prooffig">
          <img src="/aws-dynamodb-globaltable.png" alt="DynamoDB seats_naive Global Table with two ACTIVE regional replicas" />
          <figcaption>DynamoDB <code>seats_naive</code> Global Table with two ACTIVE regional replicas (the foil).</figcaption>
        </figure>
        <figure className="prooffig">
          <img src="/architecture.png" alt="System diagram: Vercel frontend to backend toggle to Aurora DSQL or DynamoDB GT" />
          <figcaption>Architecture — Vercel (one public URL) → backend toggle → Aurora DSQL (product) / DynamoDB GT (foil).</figcaption>
        </figure>
      </section>

      <section className="panel proofsec">
        <h2>5 · Everything in one place</h2>
        <div className="prooflinks">
          <a href="https://worldseat.vercel.app" target="_blank" rel="noreferrer">▶ Live app (no login)</a>
          <a href="https://youtu.be/2OD3Ye1jEqo" target="_blank" rel="noreferrer">▶ Demo video — 2:57</a>
          <a href="https://github.com/Hokutoman00/worldseat" target="_blank" rel="noreferrer">▶ Public source repo</a>
          <a href="https://github.com/Hokutoman00/worldseat/blob/master/EVIDENCE.md" target="_blank" rel="noreferrer">▶ EVIDENCE.md (this page, in repo)</a>
          <a href="https://github.com/Hokutoman00/worldseat/blob/master/scripts/stress.mjs" target="_blank" rel="noreferrer">▶ stress.mjs (the invariant test)</a>
        </div>
      </section>
    </div>
  );
}
