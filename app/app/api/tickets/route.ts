import { NextRequest, NextResponse } from 'next/server';
import { makePool, ticketsByBuyer as dsqlTickets } from '@/lib/dsql';
import { ticketsByBuyer as ddbTickets } from '@/lib/ddb';
import type { Backend } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// "My tickets" — a buyer's real confirmed tickets, read back from the committed ledger.
export async function GET(req: NextRequest) {
  const backend = (req.nextUrl.searchParams.get('backend') || 'dsql') as Backend;
  const buyer = req.nextUrl.searchParams.get('buyer') || '';
  if (!buyer) return NextResponse.json({ backend, buyer, tickets: [] });
  try {
    if (backend === 'dsql') {
      const pool = await makePool(2);
      try {
        const tickets = await dsqlTickets(pool, buyer);
        return NextResponse.json({ backend, buyer, tickets });
      } finally { await pool.end().catch(() => {}); }
    }
    const tickets = await ddbTickets(buyer);
    return NextResponse.json({ backend, buyer, tickets });
  } catch (e: any) {
    return NextResponse.json({ backend, buyer, error: String(e?.message || e) }, { status: 500 });
  }
}
