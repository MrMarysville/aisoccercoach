'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import type { CalibrationPoint, FieldTemplate } from '@/types';
import { CALIBRATION_REFERENCE_POINTS } from '@/lib/field/dimensions';

interface CalibrationOverlayProps {
  videoSrc: string;
  fieldTemplate: FieldTemplate;
  onCalibrationComplete: (points: CalibrationPoint[]) => void;
}

export default function CalibrationOverlay({
  videoSrc,
  fieldTemplate,
  onCalibrationComplete,
}: CalibrationOverlayProps) {
  const [points, setPoints] = useState<CalibrationPoint[]>([]);
  const [selectedRef, setSelectedRef] = useState<number>(0);
  const [videoDims, setVideoDims] = useState({ width: 1920, height: 1080 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const refPoints = CALIBRATION_REFERENCE_POINTS[fieldTemplate];

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onLoaded = () => {
      setVideoDims({ width: video.videoWidth || 1920, height: video.videoHeight || 1080 });
    };
    video.addEventListener('loadedmetadata', onLoaded);
    return () => video.removeEventListener('loadedmetadata', onLoaded);
  }, [videoSrc]);

  const handleVideoClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const rect = overlay.getBoundingClientRect();
    const pixel_x = ((e.clientX - rect.left) / rect.width) * videoDims.width;
    const pixel_y = ((e.clientY - rect.top) / rect.height) * videoDims.height;

    const ref = refPoints[selectedRef];
    const point: CalibrationPoint = {
      pixel_x: Math.round(pixel_x),
      pixel_y: Math.round(pixel_y),
      field_x: ref.x,
      field_y: ref.y,
    };

    setPoints((prev) => {
      return [...prev.filter((p) => p.field_x !== ref.x || p.field_y !== ref.y), point];
    });

    // Auto-advance to next reference point
    setSelectedRef((selectedRef + 1) % refPoints.length);
  }, [selectedRef, refPoints, videoDims]);

  const handleComplete = () => {
    onCalibrationComplete(points);
  };

  const handleReset = () => {
    setPoints([]);
    setSelectedRef(0);
  };

  // Use state-based video dimensions instead of ref during render
  const getDisplayPos = (pixelX: number, pixelY: number) => {
    const pctX = (pixelX / videoDims.width) * 100;
    const pctY = (pixelY / videoDims.height) * 100;
    return { left: `${pctX}%`, top: `${pctY}%` };
  };

  return (
    <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
      {/* Video with overlay */}
      <div style={{ flex: '1 1 500px', minWidth: '300px' }}>
        <div style={{ position: 'relative' }}>
          <video
            ref={videoRef}
            src={videoSrc}
            style={{ width: '100%', display: 'block', borderRadius: 'var(--radius-lg)' }}
            preload="metadata"
          />
          <div
            ref={overlayRef}
            onClick={handleVideoClick}
            style={{
              position: 'absolute',
              inset: 0,
              cursor: 'crosshair',
            }}
          >
            {/* Placed markers */}
            {points.map((p, i) => {
              const pos = getDisplayPos(p.pixel_x, p.pixel_y);
              const refIdx = refPoints.findIndex((r) => r.x === p.field_x && r.y === p.field_y);
              return (
                <div
                  key={i}
                  style={{
                    position: 'absolute',
                    left: pos.left,
                    top: pos.top,
                    transform: 'translate(-50%, -50%)',
                    width: '24px',
                    height: '24px',
                    borderRadius: '50%',
                    backgroundColor: 'var(--color-primary)',
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '0.625rem',
                    fontWeight: 700,
                    border: '2px solid white',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                    pointerEvents: 'none',
                  }}
                >
                  {refIdx + 1}
                </div>
              );
            })}
          </div>
        </div>
        <p style={{ fontSize: '0.75rem', color: 'var(--color-on-surface-secondary)', marginTop: '0.5rem' }}>
          Click on the video where the selected reference point is located.
        </p>
      </div>

      {/* Reference points panel */}
      <div style={{ flex: '0 0 280px' }}>
        <div className="card" style={{ padding: '1rem' }}>
          <h3 style={{ fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.75rem', color: 'var(--color-on-surface)' }}>
            Reference Points
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            {refPoints.map((ref, i) => {
              const isPlaced = points.some((p) => p.field_x === ref.x && p.field_y === ref.y);
              const isActive = i === selectedRef;
              return (
                <button
                  key={i}
                  onClick={() => setSelectedRef(i)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.5rem',
                    borderRadius: 'var(--radius-md)',
                    border: `2px solid ${isActive ? 'var(--color-primary)' : 'transparent'}`,
                    backgroundColor: isActive ? 'var(--color-primary-light)' : 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                    width: '100%',
                  }}
                >
                  <div
                    style={{
                      width: '20px',
                      height: '20px',
                      borderRadius: '50%',
                      backgroundColor: isPlaced ? 'var(--color-success)' : 'var(--color-border)',
                      color: isPlaced ? 'white' : 'var(--color-on-surface-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '0.625rem',
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                  >
                    {isPlaced ? '\u2713' : i + 1}
                  </div>
                  <div>
                    <div style={{ fontSize: '0.75rem', fontWeight: 500, color: 'var(--color-on-surface)' }}>
                      {ref.label}
                    </div>
                    <div style={{ fontSize: '0.625rem', color: 'var(--color-on-surface-secondary)' }}>
                      ({ref.x}m, {ref.y}m)
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
            <button onClick={handleReset} className="btn btn-secondary" style={{ flex: 1 }}>
              Reset
            </button>
            <button
              onClick={handleComplete}
              className="btn btn-primary"
              style={{ flex: 1 }}
              disabled={points.length < 4}
            >
              Complete ({points.length}/4+)
            </button>
          </div>
        </div>

        {/* Mini field reference */}
        <div className="card" style={{ padding: '1rem', marginTop: '0.75rem' }}>
          <h4 style={{ fontSize: '0.75rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--color-on-surface)' }}>
            Field Reference
          </h4>
          <svg viewBox="0 0 55 36" style={{ width: '100%', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', backgroundColor: '#166534' }}>
            {/* Field outline */}
            <rect x="0.5" y="0.5" width="54" height="35" fill="none" stroke="white" strokeWidth="0.3" />
            {/* Halfway line */}
            <line x1="27.5" y1="0.5" x2="27.5" y2="35.5" stroke="white" strokeWidth="0.3" />
            {/* Center circle */}
            <circle cx="27.5" cy="18" r="5" fill="none" stroke="white" strokeWidth="0.3" />
            {/* Reference point markers */}
            {refPoints.map((ref, i) => {
              const isPlaced = points.some((p) => p.field_x === ref.x && p.field_y === ref.y);
              const isActive = i === selectedRef;
              return (
                <circle
                  key={i}
                  cx={ref.x}
                  cy={ref.y}
                  r={isActive ? 1.5 : 1}
                  fill={isPlaced ? '#16a34a' : isActive ? '#3b82f6' : '#94a3b8'}
                  stroke="white"
                  strokeWidth="0.2"
                />
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}
