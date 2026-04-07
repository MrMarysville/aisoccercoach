# Video-to-Tactical Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert sideline PTZ soccer video into an animated top-down tactical board replay with smooth 60fps player dot movement.

**Architecture:** Two independent workstreams — a Modal Python GPU pipeline (detection + tracking + calibration) and a Next.js frontend (Vercel Blob upload + Canvas2D replay). They communicate via HTTP: Next.js calls Modal's FastAPI endpoints, Modal returns JSON tracking data.

**Tech Stack:** Next.js 16, React 19, Vercel Blob, Canvas2D, Modal.com (A10G GPU), YOLOv11n, BoxMOT/BoT-SORT, PnLCalib, OpenCV ECC, scikit-learn K-Means

**Spec:** `docs/superpowers/specs/2026-04-07-video-to-tactical-replay-design.md` (v3)

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `src/types/replay.ts` | All replay TypeScript interfaces (ProcessingResult, Track, Keyframe, JobStatus) |
| `src/lib/replay/interpolation.ts` | Binary search + lerp for keyframe interpolation |
| `src/lib/replay/field-renderer.ts` | Draw 9v9 soccer field on Canvas2D |
| `src/lib/modal-client.ts` | HTTP client for Modal FastAPI endpoints (submit, status, result) — **rewrite** |
| `src/components/replay/TacticalCanvas.tsx` | Two-layer canvas: static field + animated player dots |
| `src/components/replay/TimelineControl.tsx` | Play/pause, speed, scrubber driving video + canvas |
| `src/components/replay/ProcessingStatus.tsx` | Progress bar polling Modal status |
| `src/components/replay/ReplayView.tsx` | Main container: video + tactical board side-by-side |
| `src/components/video/VideoUploader.tsx` | **Rewrite** — Vercel Blob client upload replacing XHR to disk |
| `src/app/api/upload/route.ts` | **Rewrite** — Vercel Blob token exchange handler |
| `src/app/api/process/route.ts` | **Rewrite** — async job submission to Modal |
| `src/app/api/process/status/[jobId]/route.ts` | Poll Modal `/status/{call_id}` |
| `src/app/api/process/result/[jobId]/route.ts` | Fetch Modal `/result/{call_id}`, cache to Blob |
| `modal_app.py` | **Rewrite** — FastAPI endpoints + 7-stage GPU pipeline |
| `tests/replay/interpolation.test.ts` | Interpolation unit tests |
| `tests/replay/field-renderer.test.ts` | Field renderer unit tests |
| `tests/modal-client.test.ts` | **Rewrite** — Modal HTTP client tests |
| `tests/api/process.test.ts` | API route tests |

### Deleted Files
| File | Reason |
|------|--------|
| `src/components/video/CalibrationOverlay.tsx` | Auto-calibration replaces manual |
| `src/components/tactical/TacticalBoard.tsx` | Replaced by TacticalCanvas |
| `src/components/tactical/FieldTemplate.tsx` | Replaced by field-renderer.ts |
| `src/components/tactical/PlayerMarker.tsx` | Replaced by Canvas2D drawing |
| `src/app/api/calibration/route.ts` | No calibration API needed |
| `src/lib/field/detection.ts` | Field detection moved to Modal |
| `src/lib/field/homography.ts` | Homography computed on Modal |
| `src/lib/video-processing/` | Entire directory — moved to Modal |

---

## Phase 1: Types & Interpolation (frontend foundation)

### Task 1: Replay Type Definitions

**Files:**
- Create: `src/types/replay.ts`

- [ ] **Step 1: Create the types file**

```typescript
// src/types/replay.ts

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
```

- [ ] **Step 2: Verify types compile**

Run: `pnpm type-check`
Expected: No errors related to `src/types/replay.ts`

- [ ] **Step 3: Commit**

```bash
git add src/types/replay.ts
git commit -m "feat: add replay type definitions for processing pipeline"
```

---

### Task 2: Interpolation — Binary Search + Lerp

**Files:**
- Create: `src/lib/replay/interpolation.ts`
- Create: `tests/replay/interpolation.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/replay/interpolation.test.ts
import { describe, it, expect } from 'vitest';
import { binarySearchKeyframes, lerp, interpolatePosition } from '@/lib/replay/interpolation';
import type { Keyframe } from '@/types/replay';

const keyframes: Keyframe[] = [
  { time: 0, x: 0, y: 0, confidence: 1 },
  { time: 1, x: 10, y: 20, confidence: 0.9 },
  { time: 2, x: 20, y: 10, confidence: 0.8 },
  { time: 3, x: 30, y: 30, confidence: 1 },
];

describe('lerp', () => {
  it('returns start when alpha is 0', () => {
    expect(lerp(0, 10, 0)).toBe(0);
  });

  it('returns end when alpha is 1', () => {
    expect(lerp(0, 10, 1)).toBe(10);
  });

  it('returns midpoint when alpha is 0.5', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
  });
});

describe('binarySearchKeyframes', () => {
  it('returns 0 for time before first keyframe', () => {
    expect(binarySearchKeyframes(keyframes, -1)).toBe(0);
  });

  it('returns last index for time after last keyframe', () => {
    expect(binarySearchKeyframes(keyframes, 5)).toBe(3);
  });

  it('returns correct bracketing index for mid value', () => {
    expect(binarySearchKeyframes(keyframes, 1.5)).toBe(1);
  });

  it('returns exact index on keyframe time', () => {
    expect(binarySearchKeyframes(keyframes, 2)).toBe(2);
  });

  it('handles single-element array', () => {
    const single: Keyframe[] = [{ time: 5, x: 10, y: 10, confidence: 1 }];
    expect(binarySearchKeyframes(single, 3)).toBe(0);
    expect(binarySearchKeyframes(single, 7)).toBe(0);
  });
});

describe('interpolatePosition', () => {
  it('clamps to first keyframe before start', () => {
    const pos = interpolatePosition(keyframes, -1);
    expect(pos).toEqual({ x: 0, y: 0, opacity: 1 });
  });

  it('fades out after last keyframe', () => {
    const pos = interpolatePosition(keyframes, 3.25);
    expect(pos).not.toBeNull();
    expect(pos!.opacity).toBeLessThan(1);
    expect(pos!.opacity).toBeGreaterThan(0);
  });

  it('returns null when fully faded (500ms after last)', () => {
    const pos = interpolatePosition(keyframes, 3.6);
    expect(pos).toBeNull();
  });

  it('interpolates between keyframes', () => {
    const pos = interpolatePosition(keyframes, 0.5);
    expect(pos).toEqual({ x: 5, y: 10, opacity: 1 });
  });

  it('reduces opacity for low confidence', () => {
    const lowConf: Keyframe[] = [
      { time: 0, x: 0, y: 0, confidence: 0.3 },
      { time: 1, x: 10, y: 10, confidence: 0.4 },
    ];
    const pos = interpolatePosition(lowConf, 0.5);
    expect(pos!.opacity).toBe(0.5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/replay/interpolation.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement interpolation**

```typescript
// src/lib/replay/interpolation.ts
import type { Keyframe } from '@/types/replay';

