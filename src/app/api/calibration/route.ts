import { NextRequest, NextResponse } from 'next/server';
import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const CALIBRATION_DIR = path.join(process.cwd(), 'uploads', 'calibrations');

export async function GET() {
  try {
    await mkdir(CALIBRATION_DIR, { recursive: true });
    const files = await readdir(CALIBRATION_DIR);
    const profiles = await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => {
          const content = await readFile(path.join(CALIBRATION_DIR, f), 'utf-8');
          return JSON.parse(content);
        })
    );
    return NextResponse.json({ success: true, profiles });
  } catch (error) {
    console.error('Failed to list calibrations:', error);
    return NextResponse.json({ success: true, profiles: [] });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, points, camera_type, field_template } = body;

    if (!points || !Array.isArray(points) || points.length < 4) {
      return NextResponse.json(
        { success: false, error: 'At least 4 calibration points required' },
        { status: 400 }
      );
    }

    await mkdir(CALIBRATION_DIR, { recursive: true });

    const id = crypto.randomUUID();
    const profile = {
      id,
      name: name || `Calibration ${new Date().toLocaleDateString()}`,
      points,
      camera_type: camera_type || 'fixed',
      field_template: field_template || '9v9',
      created_at: new Date().toISOString(),
    };

    await writeFile(
      path.join(CALIBRATION_DIR, `${id}.json`),
      JSON.stringify(profile, null, 2)
    );

    return NextResponse.json({ success: true, profile });
  } catch (error) {
    console.error('Failed to save calibration:', error);
    return NextResponse.json({ success: false, error: 'Save failed' }, { status: 500 });
  }
}
