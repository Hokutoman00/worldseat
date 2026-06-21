import { NextRequest, NextResponse } from 'next/server';
import { makePool, getSeats as dsqlGetSeats } from '@/lib/dsql';
import { getSeats as ddbGetSeats } from '@/lib/ddb';
import type { Backend } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const backend = (req.nextUrl.searchParams.get('backend') || 'dsql') as Backend;
  try {
    if (backend === 'dsql') {
      const pool = await makePool(2);
      try {
        const seats = await dsqlGetSeats(pool);
        return NextResponse.json({ backend, seats });
      } finally {
        await pool.end().catch(() => {});
      }
    }
    const seats = await ddbGetSeats();
    return NextResponse.json({ backend, seats });
  } catch (e: any) {
    return NextResponse.json({ backend, error: String(e?.message || e) }, { status: 500 });
  }
}
