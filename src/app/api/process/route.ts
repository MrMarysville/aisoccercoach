import { NextRequest, NextResponse } from 'next/server';
import { isModalConfigured, processVideo } from '@/lib/modal-client';
import { generateMockData } from '@/lib/video-processing/mock-data';
import type { CalibrationPoint, CameraType, FieldTemplate } from '@/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      video_id,
      field_template = '9v9',
      calibration_points,
      camera_type = 'fixed',
    } = body as {
      video_id: string;
      field_template: FieldTemplate;
      calibration_points: CalibrationPoint[];
      camera_type: CameraType;
    };

    if (!video_id) {
      return NextResponse.json({ success: false, error: 'video_id required' }, { status: 400 });
    }

    let data;

    if (isModalConfigured()) {
      data = await processVideo({
        video_id,
        calibration_points,
        field_template,
        camera_type,
      });
    } else {
      // Generate mock data for development
      data = generateMockData({
        video_id,
        field_template,
        camera_type,
        duration_seconds: 30,
        fps: 30,
      });
    }

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('Processing failed:', error);
    return NextResponse.json(
      { success: false, error: 'Processing failed' },
      { status: 500 }
    );
  }
}
