import { list, put } from '@vercel/blob';
import type { ProcessingResult } from '@/types/replay';

const RESULT_PREFIX = 'results';

function isBlobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function getResultPath(videoId: string): string {
  return `${RESULT_PREFIX}/${videoId}.json`;
}

export async function findCachedResultUrl(videoId: string): Promise<string | null> {
  if (!isBlobConfigured()) return null;

  try {
    const pathname = getResultPath(videoId);
    const response = await list({ prefix: pathname, limit: 10 });
    if (response.blobs.length === 0) return null;

    const latest = [...response.blobs].sort(
      (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime(),
    )[0];

    return latest?.url ?? null;
  } catch (error) {
    console.warn('Failed to query cached processing result', error);
    return null;
  }
}

export async function cacheProcessingResult(result: ProcessingResult): Promise<string | null> {
  if (!isBlobConfigured()) return null;

  try {
    const blob = await put(
      getResultPath(result.metadata.video_id),
      JSON.stringify(result),
      {
        access: 'public',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json',
      },
    );

    return blob.url;
  } catch (error) {
    console.warn('Failed to cache processing result', error);
    return null;
  }
}
