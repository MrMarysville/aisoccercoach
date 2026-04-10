export interface ProcessingResult {
  metadata: ProcessingMetadata;
  tracks: Track[];
  ball?: BallPosition[];
}

export interface BallPosition {
  frame: number;
  time: number;
  x: number;
  y: number;
  confidence: number;
  interpolated?: boolean;
}

export interface ProcessingMetadata {
  video_id: string;
  fps: number;
  detection_fps: number;
  duration: number;
  frame_count: number;
  field_template: '9v9' | '11v11';
  periods: Period[];
  processing_time_seconds: number;
  detector_model?: string;
  imgsz?: number;
  calibration?: CalibrationSummary;
}

export interface CalibrationSummary {
  status: 'passed' | 'failed';
  failure_code?: string | null;
  failure_message?: string | null;
  accepted_anchor_count: number;
  rejected_anchor_count: number;
  accepted_anchor_count_first_15s?: number;
  coverage_ratio: number;
  longest_gap_seconds: number;
  longest_internal_gap_seconds?: number;
  median_anchor_line_iou?: number | null;
  median_temporal_consistency_px?: number | null;
  max_temporal_consistency_px?: number | null;
  median_landmark_jitter_px?: number | null;
  invalid_reason_counts?: Record<string, number>;
  debug_artifact_path?: string | null;
  preview_frames?: CalibrationPreviewFrame[];
}

export interface CalibrationPreviewFrame {
  frame: number;
  time: number;
  label: 'valid' | 'invalid';
  source: 'anchor_pnl' | 'propagated_ecc' | 'invalid' | 'unknown';
  data_url: string;
}

export interface Period {
  start_time: number;
  end_time: number;
}

export interface Track {
  player_id: string;
  team: TeamLabel;
  keyframes: Keyframe[];
  stats?: TrackStats;
}

export interface TrackStats {
  total_distance_m: number;
  avg_speed_kmh: number;
  max_speed_kmh: number;
}

export type TeamLabel = 'home' | 'away' | 'referee' | 'unknown';

export interface Keyframe {
  time: number;
  x: number;
  y: number;
  confidence: number;
  speed_ms?: number;
  speed_kmh?: number;
}

export interface JobStatus {
  status: 'processing' | 'complete' | 'failed';
  stage?: string;
  percent?: number;
  eta_seconds?: number;
  error?: string;
  failure_code?: string;
  calibration?: CalibrationSummary;
}

export interface ProcessRequest {
  video_id: string;
  field_template: '9v9' | '11v11';
}

export interface ProcessJobResponse {
  job_id: string;
}

export interface CachedProcessResponse {
  cached: true;
  result_url: string;
}
