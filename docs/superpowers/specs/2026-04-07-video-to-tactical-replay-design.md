# Video-to-Tactical Replay Pipeline Design

**Date:** 2026-04-07
**Status:** Approved (v2 — rewritten after audit)
**Approach:** Full Auto-Calibration

## Context

AI Soccer Coach converts sideline PTZ camera footage of 9v9 youth soccer games into animated top-down tactical board replays. The camera is an XBotGo Falcon mounted on a fixed tripod at midfield, 13 feet up, with AI auto-tracking that actively pans/tilts/zooms to follow play throughout the game.

### Scope & Non-Goals

**In scope:** Player detection, tracking, team classification, auto-calibration, coordinate transform, animated 2D replay synced to video.

**Explicitly out of scope for v1:**
- Ball detection/tracking
- Jersey number OCR
- Movement trails or heat maps
- Multi-camera stitching
- Real-time (live) processing

## User Flow

Three steps, no manual calibration:

1. **Upload** — Drag-drop video file (mp4/mov). XHR upload streams to server disk with progress bar. Field template fixed to 9v9.
2. **Processing** — Async Modal job. UI shows progress with stage name, % complete, and ETA. After upload completes, processing starts automatically — user does not pick a field template or trigger manually.
3. **Replay** — Side-by-side: original video (left), animated tactical board (right). Single timeline scrubber controls both. Play/pause, speed (0.5x/1x/2x), frame-step buttons.

### Upload → Processing Transition

After `handleUploadComplete`, the page switches directly to a "Processing" view (no Calibrate tab). The POST to `/api/process` fires automatically with the video_id and `field_template: "9v9"`. The old three-tab flow (Upload → Calibrate → Replay) becomes two tabs (Upload → Replay), where Processing is a sub-state of the Replay tab shown while the job is running.

## Modal Architecture

### Node.js ↔ Modal Bridge

The Modal Python SDK is Python-only. Node.js cannot call `.spawn()` or read Volumes directly. The bridge is a **pair of FastAPI web endpoints deployed on Modal** that the Next.js API routes call via plain HTTP fetch.

```python
# modal_app.py exposes two HTTP endpoints:

@web_app.post("/submit")
async def submit(body: dict):
    """Accepts {video_url, field_template}. Spawns the heavy function.
    Returns {call_id} immediately."""
    fn = modal.Function.from_name("soccer-analysis", "process_video")
    call = fn.spawn(body["video_url"], body["field_template"])
    return {"call_id": call.object_id}

@web_app.get("/result/{call_id}")
async def poll_result(call_id: str):
    """Returns 202 if still running, 200 with result if done, 500 if failed."""
    function_call = modal.FunctionCall.from_id(call_id)
    try:
        result = function_call.get(timeout=0)
        return result
    except TimeoutError:
        return JSONResponse({"status": "processing"}, status_code=202)
```

The Next.js API routes call these HTTP endpoints. No Python subprocess, no Volume reads from Node.js, no npm `modal` package needed.

### Video Transfer

The upload route already streams the video to disk at `uploads/{video_id}.mp4`. Rather than uploading the file a second time to a Modal Volume, the Modal function downloads the video from the Next.js server via a temporary presigned URL:

1. Next.js POST `/api/process` generates a time-limited URL for `/api/videos/{video_id}` (valid 2 hours)
2. Passes this URL to Modal's `/submit` endpoint
3. Modal function downloads the video via HTTP at the start of processing

This avoids the Volume upload bottleneck entirely. The existing `/api/videos/[id]` route already supports range requests and streaming.

**Caveat:** This requires the Next.js server to be reachable from Modal's infrastructure. In development, use ngrok or similar. In production on Vercel, this works natively.

### Why Not Modal Volumes for Video Transfer

Modal Volumes would work but add complexity:
- Need Python SDK locally to call `batch_upload`
- Upload bandwidth limited by local uplink (3-15 min for a 4GB file)
- Volume is only accessible from Modal containers — can't read status from Node.js
- The download-from-server approach reuses existing infrastructure

## Modal Processing Pipeline

