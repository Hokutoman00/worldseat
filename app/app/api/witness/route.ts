import { NextRequest, NextResponse } from 'next/server';
import { witness } from '@/lib/witness';
import type { Backend } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// The Consistency Witness (Jepsen-lite). Verdict computed from the real committed history.
export async function GET(req: NextRequest) {
  const backend = (req.nextUrl.searchParams.get('backend') || 'dsql') as Backend;
  const seat = req.nextUrl.searchParams.get('seat') || undefined;
  try {
    const v = await witness(backend, seat);
    return NextResponse.json(v);
  } catch (e: any) {
    return NextResponse.json({ backend, error: String(e?.message || e) }, { status: 500 });
  }
}
