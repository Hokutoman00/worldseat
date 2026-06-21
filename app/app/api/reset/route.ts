import { NextRequest, NextResponse } from 'next/server';
import { makePool, reset as dsqlReset } from '@/lib/dsql';
import { reset as ddbReset } from '@/lib/ddb';
import type { Backend } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const backend = (body.backend || 'dsql') as Backend;
  const seats: string[] | undefined = body.seats;
  try {
    let n: number;
    if (backend === 'dsql') {
      const pool = await makePool(4);
      try {
        n = await dsqlReset(pool, seats);
      } finally {
        await pool.end().catch(() => {});
      }
    } else {
      n = await ddbReset(seats);
    }
    return NextResponse.json({ backend, reset: n });
  } catch (e: any) {
    return NextResponse.json({ backend, error: String(e?.message || e) }, { status: 500 });
  }
}
