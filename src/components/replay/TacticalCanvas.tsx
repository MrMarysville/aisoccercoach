'use client';

import { useRef, useEffect, useCallback } from 'react';
import type { RefObject } from 'react';
import type { Track, TeamLabel, BallPosition } from '@/types/replay';
import { interpolatePosition, interpolateBallPosition } from '@/lib/replay/interpolation';
import { drawField, computeScaleFactors, fieldToCanvas } from '@/lib/replay/field-renderer';

interface TacticalCanvasProps {
  tracks: Track[];
  ball?: BallPosition[];
  videoRef: RefObject<HTMLVideoElement | null>;
}

const TEAM_COLORS: Record<TeamLabel, string> = {
  home: '#2563eb',
  away: '#dc2626',
  referee: '#eab308',
  unknown: '#6b7280',
};

const DOT_RADIUS = 6;
const BALL_RADIUS = 5;
const SMOOTHING = 0.25; // 0 = no smoothing, 1 = no movement. 0.25 = smooth glide

interface SmoothedPos { x: number; y: number }

export default function TacticalCanvas({ tracks, ball, videoRef }: TacticalCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fieldCanvasRef = useRef<HTMLCanvasElement>(null);
  const playerCanvasRef = useRef<HTMLCanvasElement>(null);
  const scaleRef = useRef({ scaleX: 1, scaleY: 1 });
  const animFrameRef = useRef<number>(0);
  // Smoothed positions for players and ball — persists across frames
  const smoothedRef = useRef<Map<string, SmoothedPos>>(new Map());
  const prevTimeRef = useRef<number>(-1);

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

      // Detect scrubbing (time jumped backward or large skip) — snap instead of smooth
      const isScrub = Math.abs(t - prevTimeRef.current) > 0.5 || t < prevTimeRef.current;
      prevTimeRef.current = t;
      const smooth = isScrub ? 0 : SMOOTHING;

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, playerCanvas.clientWidth, playerCanvas.clientHeight);

      for (const track of tracks) {
        const pos = interpolatePosition(track.keyframes, t);
        if (!pos) continue;

        // Apply exponential smoothing for fluid movement during playback
        const key = track.player_id;
        const prev = smoothedRef.current.get(key);
        let sx: number, sy: number;
        if (prev && smooth > 0) {
          sx = prev.x + (pos.x - prev.x) * (1 - smooth);
          sy = prev.y + (pos.y - prev.y) * (1 - smooth);
        } else {
          sx = pos.x;
          sy = pos.y;
        }
        smoothedRef.current.set(key, { x: sx, y: sy });

        const { px, py } = fieldToCanvas(sx, sy, scaleX, scaleY);

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

      // Draw ball (on top of players)
      if (ball && ball.length > 0) {
        const ballPos = interpolateBallPosition(ball, t);
        if (ballPos) {
          // Smooth ball position too (less smoothing — ball moves faster)
          const ballKey = '__ball__';
          const prevBall = smoothedRef.current.get(ballKey);
          const ballSmooth = smooth * 0.5; // half the player smoothing
          let bsx: number, bsy: number;
          if (prevBall && ballSmooth > 0) {
            bsx = prevBall.x + (ballPos.x - prevBall.x) * (1 - ballSmooth);
            bsy = prevBall.y + (ballPos.y - prevBall.y) * (1 - ballSmooth);
          } else {
            bsx = ballPos.x;
            bsy = ballPos.y;
          }
          smoothedRef.current.set(ballKey, { x: bsx, y: bsy });

          const { px: bx, py: by } = fieldToCanvas(bsx, bsy, scaleX, scaleY);

          ctx.globalAlpha = ballPos.opacity;

          // Drop shadow for visual pop
          ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
          ctx.shadowBlur = 4;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 1;

          // White fill with black outline — distinct from player dots
          ctx.beginPath();
          ctx.arc(bx, by, BALL_RADIUS, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.strokeStyle = '#000000';
          ctx.lineWidth = 2;
          ctx.stroke();

          // Reset shadow before inner dot
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 0;

          // Small inner dot to read as "ball"
          ctx.beginPath();
          ctx.arc(bx, by, BALL_RADIUS * 0.45, 0, Math.PI * 2);
          ctx.fillStyle = '#000000';
          ctx.fill();

          ctx.globalAlpha = 1;
        }
      }

      ctx.restore();
      animFrameRef.current = requestAnimationFrame(render);
    }

    animFrameRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [tracks, ball, videoRef]);

  return (
    <div ref={containerRef} className="relative w-full" style={{ aspectRatio: '55 / 36' }}>
      <canvas ref={fieldCanvasRef} className="absolute" style={{ inset: 0 }} />
      <canvas ref={playerCanvasRef} className="absolute" style={{ inset: 0 }} />
    </div>
  );
}
