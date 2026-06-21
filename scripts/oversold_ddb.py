#!/usr/bin/env python3
"""NAIVE foil live proof: same read-then-write logic as the DSQL hero, but on DynamoDB Global
Tables (eventual consistency, last-writer-wins). Concurrent buyers across us-east-1 + us-east-2
each read 'available' (eventually consistent) and each write -> multiple confirmed ticket
holders. oversold is read from the COMMITTED append-only ledger (ground truth), NOT app hope.
The seats table shows ONE owner (LWW hides the harm); sales_naive shows who really holds a seat.
Writes state/proof_ddb.json."""
import os, re, json, time, uuid, pathlib
from concurrent.futures import ThreadPoolExecutor, as_completed

import boto3
from boto3.dynamodb.conditions import Attr

ROOT = pathlib.Path(__file__).resolve().parents[1]
REGION_A, REGION_B = "us-east-1", "us-east-2"
SEATS, SALES = "seats_naive", "sales_naive"
SEAT_COUNT = 6
BUYERS_PER_SEAT = 12


def load_env():
    env = {}
    for ln in open(r"C:/Users/hokut/.credentials/aws.env", encoding="utf-8"):
        m = re.match(r"\s*([A-Z_]+)\s*=\s*(.*)", ln)
        if m:
            env[m.group(1)] = m.group(2).strip().strip("\"'")
    return env


ENV = load_env()


def res(region):
    return boto3.resource(
        "dynamodb",
        aws_access_key_id=ENV["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=ENV["AWS_SECRET_ACCESS_KEY"],
        region_name=region,
    )


RA, RB = res(REGION_A), res(REGION_B)
SEAT_IDS = [f"S{i+1}" for i in range(SEAT_COUNT)]


def setup():
    seats_a = RA.Table(SEATS)
    sales_a = RA.Table(SALES)
    # clear sales ledger
    for tbl, key in ((seats_a, "seat_id"), (sales_a, "sale_id")):
        scan = tbl.scan(ProjectionExpression=key)
        items = scan.get("Items", [])
        with tbl.batch_writer() as bw:
            for it in items:
                bw.delete_item(Key={key: it[key]})
    # seed seats available
    with seats_a.batch_writer() as bw:
        for sid in SEAT_IDS:
            bw.put_item(Item={"seat_id": sid, "status": "available"})
    # let replication settle so both regions see the seed
    time.sleep(8)


def buy(seat, buyer, region):
    """NAIVE read-then-write: eventually-consistent get -> unconditional put + ledger append."""
    r = RA if region == REGION_A else RB
    seats = r.Table(SEATS)
    sales = r.Table(SALES)
    try:
        got = seats.get_item(Key={"seat_id": seat}, ConsistentRead=False).get("Item")
        if not got or got.get("status") != "available":
            return ("rejected", seat, buyer, region)
        # unconditional write — last writer wins, no atomicity vs concurrent buyers
        seats.put_item(Item={"seat_id": seat, "status": "sold", "owner": buyer, "region": region})
        sales.put_item(Item={
            "sale_id": f"{seat}#{buyer}#{int(time.time()*1000)}#{uuid.uuid4().hex[:6]}",
            "seat_id": seat, "buyer": buyer, "region": region, "ts": int(time.time() * 1000),
        })
        return ("confirmed", seat, buyer, region)
    except Exception as e:
        return ("error", seat, buyer, f"{region}:{type(e).__name__}")


def main():
    print("setup ...", flush=True)
    setup()
    jobs = []
    for sid in SEAT_IDS:
        for b in range(BUYERS_PER_SEAT):
            region = REGION_A if b % 2 == 0 else REGION_B
            jobs.append((sid, f"buyer-{sid}-{b}", region))

    print(f"firing {len(jobs)} concurrent buyers across {REGION_A}+{REGION_B} ...", flush=True)
    outcomes = []
    with ThreadPoolExecutor(max_workers=32) as ex:
        futs = [ex.submit(buy, *j) for j in jobs]
        for f in as_completed(futs):
            outcomes.append(f.result())

    # ground truth: the append-only ledger (strongly-consistent scan in region A)
    time.sleep(6)  # let cross-region ledger writes replicate to A
    sales_a = RA.Table(SALES)
    per_seat = {sid: 0 for sid in SEAT_IDS}
    scan = sales_a.scan(ProjectionExpression="seat_id", ConsistentRead=True)
    items = scan.get("Items", [])
    while "LastEvaluatedKey" in scan:
        scan = sales_a.scan(ProjectionExpression="seat_id", ConsistentRead=True,
                            ExclusiveStartKey=scan["LastEvaluatedKey"])
        items += scan.get("Items", [])
    for it in items:
        per_seat[it["seat_id"]] = per_seat.get(it["seat_id"], 0) + 1

    confirmed_total = sum(per_seat.values())
    oversold = sum(max(0, n - 1) for n in per_seat.values())
    seats_with_oversell = sum(1 for n in per_seat.values() if n > 1)
    app_confirmed = sum(1 for o in outcomes if o[0] == "confirmed")

    result = {
        "backend": "naive-dynamodb-global-tables",
        "regions": [REGION_A, REGION_B],
        "seats": SEAT_COUNT,
        "buyers_per_seat": BUYERS_PER_SEAT,
        "attempts": len(jobs),
        "app_confirmed": app_confirmed,
        "ledger_confirmed_total": confirmed_total,
        "per_seat_confirmed": per_seat,
        "seats_with_oversell": seats_with_oversell,
        "oversold": oversold,
        "verdict": f"OVERSOLD={oversold} (eventual consistency + LWW -> double-sells)"
                   if oversold > 0 else "oversold=0 (no race observed this run)",
    }
    (ROOT / "state" / "proof_ddb.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2), flush=True)


if __name__ == "__main__":
    main()
