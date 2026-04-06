export type CameraType = 'fixed' | 'ptz';

export type TeamId = 'home' | 'away' | 'unknown';

export type FieldTemplate = '9v9' | '11v11';

export interface PlayerPosition {
  frame: number;
  time: number;
  player_id: string;
  x: number;
  y: number;
  team: TeamId;
  confidence: number;
}

export interface ProcessedVideoData {
  video_id: string;
  frame_count: number;
  fps: number;
  field_template: FieldTemplate;
  players: PlayerPosition[];
  camera_type: CameraType;
}

export interface CalibrationPoint {
  pixel_x: number;
  pixel_y: number;
  field_x: number;
  field_y: number;
}

export interface FieldDimension {
  width: number;
  height: number;
}

export const FIELD_DIMENSIONS: Record<FieldTemplate, FieldDimension> = {
  '9v9': { width: 55, height: 36 },
  '11v11': { width: 105, height: 68 },
};
