# Provision a 2-region Aurora DSQL multi-region cluster (active-active, strong consistency).
# Regions: us-east-1 + us-east-2, witness us-west-2. deletionProtection OFF (cleanup later).
# Writes ARNs/endpoints (NOT secrets) to ../state/dsql.json. RC-2: polls to ACTIVE, prints truth.
import boto3, re, json, time, os, sys

env = {}
for ln in open(r"C:/Users/hokut/.credentials/aws.env", encoding="utf-8"):
    m = re.match(r'\s*([A-Z_]+)\s*=\s*(.*)', ln)
    if m: env[m.group(1)] = m.group(2).strip().strip('"\'')
AK, SK = env['AWS_ACCESS_KEY_ID'], env['AWS_SECRET_ACCESS_KEY']
WITNESS = 'us-west-2'
RA, RB = 'us-east-1', 'us-east-2'

def cli(region):
    return boto3.client('dsql', aws_access_key_id=AK, aws_secret_access_key=SK, region_name=region)

ca, cb = cli(RA), cli(RB)

def wait(client, ident, target=('ACTIVE',), timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = client.get_cluster(identifier=ident)
        st = r['status']
        print(f"  {ident} status={st}", flush=True)
        if st in target: return r
        if st in ('FAILED','DELETING'): raise RuntimeError(f"{ident} -> {st}")
        time.sleep(15)
    raise TimeoutError(f"{ident} not {target} in {timeout}s")

statefile = os.path.join(os.path.dirname(__file__), '..', 'state', 'dsql.json')
os.makedirs(os.path.dirname(statefile), exist_ok=True)

# 1) create cluster A (no peers yet), witness set
print("Creating cluster A (us-east-1)...", flush=True)
a = ca.create_cluster(deletionProtectionEnabled=False,
                      multiRegionProperties={'witnessRegion': WITNESS})
arn_a, id_a, ep_a = a['arn'], a['identifier'], a.get('endpoint')
print("  A:", id_a, arn_a, "status", a['status'], flush=True)

# 2) create cluster B peered to A
print("Creating cluster B (us-east-2) peered to A...", flush=True)
b = cb.create_cluster(deletionProtectionEnabled=False,
                     multiRegionProperties={'witnessRegion': WITNESS, 'clusters': [arn_a]})
arn_b, id_b, ep_b = b['arn'], b['identifier'], b.get('endpoint')
print("  B:", id_b, arn_b, "status", b['status'], flush=True)

# 3) update A to add B as peer
print("Updating A to peer B...", flush=True)
ca.update_cluster(identifier=id_a, multiRegionProperties={'witnessRegion': WITNESS, 'clusters': [arn_b]})

# 4) wait both ACTIVE
print("Waiting for A ACTIVE...", flush=True); wait(ca, id_a)
print("Waiting for B ACTIVE...", flush=True); wait(cb, id_b)

ra = ca.get_cluster(identifier=id_a); rb = cb.get_cluster(identifier=id_b)
ep_a = ep_a or f"{id_a}.dsql.{RA}.on.aws"
ep_b = ep_b or f"{id_b}.dsql.{RB}.on.aws"
state = {
  'witnessRegion': WITNESS,
  'clusterA': {'region': RA, 'identifier': id_a, 'arn': arn_a, 'endpoint': ep_a, 'status': ra['status']},
  'clusterB': {'region': RB, 'identifier': id_b, 'arn': arn_b, 'endpoint': ep_b, 'status': rb['status']},
}
json.dump(state, open(statefile, 'w'), indent=2)
print("\nWROTE", statefile)
print(json.dumps(state, indent=2))
print("BOTH_ACTIVE" if ra['status']=='ACTIVE' and rb['status']=='ACTIVE' else "NOT_ACTIVE")
