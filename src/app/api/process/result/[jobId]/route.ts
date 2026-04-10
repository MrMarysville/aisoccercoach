import { NextRequest, NextResponse } from 'next/server';
import { getResult } from '@/lib/modal-client';
import { cacheProcessingResult } from '@/lib/result-cache';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  try {
    const result = await getResult(jobId);

    if (result === null) {
      return NextResponse.json({ status: 'processing' }, { status: 202 });
    }

    void cacheProcessingResult(result).catch(() => undefined);
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Result fetch failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
