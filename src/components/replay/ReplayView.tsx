'use client';

import { useRef, useState, useCallback } from 'react';
import Image from 'next/image';
import type { JobStatus, ProcessingResult } from '@/types/replay';
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
  const [failure, setFailure] = useState<JobStatus | null>(null);
  const [isVideoReady, setIsVideoReady] = useState(false);

  const handleProcessingComplete = useCallback(async () => {
    if (!jobId) return;
    try {
      const response = await fetch(`/api/process/result/${jobId}`);
      if (response.ok) {
        const data: ProcessingResult = await response.json();
        if (!data.tracks || data.tracks.length === 0) {
          setFailure({
            status: 'failed',
            error: 'Processing completed but no players were detected. Try a different video with visible players on a field.',
            calibration: data.metadata.calibration,
          });
          return;
        }
        setFailure(null);
        setResult(data);
      } else if (response.status === 202) {
        // Still processing — this shouldn't happen but handle it
        setFailure({ status: 'failed', error: 'Results not ready yet. Please wait and try again.' });
      } else {
        const err = await response.json().catch(() => ({ error: 'Unknown error' })) as JobStatus;
        setFailure({
          status: 'failed',
          error: err.error ?? `Failed to load results (${response.status})`,
          failure_code: err.failure_code,
          calibration: err.calibration,
        });
      }
    } catch {
      setFailure({ status: 'failed', error: 'Failed to load results. Please check your connection and try again.' });
    }
  }, [jobId]);

  if (!result && jobId) {
    if (failure) {
      const calibration = failure.calibration;
      return (
        <div className="card p-8 flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <p className="text-error font-medium">{failure.error}</p>
            {failure.failure_code && (
              <p className="text-xs text-on-surface-secondary">Failure code: {failure.failure_code}</p>
            )}
          </div>

          {calibration && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div className="card p-3">
                <p className="text-on-surface-secondary">Coverage</p>
                <p className="text-on-surface font-medium">{Math.round(calibration.coverage_ratio * 100)}%</p>
              </div>
              <div className="card p-3">
                <p className="text-on-surface-secondary">Longest Gap</p>
                <p className="text-on-surface font-medium">{calibration.longest_gap_seconds}s</p>
              </div>
              <div className="card p-3">
                <p className="text-on-surface-secondary">Line IoU</p>
                <p className="text-on-surface font-medium">{calibration.median_anchor_line_iou ?? 'n/a'}</p>
              </div>
              <div className="card p-3">
                <p className="text-on-surface-secondary">Jitter</p>
                <p className="text-on-surface font-medium">{calibration.median_landmark_jitter_px ?? 'n/a'}px</p>
              </div>
            </div>
          )}

          {calibration?.preview_frames && calibration.preview_frames.length > 0 && (
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium text-on-surface">Calibration Preview Frames</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {calibration.preview_frames.map((preview) => (
                  <div key={`${preview.frame}-${preview.time}`} className="card p-3 flex flex-col gap-2">
                    <Image
                      src={preview.data_url}
                      alt={`Calibration preview frame ${preview.frame}`}
                      width={640}
                      height={360}
                      unoptimized
                      className="w-full h-auto rounded-md"
                    />
                    <p className="text-xs text-on-surface-secondary">
                      Frame {preview.frame} at {preview.time}s · {preview.source}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <button onClick={() => setFailure(null)} className="btn btn-primary self-start">
            Retry
          </button>
        </div>
      );
    }
    return (
      <ProcessingStatus
        jobId={jobId}
        onComplete={handleProcessingComplete}
        onError={setFailure}
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

      {result.metadata.calibration && (
        <div className="card p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-on-surface">Calibration Check</h3>
            <span className="text-xs text-on-surface-secondary">
              {result.metadata.calibration.status === 'passed' ? 'Passed' : 'Failed'}
            </span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div className="card p-3">
              <p className="text-on-surface-secondary">Coverage</p>
              <p className="text-on-surface font-medium">{Math.round(result.metadata.calibration.coverage_ratio * 100)}%</p>
            </div>
            <div className="card p-3">
              <p className="text-on-surface-secondary">Longest Gap</p>
              <p className="text-on-surface font-medium">{result.metadata.calibration.longest_gap_seconds}s</p>
            </div>
            <div className="card p-3">
              <p className="text-on-surface-secondary">Line IoU</p>
              <p className="text-on-surface font-medium">{result.metadata.calibration.median_anchor_line_iou ?? 'n/a'}</p>
            </div>
            <div className="card p-3">
              <p className="text-on-surface-secondary">Jitter</p>
              <p className="text-on-surface font-medium">{result.metadata.calibration.median_landmark_jitter_px ?? 'n/a'}px</p>
            </div>
          </div>

          {result.metadata.calibration.preview_frames && result.metadata.calibration.preview_frames.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {result.metadata.calibration.preview_frames.map((preview) => (
                <div key={`${preview.frame}-${preview.time}`} className="card p-3 flex flex-col gap-2">
                  <Image
                    src={preview.data_url}
                    alt={`Calibration preview frame ${preview.frame}`}
                    width={640}
                    height={360}
                    unoptimized
                    className="w-full h-auto rounded-md"
                  />
                  <p className="text-xs text-on-surface-secondary">
                    Frame {preview.frame} at {preview.time}s · {preview.source}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
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
