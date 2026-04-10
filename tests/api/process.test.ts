import { describe, it, expect, vi, beforeEach } from 'vitest';

// These hoisted mocks override the global setup.ts partial mock for this file.
vi.mock('@/lib/modal-client', () => ({
  submitJob: vi.fn(),
  pollStatus: vi.fn(),
  getResult: vi.fn(),
}));

vi.mock('@/lib/result-cache', () => ({
  findCachedResultUrl: vi.fn(),
  cacheProcessingResult: vi.fn(),
}));

import { POST } from '@/app/api/process/route';
import { GET as getStatus } from '@/app/api/process/status/[jobId]/route';
import { GET as getResult } from '@/app/api/process/result/[jobId]/route';
import { submitJob, pollStatus, getResult as getResultFn } from '@/lib/modal-client';
import { findCachedResultUrl, cacheProcessingResult } from '@/lib/result-cache';
import { NextRequest } from 'next/server';
import type { ProcessingResult } from '@/types/replay';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createPostRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/process', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function createGetRequest(url: string): NextRequest {
  return new NextRequest(url);
}

// ---------------------------------------------------------------------------
// POST /api/process
// ---------------------------------------------------------------------------

describe('POST /api/process', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findCachedResultUrl).mockResolvedValue(null);
    vi.mocked(cacheProcessingResult).mockResolvedValue(null);
  });

  it('returns 400 when video_url is missing', async () => {
    const request = createPostRequest({ video_id: 'test-123' });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json() as { error: string };
    expect(data.error).toMatch(/video_url/i);
  });

  it('returns 400 when video_id is missing', async () => {
    const request = createPostRequest({ video_url: 'https://blob.example.com/video.mp4' });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const data = await response.json() as { error: string };
    expect(data.error).toMatch(/video_id/i);
  });

  it('returns 400 when both params are missing', async () => {
    const request = createPostRequest({});
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it('submits to Modal and returns job_id', async () => {
    vi.mocked(submitJob).mockResolvedValue('fc-job-456');

    const request = createPostRequest({
      video_url: 'https://blob.vercel-storage.com/v.mp4',
      video_id: 'test-123',
    });
    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json() as { job_id: string };
    expect(data.job_id).toBe('fc-job-456');
    expect(submitJob).toHaveBeenCalledWith('https://blob.vercel-storage.com/v.mp4', '9v9');
  });

  it('returns cached result URL when a cached blob exists', async () => {
    vi.mocked(findCachedResultUrl).mockResolvedValue('https://blob.vercel-storage.com/results/test-123.json');

    const request = createPostRequest({
      video_url: 'https://blob.vercel-storage.com/v.mp4',
      video_id: 'test-123',
    });
    const response = await POST(request);
    expect(response.status).toBe(200);

    const data = await response.json() as { cached: true; result_url: string };
    expect(data.cached).toBe(true);
    expect(data.result_url).toContain('results/test-123.json');
    expect(submitJob).not.toHaveBeenCalled();
  });

  it('passes video_url and hardcoded 9v9 template to submitJob', async () => {
    vi.mocked(submitJob).mockResolvedValue('fc-job-789');

    const request = createPostRequest({
      video_url: 'https://cdn.example.com/match.mp4',
      video_id: 'vid-abc',
    });
    await POST(request);

    expect(submitJob).toHaveBeenCalledWith('https://cdn.example.com/match.mp4', '9v9');
  });

  it('returns 500 when submitJob throws', async () => {
    vi.mocked(submitJob).mockRejectedValue(new Error('Modal is down'));

    const request = createPostRequest({
      video_url: 'https://blob.vercel-storage.com/v.mp4',
      video_id: 'test-123',
    });
    const response = await POST(request);
    expect(response.status).toBe(500);

    const data = await response.json() as { error: string };
    expect(data.error).toBe('Modal is down');
  });
});

// ---------------------------------------------------------------------------
// GET /api/process/status/[jobId]
// ---------------------------------------------------------------------------

