import { NextRequest, NextResponse } from 'next/server';
import { stat, readFile } from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { Readable } from 'stream';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads');

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Read metadata to get filename
    const metaPath = path.join(UPLOAD_DIR, `${id}.json`);
    let filename: string;
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
      filename = meta.filename;
    } catch {
      return NextResponse.json({ error: 'Video not found' }, { status: 404 });
    }

    const filepath = path.join(UPLOAD_DIR, filename);
    const fileStat = await stat(filepath);
    const fileSize = fileStat.size;

    const range = request.headers.get('range');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const stream = createReadStream(filepath, { start, end });
      const webStream = Readable.toWeb(stream) as ReadableStream;

      return new NextResponse(webStream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize),
          'Content-Type': 'video/mp4',
        },
      });
    }

    const stream = createReadStream(filepath);
    const webStream = Readable.toWeb(stream) as ReadableStream;

    return new NextResponse(webStream, {
      headers: {
        'Content-Length': String(fileSize),
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
      },
    });
  } catch (error) {
    console.error('Video streaming failed:', error);
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }
}
