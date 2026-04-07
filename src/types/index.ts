// Player position data
export interface PlayerPosition {
  frame: number;
  time: number; // in seconds
  player_id: string;
  x_meters: number;
  y_meters: number;
  team: 'home' | 'away' | 'unknown';
  confidence?: number;
}

// Processed video output
export interface ProcessedVideoData {
  video_id: string;
  frame_count: number;
  fps: number;
  duration: number;
  width: number;
  height: number;
  players: PlayerPosition[];
  field_template: '9v9' | '11v11';
  calibration_points?: CalibrationPoint[];
}

// Calibration points for homography
export interface CalibrationPoint {
  pixel_x: number;
  pixel_y: number;
  field_x: number; // meters
  field_y: number; // meters
}

// Field template dimensions (in meters)
export const FIELD_DIMENSIONS = {
  '9v9': { width: 55, height: 36 }, // 60x40 yards converted to meters
  '11v11': { width: 105, height: 68 },
} as const;

// API Response types
export interface UploadResponse {
  success: boolean;
  video_id: string;
  video_url?: string;
  message?: string;
}

export interface ProcessResponse {
  success: boolean;
  data?: ProcessedVideoData;
  message?: string;
}

export interface CalibrationResponse {
  success: boolean;
  calibration_id?: string;
  message?: string;
}