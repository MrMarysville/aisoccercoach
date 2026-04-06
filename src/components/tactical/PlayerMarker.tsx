'use client';

import { motion } from 'framer-motion';
import type { TeamId } from '@/types';

interface PlayerMarkerProps {
  x: number;
  y: number;
  playerId: string;
  team: TeamId;
  confidence: number;
  label?: string;
}

const TEAM_COLORS: Record<TeamId, string> = {
  home: '#2563eb',
  away: '#dc2626',
  unknown: '#6b7280',
};

export default function PlayerMarker({
  x,
  y,
  playerId,
  team,
  confidence,
  label,
}: PlayerMarkerProps) {
  const color = TEAM_COLORS[team];
  const displayLabel = label || playerId.replace(/^[HA]/, '');

  return (
    <motion.g
      animate={{ x, y }}
      transition={{ duration: 0.15, ease: 'linear' }}
      opacity={Math.max(0.4, confidence)}
    >
      {/* Outer glow */}
      <circle r={1.2} fill={color} opacity={0.3} />
      {/* Player dot */}
      <circle r={0.8} fill={color} stroke="white" strokeWidth={0.15} />
      {/* Label */}
      <text
        y={-1.4}
        textAnchor="middle"
        fill="white"
        fontSize={0.9}
        fontWeight={700}
        style={{ textShadow: '0 0 2px rgba(0,0,0,0.8)', pointerEvents: 'none' }}
      >
        {displayLabel}
      </text>
    </motion.g>
  );
}