const FADE_DURATION = 0.5; // seconds
const LOW_CONFIDENCE_THRESHOLD = 0.5;
const LOW_CONFIDENCE_OPACITY = 0.5;

export interface InterpolatedPosition {
  x: number;
  y: number;
  opacity: number;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Binary search for the largest index where keyframes[index].time <= t.
 * Returns 0 if t is before all keyframes, last index if t is after all.
 */
export function binarySearchKeyframes(keyframes: Keyframe[], t: number): number {
  if (keyframes.length <= 1) return 0;
  if (t <= keyframes[0].time) return 0;
  if (t >= keyframes[keyframes.length - 1].time) return keyframes.length - 1;

  let lo = 0;
  let hi = keyframes.length - 1;

  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    if (keyframes[mid].time <= t) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return lo;
}

/**
 * Interpolate a player's position at time t from their keyframe array.
 * Returns null if the player has fully faded out.
 */
export function interpolatePosition(
  keyframes: Keyframe[],
  t: number
): InterpolatedPosition | null {
  if (keyframes.length === 0) return null;

  // Before first keyframe — clamp to first position
  if (t <= keyframes[0].time) {
    return {
      x: keyframes[0].x,
      y: keyframes[0].y,
      opacity: keyframes[0].confidence < LOW_CONFIDENCE_THRESHOLD ? LOW_CONFIDENCE_OPACITY : 1,
    };
  }

  // After last keyframe — fade out over FADE_DURATION
  const last = keyframes[keyframes.length - 1];
  if (t >= last.time) {
    const elapsed = t - last.time;
    if (elapsed >= FADE_DURATION) return null;
    const fadeOpacity = Math.max(0, 1 - elapsed / FADE_DURATION);
    return { x: last.x, y: last.y, opacity: fadeOpacity };
  }

  // Between keyframes — interpolate
  const idx = binarySearchKeyframes(keyframes, t);
  const prev = keyframes[idx];
  const next = keyframes[idx + 1];
  const alpha = (t - prev.time) / (next.time - prev.time);

  const confidence = Math.min(prev.confidence, next.confidence);
  const opacity = confidence < LOW_CONFIDENCE_THRESHOLD ? LOW_CONFIDENCE_OPACITY : 1;

  return {
    x: lerp(prev.x, next.x, alpha),
    y: lerp(prev.y, next.y, alpha),
    opacity,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/replay/interpolation.test.ts`
Expected: All 11 tests PASS

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/replay/interpolation.ts tests/replay/interpolation.test.ts
git commit -m "feat: add keyframe interpolation with binary search and lerp"
```

---

### Task 3: Field Renderer (Canvas2D)

**Files:**
- Create: `src/lib/replay/field-renderer.ts`
- Create: `tests/replay/field-renderer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/replay/field-renderer.test.ts
import { describe, it, expect } from 'vitest';
import { computeScaleFactors, fieldToCanvas } from '@/lib/replay/field-renderer';

describe('computeScaleFactors', () => {
  it('computes correct scale for a 550x360 canvas', () => {
    const { scaleX, scaleY } = computeScaleFactors(550, 360);
    expect(scaleX).toBe(10); // 550 / 55
    expect(scaleY).toBe(10); // 360 / 36
  });

  it('computes correct scale for a 275x180 canvas', () => {
    const { scaleX, scaleY } = computeScaleFactors(275, 180);
    expect(scaleX).toBe(5);
    expect(scaleY).toBe(5);
  });
});

describe('fieldToCanvas', () => {
  it('maps field center to canvas center', () => {
    const { px, py } = fieldToCanvas(27.5, 18, 10, 10);
    expect(px).toBe(275);
    expect(py).toBe(180);
  });

  it('maps field origin to canvas origin', () => {
    const { px, py } = fieldToCanvas(0, 0, 10, 10);
    expect(px).toBe(0);
    expect(py).toBe(0);
  });

  it('maps field max to canvas max', () => {
    const { px, py } = fieldToCanvas(55, 36, 10, 10);
    expect(px).toBe(550);
    expect(py).toBe(360);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/replay/field-renderer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement field renderer**

```typescript
// src/lib/replay/field-renderer.ts

// 9v9 field dimensions in meters
const FIELD_WIDTH = 55;
const FIELD_HEIGHT = 36;

// Field markings dimensions (meters)
const PENALTY_AREA_WIDTH = 16.5;
const PENALTY_AREA_DEPTH = 5.5;
const GOAL_AREA_WIDTH = 5.5;
const GOAL_AREA_DEPTH = 1.83;
const CENTER_CIRCLE_RADIUS = 9.15;
const PENALTY_SPOT_DIST = 11;

export interface ScaleFactors {
  scaleX: number;
  scaleY: number;
}

export function computeScaleFactors(canvasWidth: number, canvasHeight: number): ScaleFactors {
  return {
    scaleX: canvasWidth / FIELD_WIDTH,
    scaleY: canvasHeight / FIELD_HEIGHT,
  };
}

export function fieldToCanvas(
  fieldX: number,
  fieldY: number,
  scaleX: number,
  scaleY: number
): { px: number; py: number } {
  return { px: fieldX * scaleX, py: fieldY * scaleY };
}

/**
 * Draw the full 9v9 field on a canvas context.
 * Assumes the context is already scaled for DPR.
 */
export function drawField(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): void {
  const { scaleX, scaleY } = computeScaleFactors(width, height);
  const s = (x: number, y: number) => fieldToCanvas(x, y, scaleX, scaleY);

  // Green background
  ctx.fillStyle = '#2d7a3f';
  ctx.fillRect(0, 0, width, height);

  // White field markings
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 2;

  // Outer boundary
  ctx.strokeRect(0, 0, width, height);

  // Center line
  const center = s(FIELD_WIDTH / 2, 0);
  const centerBottom = s(FIELD_WIDTH / 2, FIELD_HEIGHT);
  ctx.beginPath();
  ctx.moveTo(center.px, center.py);
  ctx.lineTo(centerBottom.px, centerBottom.py);
  ctx.stroke();

  // Center circle
  const centerCircle = s(FIELD_WIDTH / 2, FIELD_HEIGHT / 2);
  ctx.beginPath();
  ctx.arc(centerCircle.px, centerCircle.py, CENTER_CIRCLE_RADIUS * scaleX, 0, Math.PI * 2);
  ctx.stroke();

  // Center dot
  ctx.fillStyle = 'white';
  ctx.beginPath();
  ctx.arc(centerCircle.px, centerCircle.py, 3, 0, Math.PI * 2);
  ctx.fill();

  // Left penalty area
  const lpa = s(0, (FIELD_HEIGHT - PENALTY_AREA_DEPTH * 2) / 2);
  ctx.strokeRect(lpa.px, lpa.py, PENALTY_AREA_WIDTH * scaleX, PENALTY_AREA_DEPTH * 2 * scaleY);

  // Left goal area
  const lga = s(0, (FIELD_HEIGHT - GOAL_AREA_DEPTH * 2) / 2);
  ctx.strokeRect(lga.px, lga.py, GOAL_AREA_WIDTH * scaleX, GOAL_AREA_DEPTH * 2 * scaleY);

  // Left penalty spot
  const lps = s(PENALTY_SPOT_DIST, FIELD_HEIGHT / 2);
  ctx.beginPath();
  ctx.arc(lps.px, lps.py, 3, 0, Math.PI * 2);
  ctx.fill();

  // Right penalty area
  const rpa = s(FIELD_WIDTH - PENALTY_AREA_WIDTH, (FIELD_HEIGHT - PENALTY_AREA_DEPTH * 2) / 2);
  ctx.strokeRect(rpa.px, rpa.py, PENALTY_AREA_WIDTH * scaleX, PENALTY_AREA_DEPTH * 2 * scaleY);

  // Right goal area
  const rga = s(FIELD_WIDTH - GOAL_AREA_WIDTH, (FIELD_HEIGHT - GOAL_AREA_DEPTH * 2) / 2);
  ctx.strokeRect(rga.px, rga.py, GOAL_AREA_WIDTH * scaleX, GOAL_AREA_DEPTH * 2 * scaleY);

  // Right penalty spot
  const rps = s(FIELD_WIDTH - PENALTY_SPOT_DIST, FIELD_HEIGHT / 2);
  ctx.beginPath();
  ctx.arc(rps.px, rps.py, 3, 0, Math.PI * 2);
  ctx.fill();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/replay/field-renderer.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/replay/field-renderer.ts tests/replay/field-renderer.test.ts
git commit -m "feat: add Canvas2D 9v9 field renderer with coordinate mapping"
```

---

## Phase 2: Modal Client & API Routes

### Task 4: Modal HTTP Client (rewrite)

**Files:**
- Rewrite: `src/lib/modal-client.ts`
- Rewrite: `tests/modal-client.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/modal-client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { submitJob, pollStatus, getResult } from '@/lib/modal-client';

describe('modal-client', () => {
  beforeEach(() => {
    vi.stubEnv('MODAL_ENDPOINT', 'https://test--soccer-analysis.modal.run');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('submitJob', () => {
    it('calls /submit with video URL and field template', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ call_id: 'fc-abc123' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await submitJob('https://blob.vercel-storage.com/video.mp4', '9v9');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test--soccer-analysis.modal.run/submit',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ video_url: 'https://blob.vercel-storage.com/video.mp4', field_template: '9v9' }),
        })
      );
      expect(result).toBe('fc-abc123');
    });
  });

  describe('pollStatus', () => {
    it('returns parsed JobStatus', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'processing', stage: 'detection', percent: 45 }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const status = await pollStatus('fc-abc123');
      expect(status.status).toBe('processing');
      expect(status.stage).toBe('detection');
      expect(status.percent).toBe(45);
    });
  });

  describe('getResult', () => {
    it('returns ProcessingResult when complete', async () => {
      const mockResult = { metadata: { video_id: 'v1' }, tracks: [] };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResult),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await getResult('fc-abc123');
      expect(result).toEqual(mockResult);
    });

    it('returns null when still processing (202)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        json: () => Promise.resolve({ status: 'processing' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await getResult('fc-abc123');
      expect(result).toBeNull();
    });

    it('throws on server error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal error'),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(getResult('fc-abc123')).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test tests/modal-client.test.ts`
Expected: FAIL — functions not found

- [ ] **Step 3: Implement modal client**

```typescript
// src/lib/modal-client.ts
import type { JobStatus, ProcessingResult } from '@/types/replay';

function getEndpoint(): string {
  const endpoint = process.env.MODAL_ENDPOINT;
  if (!endpoint) throw new Error('MODAL_ENDPOINT environment variable is not set');
  return endpoint;
}

export async function submitJob(videoUrl: string, fieldTemplate: string): Promise<string> {
  const response = await fetch(`${getEndpoint()}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_url: videoUrl, field_template: fieldTemplate }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Modal submit failed (${response.status}): ${text}`);
  }

  const data: { call_id: string } = await response.json();
  return data.call_id;
}

export async function pollStatus(callId: string): Promise<JobStatus> {
  const response = await fetch(`${getEndpoint()}/status/${callId}`);

  if (!response.ok) {
    throw new Error(`Modal status failed (${response.status})`);
  }

  return response.json() as Promise<JobStatus>;
}

export async function getResult(callId: string): Promise<ProcessingResult | null> {
  const response = await fetch(`${getEndpoint()}/result/${callId}`);

  if (response.status === 202) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Modal result failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<ProcessingResult>;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test tests/modal-client.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/modal-client.ts tests/modal-client.test.ts
git commit -m "feat: rewrite modal client for async submit/poll/result pattern"
```

---

### Task 5: Upload Route — Vercel Blob Token Exchange

**Files:**
- Rewrite: `src/app/api/upload/route.ts`

- [ ] **Step 1: Install @vercel/blob**

Run: `pnpm add @vercel/blob`

- [ ] **Step 2: Rewrite upload route**

```typescript
// src/app/api/upload/route.ts
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextResponse } from 'next/server';

export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ['video/mp4', 'video/quicktime'],
        addRandomSuffix: true,
      }),
      onUploadCompleted: async () => {
        // Video stored in Vercel Blob — no server-side action needed
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Upload failed';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
```

- [ ] **Step 3: Lint and type-check**

Run: `pnpm lint && pnpm type-check`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/app/api/upload/route.ts package.json pnpm-lock.yaml
git commit -m "feat: rewrite upload route for Vercel Blob client upload"
```

---

### Task 6: Process API Routes (submit + status + result)

**Files:**
- Rewrite: `src/app/api/process/route.ts`
- Create: `src/app/api/process/status/[jobId]/route.ts`
- Create: `src/app/api/process/result/[jobId]/route.ts`

- [ ] **Step 1: Rewrite process route (submit job)**

```typescript
// src/app/api/process/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { submitJob } from '@/lib/modal-client';
import { put, list } from '@vercel/blob';
import type { ProcessJobResponse } from '@/types/replay';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { video_url, video_id } = body as { video_url: string; video_id: string };

    if (!video_url || !video_id) {
      return NextResponse.json({ error: 'video_url and video_id required' }, { status: 400 });
    }

    // Check for cached result
    const cached = await list({ prefix: `${video_id}_result` });
    if (cached.blobs.length > 0) {
      return NextResponse.json({ cached: true, result_url: cached.blobs[0].url });
    }

    // Submit to Modal
    const callId = await submitJob(video_url, '9v9');

    // Store job mapping in Vercel Blob
    await put(`${video_id}.job`, callId, { access: 'public', addRandomSuffix: false });

    const response: ProcessJobResponse = { job_id: callId };
    return NextResponse.json(response);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Processing failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 2: Create status route**

```typescript
// src/app/api/process/status/[jobId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { pollStatus } from '@/lib/modal-client';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  try {
    const status = await pollStatus(jobId);
    return NextResponse.json(status);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Status check failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 3: Create result route**

```typescript
// src/app/api/process/result/[jobId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getResult } from '@/lib/modal-client';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;

  try {
    const result = await getResult(jobId);

    if (result === null) {
      return NextResponse.json({ status: 'processing' }, { status: 202 });
    }

    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Result fetch failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
```

- [ ] **Step 4: Lint and type-check**

Run: `pnpm lint && pnpm type-check`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/app/api/process/route.ts src/app/api/process/status/ src/app/api/process/result/
git commit -m "feat: add async process API with submit, status, and result routes"
```

---

## Phase 3: Replay Components

### Task 7: VideoUploader — Vercel Blob Client Upload

**Files:**
- Rewrite: `src/components/video/VideoUploader.tsx`

- [ ] **Step 1: Rewrite uploader with Vercel Blob client upload**

```typescript
// src/components/video/VideoUploader.tsx
'use client';

import { useState, useCallback } from 'react';
import { upload } from '@vercel/blob/client';

interface VideoUploaderProps {
  onUploadComplete: (blobUrl: string, videoId: string) => void;
}

export default function VideoUploader({ onUploadComplete }: VideoUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(async (file: File) => {
    const validTypes = ['video/mp4', 'video/quicktime'];
    if (!validTypes.includes(file.type)) {
      setError('Please upload an MP4 or MOV file');
      return;
    }

    setIsUploading(true);
    setError(null);
    setProgress(0);

    try {
      const blob = await upload(file.name, file, {
        access: 'public',
        handleUploadUrl: '/api/upload',
        onUploadProgress: ({ percentage }) => setProgress(percentage),
      });

      const videoId = blob.pathname.replace(/\.[^.]+$/, '');
      onUploadComplete(blob.url, videoId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsUploading(false);
    }
  }, [onUploadComplete]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  return (
    <div className="flex flex-col gap-4">
      <div
        className={`card p-12 flex flex-col items-center justify-center cursor-pointer transition ${isDragging ? 'border-primary' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        {isUploading ? (
          <div className="flex flex-col items-center gap-2 w-full">
            <p className="text-sm text-on-surface-secondary">Uploading... {Math.round(progress)}%</p>
            <div className="w-full h-2 rounded-full bg-color-border overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <p className="text-on-surface font-medium">Drop your match video here</p>
            <p className="text-sm text-on-surface-secondary">MP4 or MOV</p>
            <label className="btn btn-primary cursor-pointer">
              Browse Files
              <input
                type="file"
                accept="video/mp4,video/quicktime"
                onChange={handleInputChange}
                className="hidden"
              />
            </label>
          </div>
        )}
      </div>
      {error && <p className="text-sm text-error">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/video/VideoUploader.tsx
git commit -m "feat: rewrite VideoUploader for Vercel Blob client upload"
```

---

### Task 8: ProcessingStatus Component

**Files:**
- Create: `src/components/replay/ProcessingStatus.tsx`

- [ ] **Step 1: Create ProcessingStatus**

```typescript
// src/components/replay/ProcessingStatus.tsx
'use client';

import { useState, useEffect, useCallback } from 'react';
import type { JobStatus } from '@/types/replay';

interface ProcessingStatusProps {
  jobId: string;
  onComplete: () => void;
  onError: (error: string) => void;
}

const STAGE_LABELS: Record<string, string> = {
  starting: 'Starting...',
  transcoding: 'Transcoding video',
  camera_motion: 'Analyzing camera motion',
  field_calibration: 'Detecting field lines',
  detection: 'Detecting players',
  tracking: 'Tracking players',
  classification: 'Classifying teams',
  transform: 'Computing positions',
  done: 'Complete',
};

export default function ProcessingStatus({ jobId, onComplete, onError }: ProcessingStatusProps) {
  const [status, setStatus] = useState<JobStatus>({ status: 'processing', stage: 'starting', percent: 0 });

  const poll = useCallback(async () => {
    try {
      const response = await fetch(`/api/process/status/${jobId}`);
      if (!response.ok) return;

      const data: JobStatus = await response.json();
      setStatus(data);

      if (data.status === 'complete') onComplete();
      if (data.status === 'failed') onError(data.error ?? 'Processing failed');
    } catch {
      // Silent failure — will retry on next poll
    }
  }, [jobId, onComplete, onError]);

  useEffect(() => {
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [poll]);

  const stageLabel = STAGE_LABELS[status.stage ?? ''] ?? status.stage ?? 'Processing';
  const percent = status.percent ?? 0;

  return (
    <div className="card p-12 flex flex-col items-center gap-4">
      <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      <div className="flex flex-col items-center gap-1">
        <p className="font-medium text-on-surface">{stageLabel}</p>
        <p className="text-sm text-on-surface-secondary">
          {percent}% complete
          {status.eta_seconds ? ` \u2022 ~${Math.ceil(status.eta_seconds / 60)} min remaining` : ''}
        </p>
      </div>
      <div className="w-full max-w-xs h-2 rounded-full bg-color-border overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-xs text-on-surface-secondary">
        Processing typically takes 20-25 minutes for a full match
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/replay/ProcessingStatus.tsx
git commit -m "feat: add ProcessingStatus component with Modal polling"
```

---

### Task 9: TacticalCanvas Component

**Files:**
- Create: `src/components/replay/TacticalCanvas.tsx`

- [ ] **Step 1: Create TacticalCanvas**

```typescript
// src/components/replay/TacticalCanvas.tsx
'use client';

import { useRef, useEffect, useCallback } from 'react';
import type { Track, TeamLabel } from '@/types/replay';
import { interpolatePosition } from '@/lib/replay/interpolation';
import { drawField, computeScaleFactors, fieldToCanvas } from '@/lib/replay/field-renderer';

interface TacticalCanvasProps {
  tracks: Track[];
  videoRef: React.RefObject<HTMLVideoElement | null>;
}

const TEAM_COLORS: Record<TeamLabel, string> = {
  home: '#2563eb',
  away: '#dc2626',
  referee: '#eab308',
  unknown: '#6b7280',
};

const DOT_RADIUS = 6;

export default function TacticalCanvas({ tracks, videoRef }: TacticalCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fieldCanvasRef = useRef<HTMLCanvasElement>(null);
  const playerCanvasRef = useRef<HTMLCanvasElement>(null);
  const scaleRef = useRef({ scaleX: 1, scaleY: 1 });
  const animFrameRef = useRef<number>(0);

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

    // Draw static field
    const fieldCtx = fieldCanvas.getContext('2d');
    if (fieldCtx) {
      fieldCtx.scale(dpr, dpr);
      drawField(fieldCtx, width, height);
    }

    scaleRef.current = computeScaleFactors(width, height);
  }, []);

  // Resize observer
  useEffect(() => {
    resizeCanvases();
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(resizeCanvases);
    observer.observe(container);
    return () => observer.disconnect();
  }, [resizeCanvases]);

  // Animation loop
  useEffect(() => {
    const playerCanvas = playerCanvasRef.current;
    const video = videoRef.current;
    if (!playerCanvas || !video) return;

    const ctx = playerCanvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;

    function render() {
      if (!ctx || !video) return;

      const t = video.currentTime;
      const { scaleX, scaleY } = scaleRef.current;

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, playerCanvas!.clientWidth, playerCanvas!.clientHeight);

      for (const track of tracks) {
        const pos = interpolatePosition(track.keyframes, t);
        if (!pos) continue;

        const { px, py } = fieldToCanvas(pos.x, pos.y, scaleX, scaleY);

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

      ctx.restore();
      animFrameRef.current = requestAnimationFrame(render);
    }

    animFrameRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [tracks, videoRef]);

  return (
    <div ref={containerRef} className="relative w-full" style={{ aspectRatio: '55 / 36' }}>
      <canvas ref={fieldCanvasRef} className="absolute inset-0" />
      <canvas ref={playerCanvasRef} className="absolute inset-0" />
    </div>
  );
}
```

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/replay/TacticalCanvas.tsx
git commit -m "feat: add TacticalCanvas with dual-layer Canvas2D and rAF animation"
```

---

### Task 10: TimelineControl Component

**Files:**
- Create: `src/components/replay/TimelineControl.tsx`

- [ ] **Step 1: Create TimelineControl**

```typescript
// src/components/replay/TimelineControl.tsx
'use client';

import { useState, useCallback, useEffect } from 'react';

interface TimelineControlProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  detectionFps: number;
  duration: number;
}

const SPEEDS = [0.5, 1, 2];

export default function TimelineControl({ videoRef, detectionFps, duration }: TimelineControlProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
    };
  }, [videoRef]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play();
    } else {
      video.pause();
    }
  }, [videoRef]);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Number(e.target.value);
  }, [videoRef]);

  const handleSpeed = useCallback((newSpeed: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = newSpeed;
    setSpeed(newSpeed);
  }, [videoRef]);

  const stepFrame = useCallback((direction: 1 | -1) => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime += direction / detectionFps;
  }, [videoRef, detectionFps]);

  const formatTime = (seconds: number): string => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col gap-2 p-3 card">
      <input
        type="range"
        min={0}
        max={duration}
        step={0.1}
        value={currentTime}
        onChange={handleSeek}
        className="w-full"
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button onClick={() => stepFrame(-1)} className="btn btn-sm text-on-surface-secondary">
            &lt;
          </button>
          <button onClick={togglePlay} className="btn btn-sm btn-primary">
            {isPlaying ? 'Pause' : 'Play'}
          </button>
          <button onClick={() => stepFrame(1)} className="btn btn-sm text-on-surface-secondary">
            &gt;
          </button>
        </div>

        <span className="text-sm text-on-surface-secondary">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>

        <div className="flex items-center gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => handleSpeed(s)}
              className={`btn btn-sm ${speed === s ? 'btn-primary' : 'text-on-surface-secondary'}`}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/replay/TimelineControl.tsx
