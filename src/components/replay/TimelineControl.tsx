'use client';

import { useState, useCallback, useEffect } from 'react';
import type { RefObject, ChangeEvent } from 'react';

interface TimelineControlProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  detectionFps: number;
  duration: number;
}

const SPEEDS = [0.5, 1, 2] as const;

export default function TimelineControl({
  videoRef,
  detectionFps,
  duration,
}: TimelineControlProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
    };
  }, [videoRef]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play();
    } else {
      video.pause();
    }
  }, [videoRef]);

  const handleSeek = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = Number(e.target.value);
    },
    [videoRef],
  );

  const handleSpeed = useCallback(
    (newSpeed: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.playbackRate = newSpeed;
      setSpeed(newSpeed);
    },
    [videoRef],
  );

  const stepFrame = useCallback(
    (direction: 1 | -1) => {
      const video = videoRef.current;
      if (!video) return;
      video.pause();
      video.currentTime += direction / detectionFps;
    },
    [videoRef, detectionFps],
  );

  const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col gap-2 p-3 card">
      <input
        type="range"
        min={0}
        max={duration}
        step={0.1}
        value={currentTime}
        onChange={handleSeek}
        className="w-full"
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => stepFrame(-1)}
            className="btn btn-sm text-on-surface-secondary"
          >
            &lt;
          </button>
          <button onClick={togglePlay} className="btn btn-sm btn-primary">
            {isPlaying ? 'Pause' : 'Play'}
          </button>
          <button
            onClick={() => stepFrame(1)}
            className="btn btn-sm text-on-surface-secondary"
          >
            &gt;
          </button>
        </div>
        <span className="text-sm text-on-surface-secondary">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
        <div className="flex items-center gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => handleSpeed(s)}
              className={`btn btn-sm ${speed === s ? 'btn-primary' : 'text-on-surface-secondary'}`}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
