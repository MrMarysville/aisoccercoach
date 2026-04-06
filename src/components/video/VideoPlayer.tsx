'use client';

import { useRef, useState, useEffect } from 'react';

interface VideoPlayerProps {
  videoSrc: string;
  currentFrame: number;
  onFrameChange: (frame: number) => void;
  fps?: number;
  onPlayStateChange?: (playing: boolean) => void;
}

const SPEEDS = [0.25, 0.5, 1, 2];

export default function VideoPlayer({
  videoSrc,
  currentFrame,
  onFrameChange,
  fps = 30,
  onPlayStateChange,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [speed, setSpeed] = useState(1);
  const animFrameRef = useRef<number>(0);
  const onFrameChangeRef = useRef(onFrameChange);
  useEffect(() => {
    onFrameChangeRef.current = onFrameChange;
  }, [onFrameChange]);

  const totalFrames = Math.floor(duration * fps);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const syncFrame = () => {
      if (!video) return;
      const frame = Math.floor(video.currentTime * fps);
      setCurrentTime(video.currentTime);
      onFrameChangeRef.current(frame);
      if (!video.paused) {
        animFrameRef.current = requestAnimationFrame(syncFrame);
      }
    };

    const onLoadedMetadata = () => setDuration(video.duration);
    const onPlay = () => {
      setIsPlaying(true);
      onPlayStateChange?.(true);
      animFrameRef.current = requestAnimationFrame(syncFrame);
    };
    const onPause = () => {
      setIsPlaying(false);
      onPlayStateChange?.(false);
      cancelAnimationFrame(animFrameRef.current);
      syncFrame();
    };
    const onEnded = () => {
      setIsPlaying(false);
      onPlayStateChange?.(false);
    };

    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);

    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      cancelAnimationFrame(animFrameRef.current);
    };
  }, [fps, onPlayStateChange]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play();
    } else {
      video.pause();
    }
  };

  const seekToFrame = (frame: number) => {
    const video = videoRef.current;
    if (!video) return;
    const clamped = Math.max(0, Math.min(totalFrames - 1, frame));
    video.currentTime = clamped / fps;
    onFrameChange(clamped);
  };

  const stepFrame = (delta: number) => {
    seekToFrame(currentFrame + delta);
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    seekToFrame(parseInt(e.target.value, 10));
  };

  const cycleSpeed = () => {
    const idx = SPEEDS.indexOf(speed);
    const next = SPEEDS[(idx + 1) % SPEEDS.length];
    setSpeed(next);
    if (videoRef.current) videoRef.current.playbackRate = next;
  };

  const formatTime = (t: number) => {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <video
        ref={videoRef}
        src={videoSrc}
        style={{ width: '100%', display: 'block', backgroundColor: '#000' }}
        playsInline
        preload="metadata"
      />

      <div style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {/* Frame slider */}
        <input
          type="range"
          min={0}
          max={totalFrames > 0 ? totalFrames - 1 : 0}
          value={currentFrame}
          onChange={handleSliderChange}
          style={{ width: '100%', cursor: 'pointer' }}
        />

        {/* Controls row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              onClick={() => stepFrame(-1)}
              className="btn btn-secondary"
              style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
              title="Previous frame"
            >
              {'<'}
            </button>

            <button
              onClick={togglePlay}
              className="btn btn-primary"
              style={{ padding: '0.25rem 0.75rem', fontSize: '0.875rem', minWidth: '3rem' }}
            >
              {isPlaying ? '||' : '\u25B6'}
            </button>

            <button
              onClick={() => stepFrame(1)}
              className="btn btn-secondary"
              style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
              title="Next frame"
            >
              {'>'}
            </button>

            <button
              onClick={cycleSpeed}
              className="btn btn-secondary"
              style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
              title="Playback speed"
            >
              {speed}x
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', fontSize: '0.75rem', color: 'var(--color-on-surface-secondary)' }}>
            <span>Frame {currentFrame} / {totalFrames}</span>
            <span>{formatTime(currentTime)} / {formatTime(duration)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