describe('GET /api/process/status/[jobId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns job status from Modal', async () => {
    vi.mocked(pollStatus).mockResolvedValue({
      status: 'processing',
      stage: 'detection',
      percent: 45,
    });

    const request = createGetRequest('http://localhost:3000/api/process/status/fc-123');
    const params = Promise.resolve({ jobId: 'fc-123' });
    const response = await getStatus(request, { params });
    expect(response.status).toBe(200);

    const data = await response.json() as { status: string; stage: string; percent: number };
    expect(data.status).toBe('processing');
    expect(data.stage).toBe('detection');
    expect(data.percent).toBe(45);
  });

  it('passes the jobId param to pollStatus', async () => {
    vi.mocked(pollStatus).mockResolvedValue({ status: 'complete' });

    const request = createGetRequest('http://localhost:3000/api/process/status/fc-xyz');
    const params = Promise.resolve({ jobId: 'fc-xyz' });
    await getStatus(request, { params });

    expect(pollStatus).toHaveBeenCalledWith('fc-xyz');
    expect(pollStatus).toHaveBeenCalledTimes(1);
  });

  it('returns complete status with no optional fields', async () => {
    vi.mocked(pollStatus).mockResolvedValue({ status: 'complete' });

    const request = createGetRequest('http://localhost:3000/api/process/status/fc-done');
    const params = Promise.resolve({ jobId: 'fc-done' });
    const response = await getStatus(request, { params });
    expect(response.status).toBe(200);

    const data = await response.json() as { status: string };
    expect(data.status).toBe('complete');
  });

  it('returns failed status with error field', async () => {
    vi.mocked(pollStatus).mockResolvedValue({
      status: 'failed',
      error: 'GPU OOM',
      failure_code: 'CALIBRATION_BOOTSTRAP_FAILED',
      calibration: {
        status: 'failed',
        failure_code: 'CALIBRATION_BOOTSTRAP_FAILED',
        failure_message: 'No valid field anchor found in first 15 seconds',
        accepted_anchor_count: 0,
        rejected_anchor_count: 5,
        coverage_ratio: 0,
        longest_gap_seconds: 15,
        median_anchor_line_iou: null,
        median_temporal_consistency_px: null,
        max_temporal_consistency_px: null,
        median_landmark_jitter_px: null,
        debug_artifact_path: '/tmp/calibration_debug.mp4',
        preview_frames: [
          {
            frame: 0,
            time: 0,
            label: 'invalid',
            source: 'invalid',
            data_url: 'data:image/jpeg;base64,abc',
          },
        ],
      },
    });

    const request = createGetRequest('http://localhost:3000/api/process/status/fc-fail');
    const params = Promise.resolve({ jobId: 'fc-fail' });
    const response = await getStatus(request, { params });
    const data = await response.json() as { status: string; error: string; failure_code?: string; calibration?: { preview_frames?: unknown[] } };

    expect(data.status).toBe('failed');
    expect(data.error).toBe('GPU OOM');
    expect(data.failure_code).toBe('CALIBRATION_BOOTSTRAP_FAILED');
    expect(data.calibration?.preview_frames).toHaveLength(1);
  });

  it('returns 500 when pollStatus throws', async () => {
    vi.mocked(pollStatus).mockRejectedValue(new Error('Modal down'));

    const request = createGetRequest('http://localhost:3000/api/process/status/fc-123');
    const params = Promise.resolve({ jobId: 'fc-123' });
    const response = await getStatus(request, { params });
    expect(response.status).toBe(500);

    const data = await response.json() as { error: string };
    expect(data.error).toBe('Modal down');
  });

  it('returns 500 with generic message when non-Error is thrown', async () => {
    vi.mocked(pollStatus).mockRejectedValue('string error');

    const request = createGetRequest('http://localhost:3000/api/process/status/fc-123');
    const params = Promise.resolve({ jobId: 'fc-123' });
    const response = await getStatus(request, { params });
    expect(response.status).toBe(500);

    const data = await response.json() as { error: string };
    expect(typeof data.error).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// GET /api/process/result/[jobId]
// ---------------------------------------------------------------------------

describe('GET /api/process/result/[jobId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(cacheProcessingResult).mockResolvedValue(null);
  });

  it('returns 202 when result is null (still processing)', async () => {
    vi.mocked(getResultFn).mockResolvedValue(null);

    const request = createGetRequest('http://localhost:3000/api/process/result/fc-123');
    const params = Promise.resolve({ jobId: 'fc-123' });
    const response = await getResult(request, { params });
    expect(response.status).toBe(202);
  });

  it('returns processing status body on 202', async () => {
    vi.mocked(getResultFn).mockResolvedValue(null);

    const request = createGetRequest('http://localhost:3000/api/process/result/fc-123');
    const params = Promise.resolve({ jobId: 'fc-123' });
    const response = await getResult(request, { params });

    const data = await response.json() as { status: string };
    expect(data.status).toBe('processing');
  });

  it('returns 200 with full result when complete', async () => {
    const mockResult: ProcessingResult = {
      metadata: {
        video_id: 'v1',
        fps: 30,
        detection_fps: 10,
        duration: 600,
        frame_count: 18000,
        field_template: '9v9',
        periods: [],
        processing_time_seconds: 300,
        calibration: {
          status: 'passed',
          accepted_anchor_count: 120,
          rejected_anchor_count: 8,
          coverage_ratio: 0.94,
          longest_gap_seconds: 0.9,
          median_anchor_line_iou: 0.29,
          median_temporal_consistency_px: 17.5,
          max_temporal_consistency_px: 55.1,
          median_landmark_jitter_px: 8.2,
          debug_artifact_path: '/tmp/calibration_debug.mp4',
        },
      },
      tracks: [],
    };
    vi.mocked(getResultFn).mockResolvedValue(mockResult);

    const request = createGetRequest('http://localhost:3000/api/process/result/fc-123');
    const params = Promise.resolve({ jobId: 'fc-123' });
    const response = await getResult(request, { params });
    expect(response.status).toBe(200);

    const data = await response.json() as ProcessingResult;
    expect(data.metadata.video_id).toBe('v1');
    expect(data.metadata.fps).toBe(30);
    expect(data.metadata.field_template).toBe('9v9');
    expect(data.metadata.calibration?.status).toBe('passed');
    expect(data.tracks).toEqual([]);
    expect(cacheProcessingResult).toHaveBeenCalledWith(mockResult);
  });

  it('passes jobId param to getResult', async () => {
    vi.mocked(getResultFn).mockResolvedValue(null);

    const request = createGetRequest('http://localhost:3000/api/process/result/fc-abc');
    const params = Promise.resolve({ jobId: 'fc-abc' });
    await getResult(request, { params });

    expect(getResultFn).toHaveBeenCalledWith('fc-abc');
    expect(getResultFn).toHaveBeenCalledTimes(1);
  });

  it('returns result with tracks when complete', async () => {
    const mockResult: ProcessingResult = {
      metadata: {
        video_id: 'v2',
        fps: 25,
        detection_fps: 5,
        duration: 90,
        frame_count: 2250,
        field_template: '9v9',
        periods: [{ start_time: 0, end_time: 45 }],
        processing_time_seconds: 60,
      },
      tracks: [
        {
          player_id: 'p1',
          team: 'home',
          keyframes: [{ time: 0, x: 10, y: 20, confidence: 0.9 }],
        },
        {
          player_id: 'p2',
          team: 'away',
          keyframes: [{ time: 1, x: 50, y: 60, confidence: 0.8 }],
        },
      ],
    };
    vi.mocked(getResultFn).mockResolvedValue(mockResult);

    const request = createGetRequest('http://localhost:3000/api/process/result/fc-rich');
    const params = Promise.resolve({ jobId: 'fc-rich' });
    const response = await getResult(request, { params });
    expect(response.status).toBe(200);

    const data = await response.json() as ProcessingResult;
    expect(data.tracks).toHaveLength(2);
    expect(data.tracks[0]?.player_id).toBe('p1');
    expect(data.tracks[1]?.team).toBe('away');
  });

  it('still returns result when cache write fails', async () => {
    const mockResult: ProcessingResult = {
      metadata: {
        video_id: 'v-cache',
        fps: 25,
        detection_fps: 5,
        duration: 90,
        frame_count: 2250,
        field_template: '9v9',
        periods: [{ start_time: 0, end_time: 45 }],
        processing_time_seconds: 60,
      },
      tracks: [],
    };
    vi.mocked(getResultFn).mockResolvedValue(mockResult);
    vi.mocked(cacheProcessingResult).mockRejectedValue(new Error('cache failed'));

    const request = createGetRequest('http://localhost:3000/api/process/result/fc-cache');
    const params = Promise.resolve({ jobId: 'fc-cache' });
    const response = await getResult(request, { params });
    expect(response.status).toBe(200);

    const data = await response.json() as ProcessingResult;
    expect(data.metadata.video_id).toBe('v-cache');
  });

  it('returns 500 when getResult throws', async () => {
    vi.mocked(getResultFn).mockRejectedValue(new Error('timeout'));

    const request = createGetRequest('http://localhost:3000/api/process/result/fc-123');
    const params = Promise.resolve({ jobId: 'fc-123' });
    const response = await getResult(request, { params });
    expect(response.status).toBe(500);

    const data = await response.json() as { error: string };
    expect(data.error).toBe('timeout');
  });

  it('returns 500 with generic message when non-Error is thrown', async () => {
    vi.mocked(getResultFn).mockRejectedValue({ code: 42 });

    const request = createGetRequest('http://localhost:3000/api/process/result/fc-123');
    const params = Promise.resolve({ jobId: 'fc-123' });
    const response = await getResult(request, { params });
    expect(response.status).toBe(500);

    const data = await response.json() as { error: string };
    expect(typeof data.error).toBe('string');
  });
});
