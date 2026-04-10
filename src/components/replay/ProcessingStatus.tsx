'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { JobStatus } from '@/types/replay';

interface ProcessingStatusProps {
  jobId: string;
  onComplete: () => void;
  onError: (error: JobStatus) => void;
}

const STAGE_LABELS: Record<string, string> = {
  starting: 'Starting...',
  transcoding: 'Transcoding video',
  field_evidence: 'Extracting field evidence',
  camera_motion: 'Analyzing camera motion',
  field_calibration: 'Detecting field lines',
  calibration_validation: 'Validating calibration',
  calibration_debug: 'Rendering calibration debug',
  detection: 'Detecting players & ball',
  tracking: 'Tracking players',
  classification: 'Classifying teams',
  transform: 'Computing positions',
  done: 'Complete',
};

const POLL_INTERVAL = 5000;
const MAX_CONSECUTIVE_FAILURES = 6; // 30s of failed polls before showing error
const PROCESSING_TIMEOUT = 30 * 60 * 1000; // 30 minutes max

export default function ProcessingStatus({
  jobId,
  onComplete,
  onError,
}: ProcessingStatusProps) {
  const [status, setStatus] = useState<JobStatus>({
    status: 'processing',
    stage: 'starting',
    percent: 0,
  });
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startTimeRef = useRef(0);

  // Initialize start time in effect (not during render)
  useEffect(() => {
    startTimeRef.current = Date.now();
  }, []);

  // Tick elapsed time every second
  useEffect(() => {
    const timer = setInterval(() => {
      if (startTimeRef.current > 0) {
        setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const poll = useCallback(async () => {
    // Check timeout
    if (startTimeRef.current > 0 && Date.now() - startTimeRef.current > PROCESSING_TIMEOUT) {
      onError({
        status: 'failed',
        error: 'Processing timed out after 30 minutes. The video may be too long or the server may be overloaded.',
      });
      return;
    }

    try {
      const response = await fetch(`/api/process/status/${jobId}`);

      if (!response.ok) {
        setConsecutiveFailures(prev => {
          const next = prev + 1;
          if (next >= MAX_CONSECUTIVE_FAILURES) {
            onError({
              status: 'failed',
              error: `Lost connection to server (${response.status}). Please refresh and try again.`,
            });
          }
          return next;
        });
        return;
      }

      setConsecutiveFailures(0);
      const data: JobStatus = await response.json();
      setStatus(data);

      if (data.status === 'complete') onComplete();
      if (data.status === 'failed') {
        onError({
          ...data,
          error: data.error ?? 'Processing failed',
        });
      }
    } catch {
      setConsecutiveFailures(prev => {
        const next = prev + 1;
        if (next >= MAX_CONSECUTIVE_FAILURES) {
          onError({
            status: 'failed',
            error: 'Lost connection to server. Please check your internet and try again.',
          });
        }
        return next;
      });
    }
  }, [jobId, onComplete, onError]);

  useEffect(() => {
    const timeout = setTimeout(poll, 0);
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [poll]);

  const stageLabel = STAGE_LABELS[status.stage ?? ''] ?? status.stage ?? 'Processing';
  const percent = status.percent ?? 0;
  const elapsedMin = Math.floor(elapsedSeconds / 60);
  const elapsedSec = elapsedSeconds % 60;

  return (
    <div className="card p-12 flex flex-col items-center gap-4">
      <div
        className="w-8 h-8 border-4 border-primary rounded-full animate-spin"
        style={{ borderTopColor: 'transparent' }}
      />
      <div className="flex flex-col items-center gap-1">
        <p className="font-medium text-on-surface">{stageLabel}</p>
        <p className="text-sm text-on-surface-secondary">
          {percent}% complete
        </p>
      </div>
      <div
        className="w-full h-3 rounded-full bg-color-border overflow-hidden"
        style={{ maxWidth: '20rem' }}
      >
        <div
          className="h-full bg-primary rounded-full transition"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-xs text-on-surface-secondary">
        {elapsedMin > 0 ? `${elapsedMin}m ${elapsedSec}s elapsed` : `${elapsedSec}s elapsed`}
        {consecutiveFailures > 0 && ' (reconnecting...)'}
      </p>
    </div>
  );
}
