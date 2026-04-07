'use client';

import { useState, useCallback } from 'react';
import VideoUploader from '@/components/video/VideoUploader';
import ReplayView from '@/components/replay/ReplayView';
import type { ProcessingResult, ProcessJobResponse } from '@/types/replay';

type Tab = 'upload' | 'replay';

export default function Home() {
  const [activeTab, setActiveTab] = useState<Tab>('upload');
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [cachedResult, setCachedResult] = useState<ProcessingResult | null>(null);

  const handleUploadComplete = useCallback(async (blobUrl: string, id: string) => {
    setVideoSrc(blobUrl);
    setActiveTab('replay');

    try {
      const response = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_url: blobUrl, video_id: id }),
      });

      const data: Record<string, unknown> = await response.json();

      if (data.cached && typeof data.result_url === 'string') {
        const resultResponse = await fetch(data.result_url);
        const result: ProcessingResult = await resultResponse.json();
        setCachedResult(result);
      } else {
        const jobResponse = data as unknown as ProcessJobResponse;
        setJobId(jobResponse.job_id);
      }
    } catch (error) {
      console.error('Failed to start processing:', error);
    }
  }, []);

  return (
    <div className="min-h-screen bg-color-background">
      <header className="border-b border-color-border bg-color-surface">
        <div className="container py-4">
          <h1 className="text-xl font-bold text-on-surface">AI Soccer Coach</h1>
        </div>
      </header>

      <main className="container py-6">
        <div className="flex flex-col gap-6">
          <div className="flex gap-2 border-b border-color-border">
            <button
              onClick={() => setActiveTab('upload')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition ${activeTab === 'upload' ? 'border-primary text-primary' : 'border-transparent text-on-surface-secondary'}`}
            >
              Upload
            </button>
            {videoSrc && (
              <button
                onClick={() => setActiveTab('replay')}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition ${activeTab === 'replay' ? 'border-primary text-primary' : 'border-transparent text-on-surface-secondary'}`}
              >
                Replay
              </button>
            )}
          </div>

          {activeTab === 'upload' && (
            <div className="max-w-2xl">
              <VideoUploader onUploadComplete={handleUploadComplete} />
            </div>
          )}

          {activeTab === 'replay' && videoSrc && (
            <ReplayView videoSrc={videoSrc} jobId={jobId} cachedResult={cachedResult} />
          )}
        </div>
      </main>
    </div>
  );
}
