// DynamoDB Global Tables backend (the NAIVE foil: multi-region, eventual consistency, LWW).
// Same read-then-write app logic as DSQL — but with no transaction/atomicity and eventually
// consistent reads across two regions, concurrent buyers of one seat each read 'available' and
// each writes -> multiple ticket holders. The seats table shows ONE owner (last-writer-wins),
// which hides the harm; the append-only sales ledger is the ground truth of who got a ticket.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, DeleteCommand, BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { DDB, awsCreds, allSeatIds } from './config';
import type { Seat, PurchaseResult, Ticket } from './types';

function doc(region: string): DynamoDBDocumentClient {
  const client = new DynamoDBClient({ region, credentials: awsCreds() as any });
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

export const NAIVE_REGIONS = [DDB.regionA, DDB.regionB];

export async function reset(seats?: string[]): Promise<number> {
  const ids = seats && seats.length ? seats : allSeatIds();
  const d = doc(DDB.regionA);
  // clear both tables (replicates to region B automatically)
  for (const table of [DDB.seatsTable, DDB.salesTable]) {
    const key = table === DDB.seatsTable ? 'seat_id' : 'sale_id';
    let ExclusiveStartKey: any = undefined;
    do {
      const s = await d.send(new ScanCommand({ TableName: table, ProjectionExpression: key, ExclusiveStartKey }));
      const items = s.Items || [];
      for (let i = 0; i < items.length; i += 25) {
        const chunk = items.slice(i, i + 25);
        await d.send(new BatchWriteCommand({
          RequestItems: { [table]: chunk.map((it: any) => ({ DeleteRequest: { Key: { [key]: it[key] } } })) },
        }));
      }
      ExclusiveStartKey = s.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  }
  // seed seats
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    await d.send(new BatchWriteCommand({
      RequestItems: { [DDB.seatsTable]: chunk.map((id) => ({ PutRequest: { Item: { seat_id: id, status: 'available' } } })) },
    }));
  }
  return ids.length;
}

export async function freeSeat(seat: string): Promise<void> {
  const d = doc(DDB.regionA);
  await d.send(new PutCommand({ TableName: DDB.seatsTable, Item: { seat_id: seat, status: 'available' } }));
  // remove prior ledger rows for this seat so a fresh Break-it burst is clean. A row written in
  // either region may not yet have replicated, so scan BOTH replicas with a strongly-consistent
  // read and delete the seat's rows region-locally (deletes then replicate out).
  for (const region of NAIVE_REGIONS) {
    const dr = doc(region);
    const s = await dr.send(new ScanCommand({
      TableName: DDB.salesTable, FilterExpression: 'seat_id = :s',
      ExpressionAttributeValues: { ':s': seat }, ProjectionExpression: 'sale_id', ConsistentRead: true,
    }));
    for (const it of s.Items || []) {
      await dr.send(new DeleteCommand({ TableName: DDB.salesTable, Key: { sale_id: (it as any).sale_id } }));
    }
  }
}

export async function getSeats(): Promise<Seat[]> {
  const d = doc(DDB.regionA);
  const out: Seat[] = [];
  let ExclusiveStartKey: any = undefined;
  do {
    const s = await d.send(new ScanCommand({ TableName: DDB.seatsTable, ExclusiveStartKey }));
    for (const it of s.Items || []) out.push(it as Seat);
    ExclusiveStartKey = s.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  out.sort((a, b) => a.seat_id.localeCompare(b.seat_id, undefined, { numeric: true }));
  return out;
}

// NAIVE purchase: eventually consistent read (ConsistentRead:false) -> unconditional put + ledger append.
export async function purchase(seat: string, buyer: string, region: string): Promise<PurchaseResult> {
  const t0 = Date.now();
  const d = doc(region);
  try {
    const r = await d.send(new GetCommand({ TableName: DDB.seatsTable, Key: { seat_id: seat }, ConsistentRead: false }));
    if (!r.Item || r.Item.status !== 'available') return { outcome: 'rejected', region, buyer, seat, ms: Date.now() - t0 };
    // unconditional write — last writer wins; no atomicity vs. concurrent buyers
    await d.send(new PutCommand({ TableName: DDB.seatsTable, Item: { seat_id: seat, status: 'sold', owner: buyer, region } }));
    // append-only ledger = "this buyer holds a ticket" (ground truth of oversell harm)
    const saleId = `${seat}#${buyer}#${Date.now()}#${Math.random().toString(36).slice(2)}`;
    await d.send(new PutCommand({
      TableName: DDB.salesTable,
      Item: { sale_id: saleId, seat_id: seat, buyer, region, ts: Date.now() },
    }));
    return { outcome: 'confirmed', region, buyer, seat, ms: Date.now() - t0, ticketId: saleId };
  } catch (e) {
    return { outcome: 'error', region, buyer, seat, ms: Date.now() - t0 };
  }
}

// How many owners the mutable LWW *seats* table currently DISPLAYS for this seat (0 if available,
// 1 if sold). This is the screen a real fan would see — and under last-writer-wins it collapses N
// concurrent buyers to a single visible owner, hiding the oversell. Compared against the ledger
// (which proves N holders), the gap is the silently-corrupted state. Strongly-consistent read.
export async function seatTableOwnerCount(seat: string): Promise<number> {
  const d = doc(DDB.regionA);
  const r = await d.send(new GetCommand({ TableName: DDB.seatsTable, Key: { seat_id: seat }, ConsistentRead: true }));
  return r.Item && r.Item.status === 'sold' && r.Item.owner ? 1 : 0;
}

// A buyer's real tickets, read back from the committed sales ledger across BOTH replicas
// (strongly-consistent, deduped by sale_id) — propagation-independent ground truth.
export async function ticketsByBuyer(buyer: string): Promise<Ticket[]> {
  const seen = new Map<string, Ticket>(); // sale_id -> ticket
  for (const region of NAIVE_REGIONS) {
    const d = doc(region);
    let ExclusiveStartKey: any = undefined;
    do {
      const s = await d.send(new ScanCommand({
        TableName: DDB.salesTable, FilterExpression: 'buyer = :b',
        ExpressionAttributeValues: { ':b': buyer },
        ProjectionExpression: 'sale_id, seat_id, #r, ts', ExpressionAttributeNames: { '#r': 'region' },
        ConsistentRead: true, ExclusiveStartKey,
      }));
      for (const it of s.Items || []) {
        const sid = (it as any).sale_id;
        if (sid != null) seen.set(sid, { seat_id: (it as any).seat_id, ticketId: sid, region: (it as any).region, ts: (it as any).ts });
      }
      ExclusiveStartKey = s.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  }
  return [...seen.values()].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

// Ground-truth ledger grouped by seat (used by both the Witness and Break-it).
// A buyer's ledger append is durable in its ORIGIN region immediately, but cross-region
// replication lags — so a single-region scan run right after a burst undercounts (this caused
// Break-it and the Witness to disagree). Fix: scan BOTH replicas with a strongly-consistent read
// and union DISTINCT sale_id. Each sale_id is globally unique, so the union is exact and
// replication-lag-independent; every buyer's write is counted exactly once.
export async function salesBySeat(): Promise<Map<string, number>> {
  const seen = new Map<string, string>(); // sale_id -> seat_id
  for (const region of NAIVE_REGIONS) {
    const d = doc(region);
    let ExclusiveStartKey: any = undefined;
    do {
      const s = await d.send(new ScanCommand({
        TableName: DDB.salesTable, ProjectionExpression: 'sale_id, seat_id', ConsistentRead: true, ExclusiveStartKey,
      }));
      for (const it of s.Items || []) {
        const sid = (it as any).sale_id;
        if (sid != null) seen.set(sid, (it as any).seat_id);
      }
      ExclusiveStartKey = s.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  }
  const counts = new Map<string, number>();
  for (const seat of seen.values()) counts.set(seat, (counts.get(seat) || 0) + 1);
  return counts;
}
