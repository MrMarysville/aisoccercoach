import type { ProcessingResult } from '@/types/replay';

/**
 * Generate realistic mock processing data for local development.
 * Creates 22 players (11 home + 11 away) with smooth movement paths
 * and a ball that moves between them.
 */
export function generateMockResult(videoId: string): ProcessingResult {
  const fps = 30;
  const duration = 60; // 1 minute of mock data
  const totalFrames = fps * duration;
  const detectionFps = fps / 3; // every 3rd frame

  const FIELD_W = 55;
  const FIELD_H = 36;

  function generatePlayerTrack(
    playerId: string,
    team: 'home' | 'away',
    baseX: number,
    baseY: number,
    wanderRadius: number,
  ) {
    const keyframes = [];
    for (let t = 0; t < duration; t += 1 / detectionFps) {
      const angle = t * 0.3 + baseX; // unique drift per player
      const x = Math.max(0, Math.min(FIELD_W,
        baseX + Math.sin(angle) * wanderRadius + Math.sin(t * 0.1) * 2));
      const y = Math.max(0, Math.min(FIELD_H,
        baseY + Math.cos(angle * 0.7) * wanderRadius * 0.6 + Math.cos(t * 0.15) * 1.5));
      keyframes.push({
        time: Math.round(t * 1000) / 1000,
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        confidence: 0.85 + Math.random() * 0.15,
      });
    }
    return { player_id: playerId, team, keyframes };
  }

  // Home team (left side) — 4-4-2 formation
  const homePositions = [
    [5, 18],   // GK
    [15, 5], [15, 14], [15, 22], [15, 31],  // defenders
    [25, 5], [25, 14], [25, 22], [25, 31],  // midfield
    [35, 12], [35, 24],                       // forwards
  ];

  // Away team (right side) — 4-4-2 formation
  const awayPositions = [
    [50, 18],  // GK
    [40, 5], [40, 14], [40, 22], [40, 31],  // defenders
    [30, 5], [30, 14], [30, 22], [30, 31],  // midfield
    [20, 12], [20, 24],                       // forwards
  ];

  const tracks = [
    ...homePositions.map(([x, y], i) =>
      generatePlayerTrack(`track_home_${i}`, 'home', x ?? 0, y ?? 0, 4)),
    ...awayPositions.map(([x, y], i) =>
      generatePlayerTrack(`track_away_${i}`, 'away', x ?? 0, y ?? 0, 4)),
  ];

  // Generate ball movement — bounces between approximate player positions
  const ball = [];
  for (let t = 0; t < duration; t += 1 / detectionFps) {
    const phase = t * 0.5;
    const x = Math.max(0, Math.min(FIELD_W,
      FIELD_W / 2 + Math.sin(phase) * 20 + Math.sin(phase * 2.3) * 5));
    const y = Math.max(0, Math.min(FIELD_H,
      FIELD_H / 2 + Math.cos(phase * 0.8) * 12 + Math.cos(phase * 1.7) * 3));
    ball.push({
      frame: Math.round(t * fps),
      time: Math.round(t * 1000) / 1000,
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
      confidence: 0.7 + Math.random() * 0.3,
      interpolated: false,
    });
  }

  return {
    metadata: {
      video_id: videoId,
      fps,
      detection_fps: detectionFps,
      duration,
      frame_count: totalFrames,
      field_template: '9v9',
      periods: [{ start_time: 0, end_time: duration }],
      processing_time_seconds: 2.5,
      detector_model: 'mock',
      imgsz: 1088,
    },
    tracks,
    ball,
  };
}