git commit -m "feat: add TimelineControl with play/pause, speed, and frame step"
```

---

### Task 11: ReplayView Container

**Files:**
- Create: `src/components/replay/ReplayView.tsx`

- [ ] **Step 1: Create ReplayView**

```typescript
// src/components/replay/ReplayView.tsx
'use client';

import { useRef, useState, useCallback } from 'react';
import type { ProcessingResult } from '@/types/replay';
import VideoPlayer from '@/components/video/VideoPlayer';
import TacticalCanvas from '@/components/replay/TacticalCanvas';
import TimelineControl from '@/components/replay/TimelineControl';
import ProcessingStatus from '@/components/replay/ProcessingStatus';

interface ReplayViewProps {
  videoSrc: string;
  jobId: string | null;
  cachedResult: ProcessingResult | null;
}

export default function ReplayView({ videoSrc, jobId, cachedResult }: ReplayViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [result, setResult] = useState<ProcessingResult | null>(cachedResult);
  const [error, setError] = useState<string | null>(null);
  const [isVideoReady, setIsVideoReady] = useState(false);

  const handleProcessingComplete = useCallback(async () => {
    if (!jobId) return;
    try {
      const response = await fetch(`/api/process/result/${jobId}`);
      if (response.ok) {
        const data: ProcessingResult = await response.json();
        setResult(data);
      }
    } catch {
      setError('Failed to load results');
    }
  }, [jobId]);

  // Still processing
  if (!result && jobId) {
    if (error) {
      return (
        <div className="card p-12 flex flex-col items-center gap-4">
          <p className="text-error font-medium">{error}</p>
          <button onClick={() => setError(null)} className="btn btn-primary">Retry</button>
        </div>
      );
    }
    return <ProcessingStatus jobId={jobId} onComplete={handleProcessingComplete} onError={setError} />;
  }

  // No result and no job — shouldn't happen, but handle gracefully
  if (!result) {
    return (
      <div className="card p-12 flex items-center justify-center">
        <p className="text-on-surface-secondary">No tracking data available</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-on-surface">Video</h2>
          <video
            ref={videoRef}
            src={videoSrc}
            onCanPlay={() => setIsVideoReady(true)}
            className="w-full rounded-lg"
            playsInline
          />
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold text-on-surface">Tactical Board</h2>
          {isVideoReady ? (
            <TacticalCanvas tracks={result.tracks} videoRef={videoRef} />
          ) : (
            <div className="card flex items-center justify-center" style={{ aspectRatio: '55 / 36' }}>
              <p className="text-on-surface-secondary text-sm">Loading video...</p>
            </div>
          )}
        </div>
      </div>

      {isVideoReady && (
        <TimelineControl
          videoRef={videoRef}
          detectionFps={result.metadata.detection_fps}
          duration={result.metadata.duration}
        />
      )}

      <div className="flex gap-4 text-xs p-3 card">
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-full bg-primary" />
          <span className="text-on-surface-secondary">Home</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-full" style={{ backgroundColor: '#dc2626' }} />
          <span className="text-on-surface-secondary">Away</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="w-3 h-3 rounded-full" style={{ backgroundColor: '#eab308' }} />
          <span className="text-on-surface-secondary">Referee</span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/replay/ReplayView.tsx
git commit -m "feat: add ReplayView container with video + tactical board + timeline"
```

---

## Phase 4: Page Integration & Cleanup

### Task 12: Rewrite page.tsx

**Files:**
- Rewrite: `src/app/page.tsx`

- [ ] **Step 1: Rewrite main page with two-tab flow**

```typescript
// src/app/page.tsx
'use client';

import { useState, useCallback } from 'react';
import VideoUploader from '@/components/video/VideoUploader';
import ReplayView from '@/components/replay/ReplayView';
import type { ProcessingResult, ProcessJobResponse } from '@/types/replay';

type Tab = 'upload' | 'replay';

export default function Home() {
  const [activeTab, setActiveTab] = useState<Tab>('upload');
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [cachedResult, setCachedResult] = useState<ProcessingResult | null>(null);

  const handleUploadComplete = useCallback(async (blobUrl: string, id: string) => {
    setVideoSrc(blobUrl);
    setVideoId(id);
    setActiveTab('replay');

    try {
      const response = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_url: blobUrl, video_id: id }),
      });

      const data = await response.json();

      if (data.cached && data.result_url) {
        const resultResponse = await fetch(data.result_url);
        const result: ProcessingResult = await resultResponse.json();
        setCachedResult(result);
      } else {
        const jobResponse = data as ProcessJobResponse;
        setJobId(jobResponse.job_id);
      }
    } catch (error) {
      console.error('Failed to start processing:', error);
    }
  }, []);

  return (
    <div className="min-h-screen bg-color-background">
      <header className="border-b border-color-border bg-color-surface">
        <div className="container py-4">
          <h1 className="text-xl font-bold text-on-surface">AI Soccer Coach</h1>
        </div>
      </header>

      <main className="container py-6">
        <div className="flex flex-col gap-6">
          <div className="flex gap-2 border-b border-color-border">
            <button
              onClick={() => setActiveTab('upload')}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition ${activeTab === 'upload' ? 'border-primary text-primary' : 'border-transparent text-on-surface-secondary'}`}
            >
              Upload
            </button>
            {videoSrc && (
              <button
                onClick={() => setActiveTab('replay')}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition ${activeTab === 'replay' ? 'border-primary text-primary' : 'border-transparent text-on-surface-secondary'}`}
              >
                Replay
              </button>
            )}
          </div>

          {activeTab === 'upload' && (
            <div className="max-w-2xl">
              <VideoUploader onUploadComplete={handleUploadComplete} />
            </div>
          )}

          {activeTab === 'replay' && videoSrc && (
            <ReplayView videoSrc={videoSrc} jobId={jobId} cachedResult={cachedResult} />
          )}
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Lint and type-check**