Single Modal app on **A10G GPU** (24GB VRAM). Deploy with `modal deploy modal_app.py`. Cost: ~$1.10/hr active compute.

### Container Image

```python
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(["git", "libgl1", "libglib2.0-0", "ffmpeg", "wget"])
    .pip_install([
        "torch==2.3.1",
        "torchvision==0.18.1",
        "ultralytics",          # YOLOv11
        "boxmot",               # BoT-SORT + ReID
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
    ])
    .run_commands([
        # PnLCalib (not on PyPI — must clone)
        "git clone https://github.com/mguti97/PnLCalib.git /opt/PnLCalib",
        "mkdir -p /opt/PnLCalib/weights",
        "wget -q https://github.com/mguti97/PnLCalib/releases/download/v1.0.0/SV_kp -O /opt/PnLCalib/weights/SV_kp",
        "wget -q https://github.com/mguti97/PnLCalib/releases/download/v1.0.0/SV_lines -O /opt/PnLCalib/weights/SV_lines",
        # Pre-download YOLO weights
        "python -c \"from ultralytics import YOLO; YOLO('yolo11n.pt')\"",
        # Pre-download ReID weights for BoxMOT
        "python -c \"from boxmot import BotSort; from pathlib import Path; BotSort(reid_weights=Path('osnet_x0_25_msmt17.pt'), device='cpu', half=False)\"",
    ])
    .env({"PYTHONPATH": "/opt/PnLCalib"})
)
```

**Estimated image size:** ~4GB. Cold start: 10-20s first invocation, 2-5s with `enable_memory_snapshot=True`. Use `scaledown_window=300` to keep the container alive for 5 minutes between jobs.

### Stage 1: Frame Extraction & Transcoding

```python
# FFmpeg normalizes codec to H.264 (XBotGo Falcon may export H.265/HEVC)
subprocess.run([
    "ffmpeg", "-i", input_path,
    "-c:v", "libx264", "-preset", "ultrafast",
    "-an",  # strip audio
    output_path
], check=True)

# Then read frames with OpenCV
cap = cv2.VideoCapture(output_path)
fps = cap.get(cv2.CAP_PROP_FPS)  # typically 30
```

Frames stored as numpy arrays. For a 75-min match at 30fps = 135,000 frames. At 1080p that's ~370GB uncompressed — too large for memory. Process in a **streaming fashion**: read frame, process, discard. Never hold all frames in memory.

### Stage 2: Camera Motion Estimation (ECC, not optical flow)

**The previous spec incorrectly proposed `cv2.calcOpticalFlowFarneback()` for homography propagation.** Farneback produces dense per-pixel flow, not a geometric camera transform. For a PTZ camera, we need the global camera motion matrix.

Use `cv2.findTransformECC()` with `MOTION_HOMOGRAPHY`:

```python
def estimate_camera_motion(prev_gray: np.ndarray, curr_gray: np.ndarray) -> np.ndarray:
    """Returns 3x3 homography mapping prev_frame coords → curr_frame coords."""
    warp = np.eye(3, 3, dtype=np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 1000, 1e-8)
    try:
        _, warp = cv2.findTransformECC(
            prev_gray.astype(np.float32),
            curr_gray.astype(np.float32),
            warp, cv2.MOTION_HOMOGRAPHY, criteria
        )
    except cv2.error:
        pass  # ECC failed to converge — use identity (no motion)
    return warp
```

**Why ECC over optical flow:** Soccer pitches have large uniform grass areas where feature-based methods (goodFeaturesToTrack + calcOpticalFlowPyrLK) find too few keypoints. ECC is intensity-based and works on textureless regions. It also directly outputs a homography matrix instead of requiring RANSAC fitting on top of flow vectors.

**Accumulated homography:** Each frame's camera-to-field homography is: `H_field[i] = H_field[keyframe] @ H_accumulated[keyframe→i]`, where `H_accumulated` chains per-frame ECC results and `H_field[keyframe]` comes from PnLCalib.

### Stage 3: Field Calibration (PnLCalib)

Run PnLCalib field keypoint detection every 30th frame (~1/sec). PnLCalib detects field line intersections and fits them against a known field model to produce a homography.

