'use client';

import { useState, useEffect, useCallback } from 'react';
import type { JobStatus } from '@/types/replay';

interface ProcessingStatusProps {
  jobId: string;
  onComplete: () => void;
  onError: (error: string) => void;
}

const STAGE_LABELS: Record<string, string> = {
  starting: 'Starting...',
  transcoding: 'Transcoding video',
  camera_motion: 'Analyzing camera motion',
  field_calibration: 'Detecting field lines',
  detection: 'Detecting players',
  tracking: 'Tracking players',
  classification: 'Classifying teams',
  transform: 'Computing positions',
  done: 'Complete',
};

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

  const poll = useCallback(async () => {
    try {
      const response = await fetch(`/api/process/status/${jobId}`);
      if (!response.ok) return;

      const data: JobStatus = await response.json();
      setStatus(data);

      if (data.status === 'complete') onComplete();
      if (data.status === 'failed') onError(data.error ?? 'Processing failed');
    } catch {
      // Silent failure — will retry on next poll
    }
  }, [jobId, onComplete, onError]);

  useEffect(() => {
    const timeout = setTimeout(poll, 0);
    const interval = setInterval(poll, 5000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [poll]);

  const stageLabel = STAGE_LABELS[status.stage ?? ''] ?? status.stage ?? 'Processing';
  const percent = status.percent ?? 0;

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
          {status.eta_seconds != null
            ? ` \u2022 ~${Math.ceil(status.eta_seconds / 60)} min remaining`
            : ''}
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
        Processing typically takes 20–25 minutes for a full match
      </p>
    </div>
  );
}
