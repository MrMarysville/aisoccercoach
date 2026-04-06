'use client';

import { useState, useRef, useCallback } from 'react';
import type { CameraType } from '@/types';

interface VideoUploaderProps {
  onUploadComplete: (url: string, id: string, cameraType: CameraType) => void;
}

export default function VideoUploader({ onUploadComplete }: VideoUploaderProps) {
  const [cameraType, setCameraType] = useState<CameraType>('fixed');
  const [isDragging, setIsDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadFile = useCallback(async (file: File) => {
    setError(null);
    setUploadProgress(0);

    const formData = new FormData();
    formData.append('video', file);
    formData.append('camera_type', cameraType);

    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        setUploadProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status === 200) {
        const result = JSON.parse(xhr.responseText);
        if (result.success) {
          setUploadProgress(null);
          onUploadComplete(result.video_url, result.video_id, cameraType);
        } else {
          setError(result.error || 'Upload failed');
          setUploadProgress(null);
        }
      } else {
        setError('Upload failed');
        setUploadProgress(null);
      }
    });

    xhr.addEventListener('error', () => {
      setError('Network error during upload');
      setUploadProgress(null);
    });

    xhr.open('POST', '/api/upload');
    xhr.send(formData);
  }, [cameraType, onUploadComplete]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Camera Type Selector */}
      <div>
        <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--color-on-surface)' }}>
          Camera Type
        </label>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          {([
            { value: 'fixed' as const, label: 'Fixed Camera', desc: 'Camera stays in one position (typical sideline tripod)' },
            { value: 'ptz' as const, label: 'PTZ Camera', desc: 'Camera pans/tilts/zooms to follow play' },
          ]).map(({ value, label, desc }) => (
            <button
              key={value}
              onClick={() => setCameraType(value)}
              style={{
                flex: 1,
                padding: '0.75rem',
                borderRadius: 'var(--radius-lg)',
                border: `2px solid ${cameraType === value ? 'var(--color-primary)' : 'var(--color-border)'}`,
                backgroundColor: cameraType === value ? 'var(--color-primary-light)' : 'var(--color-surface)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--color-on-surface)' }}>{label}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--color-on-surface-secondary)', marginTop: '0.25rem' }}>{desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Drop Zone */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: `2px dashed ${isDragging ? 'var(--color-primary)' : 'var(--color-border)'}`,
          borderRadius: 'var(--radius-lg)',
          padding: '3rem',
          textAlign: 'center',
          cursor: 'pointer',
          backgroundColor: isDragging ? 'var(--color-primary-light)' : 'var(--color-surface)',
          transition: 'all 0.15s ease',
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="video/mp4,video/quicktime,video/x-msvideo,video/webm,.mp4,.mov,.avi,.webm"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />

        {uploadProgress !== null ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ width: '100%', maxWidth: '300px', height: '8px', backgroundColor: 'var(--color-border)', borderRadius: 'var(--radius-full)' }}>
              <div
                style={{
                  width: `${uploadProgress}%`,
                  height: '100%',
                  backgroundColor: 'var(--color-primary)',
                  borderRadius: 'var(--radius-full)',
                  transition: 'width 0.2s ease',
                }}
              />
            </div>
            <span style={{ fontSize: '0.875rem', color: 'var(--color-on-surface-secondary)' }}>
              Uploading... {uploadProgress}%
            </span>
          </div>
        ) : (
          <div>
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ margin: '0 auto', color: 'var(--color-on-surface-secondary)' }}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <p style={{ fontWeight: 500, color: 'var(--color-on-surface)' }}>
              Drop your soccer video here or click to browse
            </p>
            <p style={{ fontSize: '0.75rem', color: 'var(--color-on-surface-secondary)', marginTop: '0.25rem' }}>
              MP4, MOV, AVI, or WebM up to 15GB
            </p>
          </div>
        )}
      </div>

      {error && (
        <div style={{
          padding: '0.75rem',
          borderRadius: 'var(--radius-md)',
          backgroundColor: '#fef2f2',
          border: '1px solid #fecaca',
          color: 'var(--color-danger)',
          fontSize: '0.875rem',
        }}>
          {error}
        </div>
      )}
    </div>
  );
}
