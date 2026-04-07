'use client';

import { useRef, useEffect, useCallback } from 'react';
import type { RefObject } from 'react';
import type { Track, TeamLabel } from '@/types/replay';
import { interpolatePosition } from '@/lib/replay/interpolation';
import { drawField, computeScaleFactors, fieldToCanvas } from '@/lib/replay/field-renderer';

interface TacticalCanvasProps {
  tracks: Track[];
  videoRef: RefObject<HTMLVideoElement | null>;
}

const TEAM_COLORS: Record<TeamLabel, string> = {
  home: '#2563eb',
  away: '#dc2626',
  referee: '#eab308',
  unknown: '#6b7280',
};

const DOT_RADIUS = 6;

export default function TacticalCanvas({ tracks, videoRef }: TacticalCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fieldCanvasRef = useRef<HTMLCanvasElement>(null);
  const playerCanvasRef = useRef<HTMLCanvasElement>(null);
  const scaleRef = useRef({ scaleX: 1, scaleY: 1 });
  const animFrameRef = useRef<number>(0);

  const resizeCanvases = useCallback(() => {
    const container = containerRef.current;
    const fieldCanvas = fieldCanvasRef.current;
    const playerCanvas = playerCanvasRef.current;
    if (!container || !fieldCanvas || !playerCanvas) return;

    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = container.clientHeight;

    for (const canvas of [fieldCanvas, playerCanvas]) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    const fieldCtx = fieldCanvas.getContext('2d');
    if (fieldCtx) {
      fieldCtx.scale(dpr, dpr);
      drawField(fieldCtx, width, height);
    }

    scaleRef.current = computeScaleFactors(width, height);
  }, []);

  useEffect(() => {
    resizeCanvases();
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(resizeCanvases);
    observer.observe(container);
    return () => observer.disconnect();
  }, [resizeCanvases]);

  useEffect(() => {
    const playerCanvas = playerCanvasRef.current;
    const video = videoRef.current;
    if (!playerCanvas || !video) return;

    const ctx = playerCanvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;

    function render() {
      if (!ctx || !video || !playerCanvas) return;

      const t = video.currentTime;
      const { scaleX, scaleY } = scaleRef.current;

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, playerCanvas.clientWidth, playerCanvas.clientHeight);

      for (const track of tracks) {
        const pos = interpolatePosition(track.keyframes, t);
        if (!pos) continue;

        const { px, py } = fieldToCanvas(pos.x, pos.y, scaleX, scaleY);

        ctx.globalAlpha = pos.opacity;
        ctx.beginPath();
        ctx.arc(px, py, DOT_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = TEAM_COLORS[track.team];
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      ctx.restore();
      animFrameRef.current = requestAnimationFrame(render);
    }

    animFrameRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [tracks, videoRef]);

  return (
    <div ref={containerRef} className="relative w-full" style={{ aspectRatio: '55 / 36' }}>
      <canvas ref={fieldCanvasRef} className="absolute" style={{ inset: 0 }} />
      <canvas ref={playerCanvasRef} className="absolute" style={{ inset: 0 }} />
    </div>
  );
}