```python
# PnLCalib returns field keypoints as pixel coordinates
# cv2.findHomography maps them to the 9v9 field template (55m x 36m)
field_pts_pixel = pnlcalib_detect(frame)  # detected keypoints
field_pts_meters = match_to_template(field_pts_pixel, "9v9")  # known positions
H_field, mask = cv2.findHomography(field_pts_pixel, field_pts_meters, cv2.RANSAC, 5.0)
```

**When PnLCalib fails** (too few visible field lines, e.g., tight zoom on a player):
- Use the ECC-accumulated homography from the last successful keyframe
- Mark frames as `low_confidence` if the gap exceeds 300 frames (10 seconds)
- Frontend renders low-confidence dots at 50% opacity

**PnLCalib weights:** `SV_kp` (single-view keypoint model) and `SV_lines` (line detection model), both downloaded into the container image at build time.

### Stage 4: Player Detection (YOLOv11n)

Run on every 3rd frame (10fps effective). Use **batch inference** (batch size 8) to maximize GPU utilization.

```python
from ultralytics import YOLO

model = YOLO("yolo11n.pt")

# Batch inference — 8 frames at once
batch_results = model(frame_batch, classes=[0], conf=0.25, batch=8)
# classes=[0] = person only (COCO class 0)

for result in batch_results:
    detections = sv.Detections.from_ultralytics(result)
    # Filter: bbox height must be 30-500px (rejects distant spectators and close-up artifacts)
    # Filter: bbox aspect ratio h/w must be 1.2-4.0 (standing person proportions)
    # Primary filter: foot position must be within field polygon (from current H matrix)
    # Secondary filter: bbox size heuristic (only when H confidence is low)
```

**Spectator filtering (fixed from v1 audit):** The primary filter is **homography-based field containment** — transform the foot position (bottom-center of bbox) through the current H matrix and check if it lands within field bounds (0-55m, 0-36m) with a 3m margin. Size-based filtering is the secondary fallback for frames where H is low-confidence.

**Performance with batch inference:** YOLOv11n on A10G processes ~300-400 frames/sec in batch mode. 45,000 frames / 350fps = ~130 seconds for detection alone.

### Stage 5: Player Tracking (BoT-SORT via BoxMOT v17)

```python
from boxmot import BotSort
from pathlib import Path

tracker = BotSort(
    reid_weights=Path("osnet_x0_25_msmt17.pt"),
    device=0,
    half=True,
    # Camera Motion Compensation — critical for PTZ footage
    # Uses ECC internally (same algorithm as Stage 2)
    cmc_method="ecc",
)

# Feed detections as np.ndarray shape (N, 6): [x1, y1, x2, y2, conf, class_id]
tracks = tracker.update(detections_array, frame)
# Returns (M, 8): [x1, y1, x2, y2, track_id, conf, class_id, det_idx]
```

**Player ID format:** `player_id = f"track_{int(track_id)}"`. This is stable within a single processing run. Track IDs are integers starting from 1, assigned by BoT-SORT.

**Halftime handling:** The XBotGo camera may stop and restart at halftime, creating a timestamp gap in the video. Detect gaps > 60 seconds between consecutive frames. When a gap is detected:
1. Reset the tracker state (new BoT-SORT instance)
2. Offset second-half track IDs by `max_first_half_id + 100` to avoid collision
3. Include a `period: 1 | 2` field in the output JSON

### Stage 6: Team Classification (K-Means)

**Fixed from v1 audit:** Use reservoir sampling across the entire match (not just first 30 seconds) and k=4 (home outfield, away outfield, goalkeeper, referee).

```python
from sklearn.cluster import KMeans

# Collect torso crops throughout the match via reservoir sampling (max 500 samples)
# For each crop: mask out green pixels (grass contamination), convert to HSV, compute histogram
torso_features = []  # list of HSV histogram vectors

kmeans = KMeans(n_clusters=4, n_init=10)
kmeans.fit(torso_features)

# Assign clusters to roles by frequency:
# - The two largest clusters → home and away (majority of players)
# - Smallest cluster → referee (typically 1 on field)
# - Remaining cluster → goalkeeper or second team variant
# Each track_id gets assigned by majority vote across its appearances
```