Run: `pnpm lint && pnpm type-check`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: rewrite page.tsx with two-tab flow (upload → replay)"
```

---

### Task 13: Remove Old Code & Dependencies

**Files:**
- Delete: `src/components/video/CalibrationOverlay.tsx`
- Delete: `src/components/tactical/TacticalBoard.tsx`
- Delete: `src/components/tactical/FieldTemplate.tsx`
- Delete: `src/components/tactical/PlayerMarker.tsx`
- Delete: `src/app/api/calibration/route.ts`
- Delete: `src/lib/field/detection.ts`
- Delete: `src/lib/field/homography.ts`
- Delete: `src/lib/video-processing/` (entire directory)
- Modify: `package.json`

- [ ] **Step 1: Remove old component files**

```bash
rm -f src/components/video/CalibrationOverlay.tsx
rm -f src/components/tactical/TacticalBoard.tsx
rm -f src/components/tactical/FieldTemplate.tsx
rm -f src/components/tactical/PlayerMarker.tsx
rm -f src/app/api/calibration/route.ts
rm -f src/lib/field/detection.ts
rm -f src/lib/field/homography.ts
rm -rf src/lib/video-processing/
```

- [ ] **Step 2: Remove unused dependencies**

Run: `pnpm remove framer-motion @ffmpeg/ffmpeg @ffmpeg/util modal`

- [ ] **Step 3: Remove old tests that import deleted modules**

Check for and remove any test files referencing deleted modules. Update `tests/modal-client.test.ts` if it still imports old functions.

- [ ] **Step 4: Lint and type-check**

Run: `pnpm lint && pnpm type-check`
Expected: No errors (may need to fix remaining imports elsewhere)

- [ ] **Step 5: Build**

Run: `pnpm build`
Expected: Successful build

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove old calibration, SVG tactical board, and unused dependencies"
```

