'use client';

import { useState, useCallback } from 'react';
import VideoUploader from '@/components/video/VideoUploader';
import VideoPlayer from '@/components/video/VideoPlayer';
import CalibrationOverlay from '@/components/video/CalibrationOverlay';
import TacticalBoard from '@/components/tactical/TacticalBoard';
import type { PlayerPosition, ProcessedVideoData, CalibrationPoint, CameraType } from '@/types';

type Tab = 'upload' | 'calibrate' | 'replay';

export default function Home() {
  const [activeTab, setActiveTab] = useState<Tab>('upload');
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [cameraType, setCameraType] = useState<CameraType>('fixed');
  const [currentFrame, setCurrentFrame] = useState(0);
  const [players, setPlayers] = useState<PlayerPosition[]>([]);
  const [fps, setFps] = useState(30);
  const [showGrid, setShowGrid] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleUploadComplete = (url: string, id: string, camType: CameraType) => {
    setVideoSrc(url);
    setVideoId(id);
    setCameraType(camType);
    setActiveTab('calibrate');
  };

  const handleCalibrationComplete = async (points: CalibrationPoint[]) => {
    setIsProcessing(true);
    setActiveTab('replay');

    try {
      const response = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_id: videoId,
          field_template: '9v9',
          calibration_points: points,
          camera_type: cameraType,
        }),
      });

      const result = await response.json();
      if (result.success && result.data) {
        const data = result.data as ProcessedVideoData;
        setPlayers(data.players);
        if (data.fps) setFps(data.fps);
        setCurrentFrame(0);
      }
    } catch (error) {
      console.error('Processing failed:', error);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFrameChange = useCallback((frame: number) => {
    setCurrentFrame(frame);
  }, []);

  const handleVideoPlayStateChange = useCallback(() => {
    // Sync happens through shared currentFrame state
  }, []);

  const handleJsonImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target?.result as string) as ProcessedVideoData;
        if (data.players) {
          setPlayers(data.players);
          if (data.fps) setFps(data.fps);
          setCurrentFrame(0);
        }
      } catch (error) {
        console.error('Failed to parse JSON:', error);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="min-h-screen bg-color-background">
      <header className="border-b border-color-border bg-color-surface">
        <div className="container py-4">
          <h1 className="text-xl font-bold text-on-surface">AI Soccer Coach - Tactical Board</h1>
          <p style={{ fontSize: '0.75rem', color: 'var(--color-on-surface-secondary)', marginTop: '0.25rem' }}>
            9v9 Youth Soccer Video Analysis
          </p>
        </div>
      </header>

      <main className="container py-6">
        <div className="flex flex-col gap-6">
          {/* Tab navigation */}
          <div className="flex gap-2 border-b border-color-border">
            <button
              onClick={() => setActiveTab('upload')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition ${activeTab === 'upload' ? 'border-primary text-primary' : 'border-transparent text-on-surface-secondary hover:text-on-surface hover:border-color-border-hover'}`}
            >
              1. Upload
            </button>
            {videoSrc && (
              <button
                onClick={() => setActiveTab('calibrate')}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition ${activeTab === 'calibrate' ? 'border-primary text-primary' : 'border-transparent text-on-surface-secondary hover:text-on-surface hover:border-color-border-hover'}`}
              >
                2. Calibrate
              </button>
            )}
            <button
              onClick={() => setActiveTab('replay')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition ${activeTab === 'replay' ? 'border-primary text-primary' : 'border-transparent text-on-surface-secondary hover:text-on-surface hover:border-color-border-hover'}`}
            >
              3. Replay
            </button>
          </div>

          {/* Upload tab */}
          {activeTab === 'upload' && (
            <div className="max-w-2xl">
              <VideoUploader onUploadComplete={handleUploadComplete} />
            </div>
          )}

          {/* Calibrate tab */}
          {activeTab === 'calibrate' && videoSrc && (
            <CalibrationOverlay
              videoSrc={videoSrc}
              fieldTemplate="9v9"
              onCalibrationComplete={handleCalibrationComplete}
            />
          )}

          {/* Replay tab */}
          {activeTab === 'replay' && (
            <div className="flex flex-col gap-6">
              {!videoSrc && players.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-12 card">
                  <p className="text-on-surface-secondary mb-4">No video loaded</p>
                  <button onClick={() => setActiveTab('upload')} className="btn btn-primary">
                    Upload Video
                  </button>
                </div>
              ) : isProcessing ? (
                <div className="flex flex-col items-center justify-center p-12 card">
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm text-on-surface-secondary">
                      Processing video with {cameraType === 'ptz' ? 'PTZ' : 'fixed'} camera mode...
                    </p>
                    <p className="text-xs text-on-surface-secondary">
                      Detecting players and mapping positions to field coordinates
                    </p>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Left: Video Player */}
                  <div className="flex flex-col gap-4">
                    {videoSrc ? (
                      <VideoPlayer
                        videoSrc={videoSrc}
                        currentFrame={currentFrame}
                        onFrameChange={handleFrameChange}
                        fps={fps}
                        onPlayStateChange={handleVideoPlayStateChange}
                      />
                    ) : (
                      <div className="card" style={{ padding: '3rem', textAlign: 'center' }}>
                        <p style={{ color: 'var(--color-on-surface-secondary)', fontSize: '0.875rem' }}>
                          No video loaded. The tactical board can still replay imported data.
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Right: Tactical Board */}
                  <div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between">
                      <h2 className="text-lg font-semibold text-on-surface">Tactical Board</h2>
                      <label className="flex items-center gap-2 text-sm text-on-surface-secondary" style={{ cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={showGrid}
                          onChange={(e) => setShowGrid(e.target.checked)}
                          className="rounded"
                        />
                        Show Grid
                      </label>
                    </div>

                    <TacticalBoard
                      players={players}
                      currentFrame={currentFrame}
                      fieldTemplate="9v9"
                      showGrid={showGrid}
                      fps={fps}
                      onFrameChange={handleFrameChange}
                    />

                    {/* Import JSON */}
                    <div className="card" style={{ padding: '0.75rem' }}>
                      <div className="flex items-center justify-between" style={{ marginBottom: '0.5rem' }}>
                        <span className="text-sm font-medium text-on-surface">Import Position Data</span>
                        <span className="text-xs text-on-surface-secondary">JSON format</span>
                      </div>
                      <input type="file" accept=".json" onChange={handleJsonImport} className="input" />
                    </div>

                    {/* Player stats */}
                    <div className="card" style={{ padding: '0.75rem' }}>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-on-surface">Players Tracked</span>
                        <span className="text-sm text-on-surface-secondary">
                          {players.filter((p) => p.frame === currentFrame).length} in frame
                        </span>
                      </div>
                      <div className="flex gap-4" style={{ marginTop: '0.5rem', fontSize: '0.75rem' }}>
                        <div className="flex items-center gap-1">
                          <span className="w-3 h-3 rounded-full" style={{ display: 'inline-block', backgroundColor: '#2563eb' }} />
                          <span className="text-on-surface-secondary">Home</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="w-3 h-3 rounded-full" style={{ display: 'inline-block', backgroundColor: '#dc2626' }} />
                          <span className="text-on-surface-secondary">Away</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="w-3 h-3 rounded-full" style={{ display: 'inline-block', backgroundColor: '#6b7280' }} />
                          <span className="text-on-surface-secondary">Unknown</span>
                        </div>
                      </div>
                      {cameraType === 'ptz' && (
                        <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--color-warning)' }}>
                          PTZ mode: Per-frame homography applied
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
