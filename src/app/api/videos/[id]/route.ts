import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, existsSync } from 'fs';
import path from 'path';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  
  const uploadsDir = path.join(process.cwd(), 'uploads');
  
  const extensions = ['.mp4', '.mov', '.avi'];
  let filePath = '';
  
  for (const ext of extensions) {
    const p = path.join(uploadsDir, `${id}${ext}`);
    if (existsSync(p)) {
      filePath = p;
      break;
    }
  }
  
  if (!filePath) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }
  
  const stat = await import('fs').then(fs => fs.promises.stat(filePath));
  const fileSize = stat.size;
  const range = request.headers.get('range');
  
  const ext = filePath.split('.').pop()?.toLowerCase();
  const contentType = ext === 'mov' ? 'video/quicktime' : ext === 'avi' ? 'video/x-msvideo' : 'video/mp4';
  
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    
    const stream = createReadStream(filePath, { start, end });
    
    return new NextResponse(stream as unknown as BodyInit, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize.toString(),
        'Content-Type': contentType,
      },
    });
  }
  
  const stream = createReadStream(filePath);
  
  return new NextResponse(stream as unknown as BodyInit, {
    headers: {
      'Content-Length': fileSize.toString(),
      'Content-Type': contentType,
    },
  });
}