**Failure mode:** If two teams wear similar colors, K-Means produces poor separation. Fallback: use field position — at kickoff, teams are on opposite halves. Assign based on which half the player's average position falls in during the first 2 minutes.

### Stage 7: Output

JSON structure written to Modal's return value:

```typescript
interface ProcessingResult {
  metadata: {
    video_id: string;
    fps: number;              // original video fps
    detection_fps: number;    // effective fps (original / 3)
    duration: number;         // seconds
    frame_count: number;
    field_template: '9v9';
    periods: { start_time: number; end_time: number }[];
    processing_time_seconds: number;
  };
  tracks: {
    player_id: string;        // "track_1", "track_2", etc.
    team: 'home' | 'away' | 'referee' | 'unknown';
    keyframes: {
      time: number;           // seconds from video start
      x: number;              // meters (0-55)
      y: number;              // meters (0-36)
      confidence: number;     // 0-1
    }[];
  }[];
}
```

**Why this structure instead of flat array:** Grouped by player_id so the frontend can build its `Map<string, PlayerKeyframe[]>` directly without a groupBy pass. Also reduces JSON size by ~40% (player_id and team not repeated per keyframe).

### Performance Estimates (corrected)

The v1 spec claimed 10-15 min. That was wrong. Corrected math:

| Stage | Work | Time on A10G |
|-------|------|--------------|
| Transcode | FFmpeg H.265→H.264 | ~2-3 min |
| ECC camera motion | 135K frame pairs | ~5 min (40ms/pair at 720p downsample) |
| PnLCalib | 4,500 keyframes (every 30th) | ~3 min |
| YOLO detection | 45K frames, batch=8 | ~2 min |
| BoT-SORT tracking | 45K frames | ~2 min |
| Team classification | K-Means on 500 samples | <5 sec |
| Coordinate transform | 45K × ~18 players | <10 sec |
| **Total** | | **~15-20 min** |

Add video download time from server: 1-5 min depending on file size and network.

**Total user-facing wait: ~20-25 min for a 75-min match.** The UI should set expectations clearly: "Processing typically takes 20-25 minutes."

**Cost:** 20 min × $1.10/hr = **~$0.37/match** on A10G. Well under $1.

### Modal Function Configuration

```python
@app.function(
    gpu="A10G",
    image=image,
    timeout=3600,                    # 1 hour max
    enable_memory_snapshot=True,     # 2-5s cold start with snapshot
    scaledown_window=300,            # keep alive 5 min between jobs
)
def process_video(video_url: str, field_template: str) -> dict:
    ...
```

**Timeout:** Set to 3600s (1 hour). Modal supports up to 24h timeouts. A 75-min match processes in ~20 min, so 1 hour provides ample margin. No need for the split-into-halves workaround from v1.

## Frontend Architecture

### Replace SVG/framer-motion with Canvas2D

Current approach filters by exact frame (`players.filter(p => p.frame === currentFrame)`) — dots pop instead of gliding. Replace with Canvas2D + requestAnimationFrame + linear interpolation for 60fps smooth playback.

### Components

**`ReplayView`** — Main container. Side-by-side on desktop (CSS grid `1fr 1fr`), stacked on mobile (single column). Owns the `currentTime` ref (not state — avoids re-renders on every rAF tick). The video element is the source of truth for time; the canvas reads from it.

**`VideoPlayer`** — Restructured props interface:
```typescript
// Old: { videoSrc, currentFrame, onFrameChange }
// New:
interface VideoPlayerProps {
  videoSrc: string;
  videoRef: React.RefObject<HTMLVideoElement>;  // shared ref
  isPlaying: boolean;
  playbackSpeed: number;
  onReady: () => void;
}
```
The `videoRef` is owned by `ReplayView` and shared with `TacticalCanvas`. This eliminates the sync feedback loop problem: `TacticalCanvas` reads `videoRef.current.currentTime` directly on each rAF tick instead of going through React state.

**`TacticalCanvas`** — Two stacked `<canvas>` elements via absolute positioning:

