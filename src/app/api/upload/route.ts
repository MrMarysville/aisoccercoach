import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
const ALLOWED_TYPES = ['video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm'];
const MAX_SIZE = 15 * 1024 * 1024 * 1024; // 15GB

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('video') as File | null;
    const cameraType = (formData.get('camera_type') as string) || 'fixed';

    if (!file) {
      return NextResponse.json({ success: false, error: 'No video file provided' }, { status: 400 });
    }

    if (!ALLOWED_TYPES.includes(file.type) && !file.name.match(/\.(mp4|mov|avi|webm)$/i)) {
      return NextResponse.json({ success: false, error: 'Invalid file type. Accepted: mp4, mov, avi, webm' }, { status: 400 });
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json({ success: false, error: 'File too large. Maximum 15GB.' }, { status: 400 });
    }

    await mkdir(UPLOAD_DIR, { recursive: true });

    const id = crypto.randomUUID();
    const ext = path.extname(file.name) || '.mp4';
    const filename = `${id}${ext}`;
    const filepath = path.join(UPLOAD_DIR, filename);

    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(filepath, buffer);

    // Save metadata
    const meta = { id, filename, camera_type: cameraType, uploaded_at: new Date().toISOString() };
    await writeFile(path.join(UPLOAD_DIR, `${id}.json`), JSON.stringify(meta, null, 2));

    return NextResponse.json({
      success: true,
      video_url: `/api/videos/${id}`,
      video_id: id,
    });
  } catch (error) {
    console.error('Upload failed:', error);
    return NextResponse.json({ success: false, error: 'Upload failed' }, { status: 500 });
  }
}
