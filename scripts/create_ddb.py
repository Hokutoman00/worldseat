#!/usr/bin/env python3
"""Provision the NAIVE foil: two DynamoDB Global Tables (seats_naive, sales_naive),
multi-region us-east-1 + us-east-2, PAY_PER_REQUEST, Streams NEW_AND_OLD_IMAGES.
Same 2-region active-active topology as the DSQL hero -> the only variable is the DB's
consistency model. Idempotent: safe to re-run. Writes state/ddb.json. Prints DDB_READY."""
import os, sys, time, json, re, pathlib

import boto3
from botocore.exceptions import ClientError

ROOT = pathlib.Path(__file__).resolve().parents[1]
REGION_A = "us-east-1"
REGION_B = "us-east-2"
TABLES = {"seats_naive": "seat_id", "sales_naive": "sale_id"}


def load_env():
    env = {}
    for ln in open(r"C:/Users/hokut/.credentials/aws.env", encoding="utf-8"):
        m = re.match(r"\s*([A-Z_]+)\s*=\s*(.*)", ln)
        if m:
            env[m.group(1)] = m.group(2).strip().strip("\"'")
    return env


def main():
    env = load_env()
    d = boto3.client(
        "dynamodb",
        aws_access_key_id=env["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=env["AWS_SECRET_ACCESS_KEY"],
        region_name=REGION_A,
    )

    # 1) base tables in region A
    for name, pk in TABLES.items():
        try:
            d.describe_table(TableName=name)
            print(f"[A] {name} exists", flush=True)
        except ClientError as e:
            if e.response["Error"]["Code"] != "ResourceNotFoundException":
                raise
            print(f"[A] creating {name} ...", flush=True)
            d.create_table(
                TableName=name,
                AttributeDefinitions=[{"AttributeName": pk, "AttributeType": "S"}],
                KeySchema=[{"AttributeName": pk, "KeyType": "HASH"}],
                BillingMode="PAY_PER_REQUEST",
                StreamSpecification={"StreamEnabled": True, "StreamViewType": "NEW_AND_OLD_IMAGES"},
            )

    for name in TABLES:
        while d.describe_table(TableName=name)["Table"]["TableStatus"] != "ACTIVE":
            print(f"[A] {name} not active yet ...", flush=True)
            time.sleep(5)
        print(f"[A] {name} ACTIVE", flush=True)

    # 2) add region B replica (make Global Table)
    for name in TABLES:
        t = d.describe_table(TableName=name)["Table"]
        regions = {r["RegionName"] for r in t.get("Replicas", [])}
        if REGION_B in regions:
            print(f"[B] {name} replica present", flush=True)
            continue
        print(f"[B] adding {REGION_B} replica to {name} ...", flush=True)
        try:
            d.update_table(TableName=name, ReplicaUpdates=[{"Create": {"RegionName": REGION_B}}])
        except ClientError as e:
            print(f"[B] {name}: {e.response['Error']['Code']} {e.response['Error']['Message'][:80]}", flush=True)

    # 3) wait replicas ACTIVE (up to ~12 min)
    for name in TABLES:
        for _ in range(72):
            t = d.describe_table(TableName=name)["Table"]
            reps = {r["RegionName"]: r.get("ReplicaStatus") for r in t.get("Replicas", [])}
            print(f"[B] {name} table={t['TableStatus']} replicas={reps}", flush=True)
            if t["TableStatus"] == "ACTIVE" and reps.get(REGION_B) == "ACTIVE":
                break
            time.sleep(10)

    out = {
        "regionA": REGION_A, "regionB": REGION_B,
        "seatsTable": "seats_naive", "salesTable": "sales_naive",
        "billing": "PAY_PER_REQUEST", "stream": "NEW_AND_OLD_IMAGES", "globalTable": True,
    }
    (ROOT / "state" / "ddb.json").write_text(json.dumps(out, indent=2))
    print("DDB_READY", flush=True)


if __name__ == "__main__":
    main()