```typescript
interface TacticalCanvasProps {
  tracks: ProcessingResult['tracks'];
  videoRef: React.RefObject<HTMLVideoElement>;
}
```

- **Bottom canvas (field):** Draws the 9v9 field diagram once on mount. Redraws on resize via `ResizeObserver`. Uses `devicePixelRatio` for crisp rendering on retina displays:
  ```typescript
  const dpr = window.devicePixelRatio || 1;
  canvas.width = container.clientWidth * dpr;
  canvas.height = container.clientHeight * dpr;
  ctx.scale(dpr, dpr);
  // Draw at CSS pixel coordinates; canvas handles scaling
  ```

- **Top canvas (players):** Redrawn every rAF tick. Scale factors computed on resize:
  ```typescript
  const scaleX = canvas.clientWidth / 55;  // 55m field width
  const scaleY = canvas.clientHeight / 36; // 36m field height
  ```

**`TimelineControl`** — HTML range input driving the video element. Play/pause toggles `videoRef.current.play()` / `.pause()`. Speed selector sets `videoRef.current.playbackRate`. Frame-step: pause, then `videoRef.current.currentTime += 1/detectionFps`.

**`ProcessingStatus`** — Shown while job is running. Polls `/api/process/status/{jobId}` every 5 seconds via `useEffect` with cleanup. Shows stage name, progress bar, ETA. "Retry" button on failure.

### Animation Logic (detailed)

```typescript
// Runs every requestAnimationFrame tick (~60fps)
function renderPlayers(ctx: CanvasRenderingContext2D, tracks: Track[], videoEl: HTMLVideoElement) {
  const t = videoEl.currentTime;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  for (const track of tracks) {
    const kf = track.keyframes;
    if (kf.length === 0) continue;

    // Edge case: before first keyframe or after last keyframe — clamp
    if (t <= kf[0].time) {
      drawDot(ctx, kf[0], track.team, 1.0);
      continue;
    }
    if (t >= kf[kf.length - 1].time) {
      // Fade out over 500ms after last keyframe (player left frame)
      const fadeT = Math.max(0, 1 - (t - kf[kf.length - 1].time) / 0.5);
      if (fadeT > 0) drawDot(ctx, kf[kf.length - 1], track.team, fadeT);
      continue;
    }

    // Binary search for bracketing keyframes
    const idx = binarySearch(kf, t); // returns index where kf[idx].time <= t < kf[idx+1].time
    const prev = kf[idx];
    const next = kf[idx + 1];
    const alpha = (t - prev.time) / (next.time - prev.time);

    const x = prev.x + (next.x - prev.x) * alpha;
    const y = prev.y + (next.y - prev.y) * alpha;
    const confidence = Math.min(prev.confidence, next.confidence);

    drawDot(ctx, { x, y }, track.team, confidence < 0.5 ? 0.5 : 1.0);
  }
}

function drawDot(ctx: CanvasRenderingContext2D, pos: {x: number, y: number}, team: string, opacity: number) {
  const px = pos.x * scaleX;
  const py = pos.y * scaleY;
  ctx.globalAlpha = opacity;
  ctx.beginPath();
  ctx.arc(px, py, DOT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = TEAM_COLORS[team];
  ctx.fill();
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.globalAlpha = 1;
}
```

**Fade behavior:**
- Player appears (first keyframe): dot pops in at full opacity (no fade-in needed since the data starts when the player enters frame)
- Player disappears (after last keyframe): fade out over 500ms
- Low confidence frames: 50% opacity

### Data Loading

The result JSON from `/api/process/result/{jobId}` is fetched as a stream and parsed incrementally to avoid blocking the main thread:

```typescript
const response = await fetch(`/api/process/result/${jobId}`);
const reader = response.body.getReader();
const decoder = new TextDecoder();
let json = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  json += decoder.decode(value, { stream: true });
}
const result: ProcessingResult = JSON.parse(json);
```

For v1 this is sufficient. If JSON sizes become problematic (>50MB), switch to streaming JSON parser or binary format in v2.

