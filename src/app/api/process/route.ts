import { NextRequest, NextResponse } from 'next/server';
import { submitJob } from '@/lib/modal-client';
import { list } from '@vercel/blob';
import type { ProcessJobResponse } from '@/types/replay';

export async function POST(request: NextRequest) {
  try {
    const body: { video_url: string; video_id: string } = await request.json();
    const { video_url, video_id } = body;

    if (!video_url || !video_id) {
      return NextResponse.json({ error: 'video_url and video_id required' }, { status: 400 });
    }

    // Check for cached result
    const cached = await list({ prefix: `${video_id}_result` });
    if (cached.blobs.length > 0 && cached.blobs[0]) {
      return NextResponse.json({ cached: true, result_url: cached.blobs[0].url });
    }

    // Submit to Modal
    const callId = await submitJob(video_url, '9v9');

    const response: ProcessJobResponse = { job_id: callId };
    return NextResponse.json(response);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Processing failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
