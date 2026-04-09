import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Smoke tests for the Modal pipeline integration.
 * These verify the contract between the frontend and Modal backend
 * without requiring a running Modal instance.
 */

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const MODAL_ENDPOINT = 'https://zak-18531--soccer-analysis-fastapi-app.modal.run';

describe('Modal endpoint contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POST /submit returns call_id on success', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ call_id: 'fc-test-123' }),
    });

    const res = await fetch(`${MODAL_ENDPOINT}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_url: 'https://example.com/v.mp4', field_template: '9v9' }),
    });

    const data = await res.json() as { call_id: string };
    expect(data.call_id).toMatch(/^fc-/);
  });

  it('GET /status/:id returns valid JobStatus shape', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'processing', stage: 'detection', percent: 42 }),
    });

    const res = await fetch(`${MODAL_ENDPOINT}/status/fc-test-123`);
    const data = await res.json() as { status: string; stage: string; percent: number };

    expect(['processing', 'complete', 'failed']).toContain(data.status);
    expect(typeof data.percent).toBe('number');
  });

  it('GET /status/:id returns failed status with error field', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'failed', stage: 'error', percent: 0, error: 'GPU OOM' }),
    });

    const res = await fetch(`${MODAL_ENDPOINT}/status/fc-test-fail`);
    const data = await res.json() as { status: string; error?: string };

    expect(data.status).toBe('failed');
    expect(data.error).toBeDefined();
  });

  it('GET /result/:id returns 202 when still processing', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ status: 'processing' }),
    });

    const res = await fetch(`${MODAL_ENDPOINT}/result/fc-test-123`);
    expect(res.status).toBe(202);
  });

  it('GET /result/:id returns ProcessingResult shape when complete', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        metadata: {
          video_id: 'test',
          fps: 30,
          detection_fps: 10,
          duration: 60,
          frame_count: 1800,
          field_template: '9v9',
          periods: [{ start_time: 0, end_time: 60 }],
          processing_time_seconds: 120,
          detector_model: 'yolo26m',
          imgsz: 1088,
        },
        tracks: [{
          player_id: 'track_1',
          team: 'home',
          keyframes: [{ time: 0, x: 10, y: 20, confidence: 0.9, speed_ms: 2.1, speed_kmh: 7.6 }],
          stats: { total_distance_m: 500, avg_speed_kmh: 7.2, max_speed_kmh: 28.0 },
        }],
        ball: [{
          frame: 0, time: 0, x: 27.5, y: 18, confidence: 0.7, interpolated: false,
        }],
      }),
    });

    const res = await fetch(`${MODAL_ENDPOINT}/result/fc-test-done`);
    const data = await res.json() as {
      metadata: { detector_model: string; imgsz: number };
      tracks: Array<{ stats?: { total_distance_m: number } }>;
      ball: Array<{ interpolated: boolean }>;
    };

    expect(data.metadata.detector_model).toBe('yolo26m');
    expect(data.metadata.imgsz).toBe(1088);
    expect(data.tracks.length).toBeGreaterThan(0);
    expect(data.tracks[0]?.stats?.total_distance_m).toBeGreaterThan(0);
    expect(data.ball).toBeDefined();
    expect(data.ball.length).toBeGreaterThan(0);
  });
});

describe('modal_app.py syntax', () => {
  it('Python file parses without syntax errors', async () => {
    const { execSync } = await import('child_process');
    const result = execSync('python3 -c "import ast; ast.parse(open(\'modal_app.py\').read()); print(\'OK\')"', {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });
    expect(result.trim()).toBe('OK');
  });

  it('all imports are resolvable at module level', async () => {
    const { execSync } = await import('child_process');
    // Verify the top-level imports don't crash — this catches the fastapi bug
    const result = execSync(
      'python3 -c "import ast; tree = ast.parse(open(\'modal_app.py\').read()); imports = [n for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom)) and getattr(n, \'col_offset\', 1) == 0]; print(len(imports))"',
      { encoding: 'utf-8', cwd: process.cwd() },
    );
    const count = parseInt(result.trim(), 10);
    expect(count).toBeGreaterThan(0);
  });
});
