'use client';

import { useRef, useState, useCallback } from 'react';
import type { ProcessingResult } from '@/types/replay';
import TacticalCanvas from '@/components/replay/TacticalCanvas';
import TimelineControl from '@/components/replay/TimelineControl';
import ProcessingStatus from '@/components/replay/ProcessingStatus';

interface ReplayViewProps {
  videoSrc: string;
  jobId: string | null;
  cachedResult: ProcessingResult | null;
}

export default function ReplayView({ videoSrc, jobId, cachedResult }: ReplayViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [result, setResult] = useState<ProcessingResult | null>(cachedResult);
  const [error, setError] = useState<string | null>(null);
  const [isVideoReady, setIsVideoReady] = useState(false);

  const handleProcessingComplete = useCallback(async () => {
    if (!jobId) return;
    try {
      const response = await fetch(`/api/process/result/${jobId}`);
      if (response.ok) {
        const data: ProcessingResult = await response.json();
        if (!data.tracks || data.tracks.length === 0) {
          setError('Processing completed but no players were detected. Try a different video with visible players on a field.');
          return;
        }
        setResult(data);
      } else if (response.status === 202) {
        // Still processing — this shouldn't happen but handle it
        setError('Results not ready yet. Please wait and try again.');
      } else {
        const err = await response.json().catch(() => ({ error: 'Unknown error' }));
        setError((err as { error?: string }).error ?? `Failed to load results (${response.status})`);
      }
    } catch {
      setError('Failed to load results. Please check your connection and try again.');
    }
  }, [jobId]);

  if (!result && jobId) {
    if (error) {
      return (
        <div className="card p-12 flex flex-col items-center gap-4">
          <p className="text-error font-medium">{error}</p>
          <button onClick={() => setError(null)} className="btn btn-primary">
            Retry
          </button>
        </div>
      );
    }
    return (
      <ProcessingStatus
        jobId={jobId}
        onComplete={handleProcessingComplete}
        onError={setError}
      />
    );
  }

  if (!result) {
    return (
      <div className="card p-12 flex items-center justify-center">
        <p className="text-on-surface-secondary">No tracking data available</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-on-surface">Video</h2>
          <video
            ref={videoRef}
            src={videoSrc}
            onCanPlay={() => setIsVideoReady(true)}
            className="w-full rounded-lg"
            playsInline
          />
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-on-surface">Tactical Board</h2>
          {isVideoReady ? (
            <TacticalCanvas tracks={result.tracks} ball={result.ball} videoRef={videoRef} />
          ) : (
            <div
              className="card flex items-center justify-center"
              style={{ aspectRatio: '55 / 36' }}
            >
              <p className="text-on-surface-secondary text-sm">Loading video...</p>
            </div>
          )}
        </div>
      </div>

      {isVideoReady && (
        <TimelineControl
          videoRef={videoRef}
          detectionFps={result.metadata.detection_fps}
          duration={result.metadata.duration}
        />
      )}

      <div className="flex gap-4 text-xs p-3 card">
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-full bg-primary" />
          <span className="text-on-surface-secondary">Home</span>
        </div>
        <div className="flex items-center gap-1">
          <span
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: '#dc2626' }}
          />
          <span className="text-on-surface-secondary">Away</span>
        </div>
        <div className="flex items-center gap-1">
          <span
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: '#eab308' }}
          />
          <span className="text-on-surface-secondary">Referee</span>
        </div>
        <div className="flex items-center gap-1">
          <span
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: '#ffffff', border: '2px solid #000000' }}
          />
          <span className="text-on-surface-secondary">Ball</span>
        </div>
      </div>
    </div>
  );
}
