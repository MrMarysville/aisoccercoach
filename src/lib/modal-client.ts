import type { JobStatus, ProcessingResult } from '@/types/replay';

function getEndpoint(): string {
  const endpoint = process.env.MODAL_ENDPOINT;
  if (!endpoint) throw new Error('MODAL_ENDPOINT environment variable is not set');
  return endpoint;
}

export async function submitJob(videoUrl: string, fieldTemplate: string): Promise<string> {
  const response = await fetch(`${getEndpoint()}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_url: videoUrl, field_template: fieldTemplate }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Modal submit failed (${response.status}): ${text}`);
  }

  const data = await response.json() as { call_id: string };
  return data.call_id;
}

export async function pollStatus(callId: string): Promise<JobStatus> {
  const response = await fetch(`${getEndpoint()}/status/${callId}`);

  if (!response.ok) {
    throw new Error(`Modal status failed (${response.status})`);
  }

  return response.json() as Promise<JobStatus>;
}

export async function getResult(callId: string): Promise<ProcessingResult | null> {
  const response = await fetch(`${getEndpoint()}/result/${callId}`);

  if (response.status === 202) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Modal result failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<ProcessingResult>;
}
