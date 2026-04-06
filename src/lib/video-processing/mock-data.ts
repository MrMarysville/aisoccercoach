import type { PlayerPosition, ProcessedVideoData, FieldTemplate, CameraType } from '@/types';
import { FIELD_DIMENSIONS } from '@/types';

interface MockOptions {
  video_id: string;
  field_template: FieldTemplate;
  camera_type: CameraType;
  duration_seconds?: number;
  fps?: number;
}

/** 9v9 starting formations (field coordinates in meters, 55x36m field) */
const FORMATIONS_9V9 = {
  home: [
    { id: 'H1', x: 2, y: 18, role: 'GK' },       // Goalkeeper
    { id: 'H2', x: 10, y: 6, role: 'LB' },        // Left Back
    { id: 'H3', x: 10, y: 18, role: 'CB' },       // Center Back
    { id: 'H4', x: 10, y: 30, role: 'RB' },       // Right Back
    { id: 'H5', x: 20, y: 9, role: 'LM' },        // Left Mid
    { id: 'H6', x: 20, y: 18, role: 'CM' },       // Center Mid
    { id: 'H7', x: 20, y: 27, role: 'RM' },       // Right Mid
    { id: 'H8', x: 30, y: 12, role: 'LF' },       // Left Forward
    { id: 'H9', x: 30, y: 24, role: 'RF' },       // Right Forward
  ],
  away: [
    { id: 'A1', x: 53, y: 18, role: 'GK' },
    { id: 'A2', x: 45, y: 30, role: 'LB' },
    { id: 'A3', x: 45, y: 18, role: 'CB' },
    { id: 'A4', x: 45, y: 6, role: 'RB' },
    { id: 'A5', x: 35, y: 27, role: 'LM' },
    { id: 'A6', x: 35, y: 18, role: 'CM' },
    { id: 'A7', x: 35, y: 9, role: 'RM' },
    { id: 'A8', x: 25, y: 24, role: 'LF' },
    { id: 'A9', x: 25, y: 12, role: 'RF' },
  ],
};

export function generateMockData(options: MockOptions): ProcessedVideoData {
  const {
    video_id,
    field_template,
    camera_type,
    duration_seconds = 30,
    fps = 30,
  } = options;

  const dims = FIELD_DIMENSIONS[field_template];
  const totalFrames = duration_seconds * fps;
  const players: PlayerPosition[] = [];

  const allPlayers = [
    ...FORMATIONS_9V9.home.map((p) => ({ ...p, team: 'home' as const })),
    ...FORMATIONS_9V9.away.map((p) => ({ ...p, team: 'away' as const })),
  ];

  // Generate per-player movement trajectories
  const trajectories = allPlayers.map((player) => {
    return generateTrajectory(player.x, player.y, player.role, totalFrames, dims, fps);
  });

  // Build PlayerPosition array
  for (let frame = 0; frame < totalFrames; frame++) {
    const time = frame / fps;
    for (let pi = 0; pi < allPlayers.length; pi++) {
      const player = allPlayers[pi];
      const pos = trajectories[pi][frame];
      players.push({
        frame,
        time,
        player_id: player.id,
        x: pos.x,
        y: pos.y,
        team: player.team,
        confidence: 0.85 + Math.random() * 0.15,
      });
    }
  }

  return {
    video_id,
    frame_count: totalFrames,
    fps,
    field_template,
    players,
    camera_type,
  };
}

function generateTrajectory(
  startX: number,
  startY: number,
  role: string,
  totalFrames: number,
  dims: { width: number; height: number },
  fps: number
): { x: number; y: number }[] {
  const positions: { x: number; y: number }[] = [];
  let x = startX;
  let y = startY;

  // Movement parameters based on role
  const isGK = role === 'GK';
  const speed = isGK ? 0.3 : 1.2; // meters per second
  const wanderRadius = isGK ? 3 : 8;

  // Use waypoint system: pick random target, move toward it
  let targetX = x;
  let targetY = y;
  let waypointTimer = 0;

  // Seed a deterministic-ish random from role string
  let seed = role.charCodeAt(0) * 137 + role.charCodeAt(1) * 31;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 1000) / 1000;
  };

  for (let frame = 0; frame < totalFrames; frame++) {
    waypointTimer--;
    if (waypointTimer <= 0) {
      // Pick new waypoint near starting position
      targetX = startX + (rand() - 0.5) * wanderRadius * 2;
      targetY = startY + (rand() - 0.5) * wanderRadius * 2;
      // Clamp to field
      targetX = Math.max(1, Math.min(dims.width - 1, targetX));
      targetY = Math.max(1, Math.min(dims.height - 1, targetY));
      waypointTimer = Math.floor(fps * (1 + rand() * 3)); // 1-4 seconds
    }

    // Move toward target
    const dx = targetX - x;
    const dy = targetY - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const stepSize = speed / fps;

    if (dist > stepSize) {
      x += (dx / dist) * stepSize;
      y += (dy / dist) * stepSize;
    } else {
      x = targetX;
      y = targetY;
    }

    // Add small noise for natural movement
    x += (rand() - 0.5) * 0.05;
    y += (rand() - 0.5) * 0.05;

    // Clamp
    x = Math.max(0, Math.min(dims.width, x));
    y = Math.max(0, Math.min(dims.height, y));

    positions.push({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 });
  }

  return positions;
}
