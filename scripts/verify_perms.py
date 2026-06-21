# Verify the local aegis-bedrock key now has DSQL + DynamoDB perms (RC-2: prove, don't assume).
import re, boto3
env = {}
for ln in open(r"C:/Users/hokut/.credentials/aws.env", encoding="utf-8"):
    m = re.match(r'\s*([A-Z_]+)\s*=\s*(.*)', ln)
    if m: env[m.group(1)] = m.group(2).strip().strip('"\'')
kw = dict(aws_access_key_id=env.get('AWS_ACCESS_KEY_ID'),
          aws_secret_access_key=env.get('AWS_SECRET_ACCESS_KEY'),
          region_name='us-east-1')
ok = {}
try:
    d = boto3.client('dsql', **kw)
    r = d.list_clusters()
    ok['dsql'] = f"OK clusters={len(r.get('clusters', []))}"
except Exception as e:
    ok['dsql'] = f"FAIL {type(e).__name__}: {str(e)[:160]}"
try:
    dy = boto3.client('dynamodb', **kw)
    r = dy.list_tables()
    ok['dynamodb'] = f"OK tables={len(r.get('TableNames', []))}"
except Exception as e:
    ok['dynamodb'] = f"FAIL {type(e).__name__}: {str(e)[:160]}"
print("dsql    :", ok['dsql'])
print("dynamodb:", ok['dynamodb'])
print("READY" if all('OK' in v for v in ok.values()) else "NOT-READY")