---

## Phase 5: Modal Python Pipeline

### Task 14: Modal App — FastAPI Endpoints + Processing Stub

**Files:**
- Rewrite: `modal_app.py`
- Update: `requirements.txt`

This task creates the Modal app with the three HTTP endpoints and a stub `process_video` function that returns mock data. The real CV pipeline stages are added in subsequent tasks.

- [ ] **Step 1: Write modal_app.py with endpoints + mock processing**

```python
# modal_app.py
import modal
import fastapi
from fastapi.responses import JSONResponse
import time
import json

app = modal.App("soccer-analysis")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(["git", "libgl1", "libglib2.0-0", "ffmpeg", "wget"])
    .pip_install([
        "torch==2.3.1",
        "torchvision==0.18.1",
        "ultralytics",
        "boxmot",
        "opencv-python-headless==4.10.0.84",
        "scikit-learn",
        "supervision>=0.26.0",
        "scipy==1.13.1",
        "shapely==2.0.7",
        "munkres==1.1.4",
        "lsq-ellipse==2.2.1",
        "coloredlogs==15.0.1",
        "PyYAML==6.0.2",
        "tqdm",
        "requests",
    ])
    .run_commands([
        "git clone https://github.com/mguti97/PnLCalib.git /opt/PnLCalib",
        "mkdir -p /opt/PnLCalib/weights",
        "wget -q https://github.com/mguti97/PnLCalib/releases/download/v1.0.0/SV_kp -O /opt/PnLCalib/weights/SV_kp",
        "wget -q https://github.com/mguti97/PnLCalib/releases/download/v1.0.0/SV_lines -O /opt/PnLCalib/weights/SV_lines",
        'python -c "from ultralytics import YOLO; YOLO(\'yolo11n.pt\')"',
        'python -c "from boxmot import BotSort; from pathlib import Path; BotSort(reid_weights=Path(\'osnet_x0_25_msmt17.pt\'), device=\'cpu\', half=False)"',
    ])
    .env({"PYTHONPATH": "/opt/PnLCalib"})
)

progress_dict = modal.Dict.from_name("job-progress", create_if_missing=True)
web_app = fastapi.FastAPI()


@web_app.post("/submit")
async def submit(body: dict):
    video_url = body.get("video_url", "")
    field_template = body.get("field_template", "9v9")

    fn = modal.Function.from_name("soccer-analysis", "process_video")
    call = fn.spawn(video_url, field_template)
    call_id = call.object_id

    progress_dict.put(call_id, {"status": "processing", "stage": "starting", "percent": 0})
    return {"call_id": call_id}


@web_app.get("/status/{call_id}")
async def poll_status(call_id: str):
    state = progress_dict.get(call_id, default=None)
    if state is None:
        return JSONResponse({"status": "unknown"}, status_code=404)
    return state


@web_app.get("/result/{call_id}")
async def poll_result(call_id: str):
    function_call = modal.FunctionCall.from_id(call_id)
    try:
        result = function_call.get(timeout=0)
        return result
    except TimeoutError:
        return JSONResponse({"status": "processing"}, status_code=202)


@app.function()
@modal.asgi_app()
def fastapi_app():
    return web_app


@app.function(
    gpu="A10G",
    image=image,
    timeout=3600,
    enable_memory_snapshot=True,
    scaledown_window=300,
)
def process_video(video_url: str, field_template: str) -> dict:
    """Process a soccer match video and return tracking data.

    This is a stub that returns mock data. Real CV pipeline stages
    will be implemented in subsequent tasks.
    """
    import random

    call_id = modal.current_function_call_id()
    d = modal.Dict.from_name("job-progress", create_if_missing=True)

    stages = [
        ("transcoding", 5),
        ("camera_motion", 15),
        ("field_calibration", 30),
        ("detection", 45),
        ("tracking", 70),
        ("classification", 85),
        ("transform", 95),
    ]

    for stage_name, percent in stages:
        d.put(call_id, {"status": "processing", "stage": stage_name, "percent": percent})
        time.sleep(2)  # Simulate work

    # Mock output
    tracks = []
    for i in range(18):
        team = "home" if i < 9 else "away"
        keyframes = []
        for t in range(0, 600, 1):  # 10 minutes, 1 keyframe/sec
            keyframes.append({
                "time": float(t),
                "x": random.uniform(5, 50),
                "y": random.uniform(5, 31),
                "confidence": random.uniform(0.7, 1.0),
            })
        tracks.append({
            "player_id": f"track_{i + 1}",
            "team": team,
            "keyframes": keyframes,
        })

    d.put(call_id, {"status": "complete", "stage": "done", "percent": 100})

    return {
        "metadata": {
            "video_id": "mock",
            "fps": 30,
            "detection_fps": 10,
            "duration": 600,
            "frame_count": 18000,
            "field_template": field_template,
            "periods": [{"start_time": 0, "end_time": 600}],
            "processing_time_seconds": 14,
        },
        "tracks": tracks,
    }
```

