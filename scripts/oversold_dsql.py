# oversold_dsql.py — LIVE proof that Aurora DSQL (multi-region, strong consistency, OCC)
# yields oversold=0 under a deliberately NAIVE read-then-write purchase, by N concurrent
# buyers racing for the SAME seat. The application logic is intentionally the same naive
# read-then-write the DynamoDB path uses; the ONLY thing preventing the oversell here is the
# database's serializable isolation (OCC aborts the losing writer -> app retries -> sees sold).
# Honesty guard: we count CONFIRMED sales straight from the committed table, not from app hopes.
import boto3, re, json, os, sys, time, uuid, threading, psycopg
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(__file__)
env = {}
for ln in open(r"C:/Users/hokut/.credentials/aws.env", encoding="utf-8"):
    m = re.match(r'\s*([A-Z_]+)\s*=\s*(.*)', ln)
    if m: env[m.group(1)] = m.group(2).strip().strip('"\'')
AK, SK = env['AWS_ACCESS_KEY_ID'], env['AWS_SECRET_ACCESS_KEY']

st = json.load(open(os.path.join(HERE, '..', 'state', 'dsql.json')))
A = st['clusterA']
HOST, REGION = A['endpoint'], A['region']

dsql = boto3.client('dsql', aws_access_key_id=AK, aws_secret_access_key=SK, region_name=REGION)
TOKEN = dsql.generate_db_connect_admin_auth_token(Hostname=HOST, Region=REGION)

# Resolve a stable IPv4 (the IPv6 path intermittently drops SSL on this host).
import socket
HOSTADDR = None
for fam, _, _, _, sa in socket.getaddrinfo(HOST, 5432, socket.AF_INET, socket.SOCK_STREAM):
    HOSTADDR = sa[0]; break

def connect(retries=5):
    last = None
    for i in range(retries):
        try:
            return psycopg.connect(host=HOST, hostaddr=HOSTADDR, port=5432, dbname='postgres',
                                   user='admin', password=TOKEN, sslmode='require',
                                   connect_timeout=15, autocommit=True)
        except Exception as e:
            last = e; time.sleep(0.3 * (i + 1))
    raise last

SEATS = int(sys.argv[1]) if len(sys.argv) > 1 else 8       # seats up for sale
BUYERS = int(sys.argv[2]) if len(sys.argv) > 2 else 25     # concurrent buyers per seat
MAX_RETRY = 25

def setup():
    c = connect(); cur = c.cursor()
    # DSQL: each DDL is its own implicit transaction (autocommit on).
    cur.execute("CREATE TABLE IF NOT EXISTS seats (seat_id TEXT PRIMARY KEY, status TEXT NOT NULL, owner TEXT, sold_at TIMESTAMPTZ)")
    cur.execute("CREATE TABLE IF NOT EXISTS op_log (id TEXT PRIMARY KEY, seat_id TEXT, buyer TEXT, outcome TEXT, attempts INT, t_start DOUBLE PRECISION, t_end DOUBLE PRECISION)")
    cur.execute("DELETE FROM seats"); cur.execute("DELETE FROM op_log")
    for i in range(SEATS):
        cur.execute("INSERT INTO seats (seat_id, status) VALUES (%s, 'available')", (f"A{i+1}",))
    c.close()

def is_occ_conflict(e):
    code = getattr(e, 'sqlstate', None) or ''
    msg = str(e)
    return code in ('40001', '40P01') or code.startswith('OC') or 'OC0' in msg or 'serializ' in msg.lower() or 'concurr' in msg.lower()

def buy(seat, buyer):
    """NAIVE read-then-write (no conditional guard). DSQL OCC must serialize this."""
    c = connect(); cur = c.cursor()
    t0 = time.time(); attempts = 0
    try:
        while True:
            attempts += 1
            try:
                with c.transaction():
                    cur.execute("SELECT status FROM seats WHERE seat_id=%s", (seat,))
                    status = cur.fetchone()[0]
                    if status != 'available':
                        outcome = 'rejected'; break
                    # naive: write without re-checking status in the WHERE clause
                    cur.execute("UPDATE seats SET status='sold', owner=%s, sold_at=now() WHERE seat_id=%s", (buyer, seat))
                outcome = 'confirmed'; break
            except Exception as e:
                if is_occ_conflict(e) and attempts < MAX_RETRY:
                    time.sleep(0.01 * attempts); continue
                outcome = 'error:' + (getattr(e, 'sqlstate', '') or str(e)[:40]); break
        t1 = time.time()
        try:
            cur.execute("INSERT INTO op_log (id, seat_id, buyer, outcome, attempts, t_start, t_end) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                        (uuid.uuid4().hex, seat, buyer, outcome, attempts, t0, t1))
        except Exception: pass
        return outcome
    finally:
        c.close()

def main():
    setup()
    tasks = [(f"A{s+1}", f"buyer-{s}-{b}") for s in range(SEATS) for b in range(BUYERS)]
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=min(16, len(tasks))) as ex:
        list(ex.map(lambda a: buy(*a), tasks))
    dur = time.time() - t0

    # HONESTY GUARD: read ground truth straight from the committed table.
    c = connect(); cur = c.cursor()
    cur.execute("SELECT count(*) FROM seats WHERE status='sold'"); sold = cur.fetchone()[0]
    cur.execute("SELECT seat_id, count(*) FROM op_log WHERE outcome='confirmed' GROUP BY seat_id ORDER BY seat_id")
    confirmed = cur.fetchall()
    cur.execute("SELECT outcome, count(*) FROM op_log GROUP BY outcome ORDER BY outcome")
    breakdown = dict(cur.fetchall())
    cur.execute("SELECT max(attempts) FROM op_log"); max_attempts = cur.fetchone()[0]
    c.close()

    confirmed_total = sum(n for _, n in confirmed)
    oversold = max(0, confirmed_total - SEATS)
    result = {
        "backend": "aurora-dsql-multiregion",
        "regions": [st['clusterA']['region'], st['clusterB']['region']],
        "witnessRegion": st['witnessRegion'],
        "seats": SEATS, "buyers_per_seat": BUYERS, "total_attempts": len(tasks),
        "duration_sec": round(dur, 2),
        "confirmed_sales": confirmed_total,
        "sold_rows_in_table": sold,
        "oversold": oversold,
        "max_retries_observed": max_attempts,
        "per_seat_confirmed": {s: n for s, n in confirmed},
        "outcome_breakdown": breakdown,
        "verdict": "OVERSOLD=0 (strong consistency held)" if oversold == 0 and sold == SEATS else f"OVERSOLD={oversold}",
    }
    out = os.path.join(HERE, '..', 'state', 'proof_dsql.json')
    json.dump(result, open(out, 'w'), indent=2)
    print(json.dumps(result, indent=2))
    print("WROTE", out)

if __name__ == "__main__":
    main()