**Memory estimate (corrected):** The grouped-by-player JSON structure stores ~810K keyframes (18 players × 10fps × 75 min). Each keyframe is `{time, x, y, confidence}` = 4 floats = 16 bytes raw, but as parsed JS objects with V8 overhead: ~80 bytes each. Total: **~65MB resident heap.** This is fine for desktop browsers but worth noting.

## API Changes

### New/Modified Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/process` | POST | Calls Modal `/submit`, returns `{job_id}` immediately |
| `/api/process/status/[jobId]` | GET | Calls Modal `/result/{call_id}`, returns status |
| `/api/process/result/[jobId]` | GET | Calls Modal `/result/{call_id}`, returns full JSON when done. Caches to `uploads/{video_id}.json` |

### Environment Variables

```bash
# Server-only (NO NEXT_PUBLIC_ prefix — never exposed to browser)
MODAL_ENDPOINT=https://your-workspace--soccer-analysis-fastapi-app.modal.run

# The existing NEXT_PUBLIC_MODAL_ENDPOINT must be renamed to MODAL_ENDPOINT
# and all references updated to server-side only
```

### Result Caching

Results cached as `uploads/{video_id}.json`. The POST `/api/process` checks for this file first — if it exists, returns the cached result immediately without calling Modal.

### Removed

| Item | Reason |
|------|--------|
| `/api/calibration` route | Auto-calibration replaces manual |
| `NEXT_PUBLIC_MODAL_ENDPOINT` env var | Renamed to `MODAL_ENDPOINT` (server-only) |

## Error Handling

### Modal Failures
- Job fails (GPU OOM, exception, timeout): Modal's `/result/{call_id}` returns an error. Status endpoint surfaces it as `{status: "failed", error: "description"}`. UI shows "Retry" button.
- Container cold start: 2-5s with memory snapshot. Not user-visible (happens before processing begins).

### Field Calibration Gaps
- PnLCalib fails (tight zoom, no field lines visible): ECC-accumulated homography carries forward from last good keyframe.
- Gap > 10 seconds: frames marked `low_confidence`. Frontend renders at 50% opacity.
- If PnLCalib fails on the very first frame: fall back to a default homography estimated from the known camera position (midfield, 13ft up, typical XBotGo lens FOV).

### Player Tracking Edge Cases
- Players leaving/entering frame: BoT-SORT + ReID handles natively.
- Substitutions: new `track_id` assigned. Correct behavior.
- ID swaps during close contact (huddle, throw-in): acceptable — positions remain correct.
- Halftime: tracker reset + ID offset (see Stage 5 above).

### Video Edge Cases
- H.265 codec from XBotGo: FFmpeg transcodes to H.264 in Stage 1.
- Non-standard resolution: YOLO and ECC both work at any resolution. PnLCalib expects at least 720p.
- Corrupted file: FFmpeg fails during transcode; error surfaces to user.

### Browser
- Navigate away during processing: polling stops via useEffect cleanup. Return to same video_id and processing resumes (job_id stored on server as `uploads/{video_id}.job`).
- Large result JSON: ~65MB heap is fine for desktop; show a warning on mobile.

## Type Changes

### New Types (`src/types/replay.ts`)

```typescript
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
  periods: { start_time: number; end_time: number }[];
  processing_time_seconds: number;
}

export interface Track {
  player_id: string;
  team: 'home' | 'away' | 'referee' | 'unknown';
  keyframes: Keyframe[];
}

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

export interface ProcessResponse {
  job_id: string;
}
```

### Modified Types (`src/types/index.ts`)

`UploadResponse` stays as-is. `ProcessResponse`, `ProcessedVideoData`, and `CalibrationResponse` are superseded by the new types in `replay.ts`.

## Tech Stack Summary

