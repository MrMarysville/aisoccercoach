import { NextRequest, NextResponse } from 'next/server';
import { submitJob } from '@/lib/modal-client';
import type { ProcessJobResponse } from '@/types/replay';

export async function POST(request: NextRequest) {
  try {
    const body: { video_url: string; video_id: string } = await request.json();
    const { video_url, video_id } = body;

    if (!video_url || !video_id) {
      return NextResponse.json({ error: 'video_url and video_id required' }, { status: 400 });
    }

    // video_url is a public Vercel Blob URL — Modal can download it directly
    const callId = await submitJob(video_url, '9v9');

    const response: ProcessJobResponse = { job_id: callId };
    return NextResponse.json(response);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Processing failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