- [ ] **Step 2: Update requirements.txt**

```
modal
fastapi
torch==2.3.1
torchvision==0.18.1
ultralytics
boxmot
opencv-python-headless==4.10.0.84
scikit-learn
supervision>=0.26.0
scipy==1.13.1
shapely==2.0.7
munkres==1.1.4
lsq-ellipse==2.2.1
coloredlogs==15.0.1
PyYAML==6.0.2
tqdm
requests
```

- [ ] **Step 3: Test deployment (requires Modal account)**

Run: `modal deploy modal_app.py`
Expected: Deploys successfully, prints endpoint URL

- [ ] **Step 4: Commit**

```bash
git add modal_app.py requirements.txt
git commit -m "feat: Modal app with FastAPI endpoints and mock processing pipeline"
```

---

### Task 15: Real CV Pipeline (replace mock with actual processing)

> **Note to implementer:** This task replaces the mock `process_video` function in `modal_app.py` with the real 7-stage CV pipeline. This is the most complex task and should be done by someone comfortable with OpenCV, YOLO, and the BoxMOT API. Refer to the spec at `docs/superpowers/specs/2026-04-07-video-to-tactical-replay-design.md` sections "Stage 1" through "Stage 7" for complete implementation details including:
>
> - FFmpeg transcoding (H.265 → H.264)
> - ECC camera motion estimation (`cv2.findTransformECC`)
> - PnLCalib field keypoint detection (import paths, model loading, `FramebyFrameCalib`)
> - YOLO batch inference with spectator filtering
> - BoT-SORT tracking with CMC
> - Halftime detection via frame differencing
> - K-Means team classification with reservoir sampling
> - Coordinate transform via accumulated homography
>
> The spec contains complete Python code for each stage. The single-pass architecture reads the transcoded video once, interleaving ECC (every frame), PnLCalib (every 30th), YOLO+BoT-SORT (every 3rd), and color sampling. Post-processing runs K-Means fitting, coordinate transforms, and halftime detection.
>
> Test with a 30-second clip before attempting a full match.

- [ ] **Step 1: Replace mock `process_video` with real pipeline following spec stages 1-7**
- [ ] **Step 2: Test with `modal run modal_app.py::process_video --args '{"video_url": "...", "field_template": "9v9"}'`**
- [ ] **Step 3: Verify output JSON matches `ProcessingResult` schema**
- [ ] **Step 4: Commit**

```bash
git add modal_app.py
git commit -m "feat: implement real 7-stage CV processing pipeline on Modal"
```

---

## Phase 6: Final Verification

### Task 16: End-to-End Test & Build Verification

- [ ] **Step 1: Run all frontend tests**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: No errors

- [ ] **Step 3: Type-check**

Run: `pnpm type-check`
Expected: No errors

- [ ] **Step 4: Production build**

Run: `pnpm build`
Expected: Successful build

- [ ] **Step 5: Manual smoke test**

Run: `pnpm dev`
1. Open http://localhost:3000
2. Upload a short video clip
3. Verify processing status shows with progress
4. Verify replay loads with animated dots on the tactical board
5. Verify video and tactical board are synced via scrubber

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found during end-to-end verification"
```
