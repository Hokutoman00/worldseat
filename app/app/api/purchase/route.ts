import { NextRequest, NextResponse } from 'next/server';
import { makePool, purchase as dsqlBuy } from '@/lib/dsql';
import { purchase as ddbBuy, NAIVE_REGIONS } from '@/lib/ddb';
import { DSQL } from '@/lib/config';
import type { Backend } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Single human purchase (the seat-map click). Region picks which active-active node serves it.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const backend = (body.backend || 'dsql') as Backend;
  const seat: string = body.seat;
  const buyer: string = body.buyer || `user-${Math.random().toString(36).slice(2, 7)}`;
  if (!seat) return NextResponse.json({ error: 'seat required' }, { status: 400 });
  try {
    if (backend === 'dsql') {
      const which = body.region === DSQL.regionB ? 'B' : 'A';
      const pool = await makePool(2, which);
      try {
        const res = await dsqlBuy(pool, seat, buyer, which === 'B' ? DSQL.regionB : DSQL.regionA);
        return NextResponse.json({ backend, ...res });
      } finally {
        await pool.end().catch(() => {});
      }
    }
    const region = body.region && NAIVE_REGIONS.includes(body.region) ? body.region : NAIVE_REGIONS[0];
    const res = await ddbBuy(seat, buyer, region);
    return NextResponse.json({ backend, ...res });
  } catch (e: any) {
    return NextResponse.json({ backend, error: String(e?.message || e) }, { status: 500 });
  }
}
