import type { CalibrationPoint, CameraType, ProcessedVideoData } from '@/types';

export function isModalConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_MODAL_ENDPOINT;
}

export async function processVideo(params: {
  video_id: string;
  calibration_points: CalibrationPoint[];
  field_template: string;
  camera_type: CameraType;
}): Promise<ProcessedVideoData> {
  const endpoint = process.env.NEXT_PUBLIC_MODAL_ENDPOINT;
  if (!endpoint) {
    throw new Error('Modal endpoint not configured');
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    throw new Error(`Modal processing failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}
