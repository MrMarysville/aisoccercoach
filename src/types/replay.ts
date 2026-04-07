export interface ProcessingResult {
  metadata: ProcessingMetadata;
  tracks: Track[];
}

export interface ProcessingMetadata {
  video_id: string;
  fps: number;
  detection_fps: number;
  duration: number;
  frame_count: number;
  field_template: '9v9';
  periods: Period[];
  processing_time_seconds: number;
}

export interface Period {
  start_time: number;
  end_time: number;
}

export interface Track {
  player_id: string;
  team: TeamLabel;
  keyframes: Keyframe[];
}

export type TeamLabel = 'home' | 'away' | 'referee' | 'unknown';

export interface Keyframe {
  time: number;
  x: number;
  y: number;
  confidence: number;
}

export interface JobStatus {
  status: 'processing' | 'complete' | 'failed';
  stage?: string;
  percent?: number;
  eta_seconds?: number;
  error?: string;
}

export interface ProcessRequest {
  video_id: string;
  field_template: '9v9';
}

export interface ProcessJobResponse {
  job_id: string;
}
