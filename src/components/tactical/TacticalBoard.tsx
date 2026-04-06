'use client';

import { useMemo, useState, useEffect, useRef } from 'react';
import FieldTemplate from './FieldTemplate';
import PlayerMarker from './PlayerMarker';
import type { PlayerPosition, FieldTemplate as FieldTemplateType } from '@/types';

interface TacticalBoardProps {
  players: PlayerPosition[];
  currentFrame: number;
  fieldTemplate: FieldTemplateType;
  showGrid?: boolean;
  fps?: number;
  onFrameChange?: (frame: number) => void;
}

export default function TacticalBoard({
  players,
  currentFrame,
  fieldTemplate,
  showGrid = false,
  fps = 30,
  onFrameChange,
}: TacticalBoardProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const maxFrame = useMemo(() => {
    if (players.length === 0) return 0;
    return Math.max(...players.map((p) => p.frame));
  }, [players]);

  const currentPlayers = useMemo(() => {
    return players.filter((p) => p.frame === currentFrame);
  }, [players, currentFrame]);

  // Auto-play logic
  useEffect(() => {
    if (isPlaying && onFrameChange) {
      const intervalMs = 1000 / (fps * speed);
      intervalRef.current = setInterval(() => {
        if (currentFrame >= maxFrame) {
          setIsPlaying(false);
          return;
        }
        onFrameChange(currentFrame + 1);
      }, intervalMs);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isPlaying, fps, speed, currentFrame, maxFrame, onFrameChange]);

  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  const togglePlay = () => {
    if (currentFrame >= maxFrame) {
      onFrameChange?.(0);
    }
    setIsPlaying(!isPlaying);
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const frame = parseInt(e.target.value, 10);
    onFrameChange?.(frame);
  };

  const cycleSpeed = () => {
    const speeds = [0.25, 0.5, 1, 2];
    const idx = speeds.indexOf(speed);
    setSpeed(speeds[(idx + 1) % speeds.length]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <FieldTemplate fieldTemplate={fieldTemplate} showGrid={showGrid}>
        {currentPlayers.map((player) => (
          <PlayerMarker
            key={player.player_id}
            x={player.x}
            y={player.y}
            playerId={player.player_id}
            team={player.team}
            confidence={player.confidence}
          />
        ))}
      </FieldTemplate>

      {/* Board playback controls */}
      {players.length > 0 && onFrameChange && (
        <div className="card" style={{ padding: '0.5rem 0.75rem' }}>
          <input
            type="range"
            min={0}
            max={maxFrame}
            value={currentFrame}
            onChange={handleSliderChange}
            style={{ width: '100%', cursor: 'pointer', marginBottom: '0.375rem' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <button
                onClick={togglePlay}
                className="btn btn-primary"
                style={{ padding: '0.125rem 0.5rem', fontSize: '0.75rem' }}
              >
                {isPlaying ? '||' : '\u25B6'}
              </button>
              <button
                onClick={cycleSpeed}
                className="btn btn-secondary"
                style={{ padding: '0.125rem 0.5rem', fontSize: '0.75rem' }}
              >
                {speed}x
              </button>
            </div>
            <span style={{ fontSize: '0.675rem', color: 'var(--color-on-surface-secondary)' }}>
              Frame {currentFrame} / {maxFrame}
            </span>
          </div>
        </div>
      )}

      {players.length === 0 && (
        <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--color-on-surface-secondary)', fontSize: '0.875rem' }}>
          No player data loaded. Process a video or import JSON data.
        </div>
      )}
    </div>
  );
}
