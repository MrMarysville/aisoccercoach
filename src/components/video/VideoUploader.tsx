'use client';

import { useState, useCallback } from 'react';
import { upload } from '@vercel/blob/client';

interface VideoUploaderProps {
  onUploadComplete: (blobUrl: string, videoId: string) => void;
}

export default function VideoUploader({ onUploadComplete }: VideoUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(async (file: File) => {
    const validTypes = ['video/mp4', 'video/quicktime'];
    if (!validTypes.includes(file.type)) {
      setError('Please upload an MP4 or MOV file');
      return;
    }

    setIsUploading(true);
    setError(null);
    setProgress(0);

    try {
      const blob = await upload(file.name, file, {
        access: 'public',
        handleUploadUrl: '/api/upload',
        onUploadProgress: ({ percentage }) => setProgress(percentage),
      });

      const videoId = blob.pathname.replace(/\.[^.]+$/, '');
      onUploadComplete(blob.url, videoId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  }, [onUploadComplete]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  return (
    <div className="flex flex-col gap-4">
      <div
        className={`card p-12 flex flex-col items-center justify-center cursor-pointer transition ${isDragging ? 'border-primary' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        {isUploading ? (
          <div className="flex flex-col items-center gap-2 w-full">
            <p className="text-sm text-on-surface-secondary">Uploading... {Math.round(progress)}%</p>
            <div className="w-full h-2 rounded-full bg-color-border overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <p className="text-on-surface font-medium">Drop your match video here</p>
            <p className="text-sm text-on-surface-secondary">MP4 or MOV</p>
            <label className="btn btn-primary cursor-pointer">
              Browse Files
              <input
                type="file"
                accept="video/mp4,video/quicktime"
                onChange={handleInputChange}
                className="hidden"
              />
            </label>
          </div>
        )}
      </div>
      {error && <p className="text-sm text-error">{error}</p>}
    </div>
  );
}