| Layer | Technology | Detail |
|-------|-----------|--------|
| Detection | YOLOv11n | COCO pretrained, person class only, batch=8 |
| Tracking | BoT-SORT + OSNet ReID | BoxMOT v17, CMC with ECC |
| Field Calibration | PnLCalib | SV_kp + SV_lines weights, git-cloned into container |
| Camera Motion | cv2.findTransformECC | MOTION_HOMOGRAPHY mode, chains per-frame |
| Team Classification | K-Means k=4 on HSV | Reservoir sampling across full match |
| GPU Compute | Modal.com A10G | ~$0.37/match, 20-25 min processing |
| CV Glue | supervision 0.26.x | Detections container + video frame generator |
| Frontend Animation | Canvas2D + rAF + lerp | Two-layer canvas, binary search interpolation |
| Framework | Next.js 16 + React 19 | Existing stack, no new frontend deps |
| Transcoding | FFmpeg (apt-installed on Modal) | H.265→H.264 normalization |

## What Gets Removed

- `src/components/video/CalibrationOverlay.tsx` — no manual calibration
- `src/app/api/calibration/route.ts` — no calibration API
- `src/lib/field/detection.ts` — replaced by PnLCalib on Modal
- `src/lib/field/homography.ts` — homography computed on Modal
- `src/lib/video-processing/` — entire directory, detection/tracking on Modal
- `src/components/tactical/PlayerMarker.tsx` — replaced by Canvas2D drawing
- `src/components/tactical/TacticalBoard.tsx` — replaced by TacticalCanvas
- `src/components/tactical/FieldTemplate.tsx` — replaced by canvas field renderer
- `framer-motion` dependency
- `@ffmpeg/ffmpeg` and `@ffmpeg/util` dependencies (WASM FFmpeg, unused)
- `modal` npm dependency (unused JS stub)
- `NEXT_PUBLIC_MODAL_ENDPOINT` env var (replaced by server-only `MODAL_ENDPOINT`)

## What Gets Added

- `modal_app.py` — Complete rewrite: FastAPI endpoints + 7-stage pipeline
- `requirements.txt` — Updated with Modal + processing dependencies
- `src/components/replay/ReplayView.tsx` — Main replay container
- `src/components/replay/TacticalCanvas.tsx` — Canvas2D animated field
- `src/components/replay/TimelineControl.tsx` — Shared scrubber
- `src/components/replay/ProcessingStatus.tsx` — Progress indicator
- `src/app/api/process/status/[jobId]/route.ts` — Status polling endpoint
- `src/app/api/process/result/[jobId]/route.ts` — Result fetch endpoint
- `src/lib/replay/interpolation.ts` — Binary search + lerp logic
- `src/lib/replay/field-renderer.ts` — Canvas 9v9 field drawing
- `src/types/replay.ts` — All replay-related types

## What Gets Modified

- `src/app/page.tsx` — Two tabs: Upload, Replay. Processing is sub-state of Replay.
- `src/app/api/process/route.ts` — Calls Modal `/submit` endpoint, returns job_id
- `src/lib/modal-client.ts` — HTTP calls to Modal FastAPI endpoints (submit + poll)
- `src/components/video/VideoPlayer.tsx` — New props interface with shared videoRef
- `src/types/index.ts` — Keep UploadResponse, deprecate old ProcessResponse
- `package.json` — Remove framer-motion, @ffmpeg/ffmpeg, @ffmpeg/util, modal
- `.env.example` — Rename NEXT_PUBLIC_MODAL_ENDPOINT to MODAL_ENDPOINT

## Testing Plan

### Frontend Tests (Vitest + jsdom)
- `tests/replay/interpolation.test.ts` — Binary search edge cases (before first keyframe, after last, exact match, between frames), lerp correctness
- `tests/replay/field-renderer.test.ts` — Canvas coordinate mapping, resize handling, scale factor computation
- `tests/api/process.test.ts` — Updated: mock Modal HTTP calls, test async job flow, test caching behavior
- `tests/modal-client.test.ts` — Updated: test submit/poll HTTP pattern

### Modal Pipeline Tests (Python, run locally)
- Test PnLCalib keypoint detection on sample frames
- Test ECC homography estimation between consecutive frames
- Test BoT-SORT tracking with known detections
- Test team classification K-Means on synthetic color data
- End-to-end: process a 30-second clip, verify output JSON schema

### Removed Tests
- `tests/calibration/` — if any exist, remove (calibration removed)
- Update any test that imports from removed files
