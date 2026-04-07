# Video-to-Tactical Replay Pipeline Design

**Date:** 2026-04-07
**Status:** Approved
**Approach:** Full Auto-Calibration (Approach A)

## Context

AI Soccer Coach converts sideline PTZ camera footage of 9v9 youth soccer games into animated top-down tactical board replays. The camera is an XBotGo Falcon mounted on a fixed tripod at midfield, 13 feet up, with AI auto-tracking that actively pans/tilts/zooms to follow play throughout the game.

## User Flow

Three steps, no manual calibration:

1. **Upload** — Drag-drop video file (mp4/mov). Progress bar shows upload.
2. **Processing** — Async Modal job. User sees progress indicator with stage name, % complete, and ETA. Polls every 5 seconds.
3. **Replay** — Side-by-side: original video (left), animated tactical board (right). Single timeline scrubber controls both. Play/pause, speed (0.5x/1x/2x), frame-step buttons.

## Modal Processing Pipeline

Single Modal app on A10 GPU. Seven sequential stages:

### Stage 1: Frame Extraction
- FFmpeg extracts frames at native FPS (typically 30fps from XBotGo)
- Stored as numpy arrays in memory

### Stage 2: Field Calibration (PnLCalib)
- Run PnLCalib field keypoint detection every 30th frame (~1/sec)
- Each keyframe: detected field points -> `cv2.findHomography()` with RANSAC -> homography matrix H
- Between keyframes: propagate H using `cv2.calcOpticalFlowFarneback()`
- Result: one H matrix per frame
- Handles partial field visibility when camera is zoomed in

### Stage 3: Player Detection (YOLOv11n)
- Run on every 3rd frame (10fps effective) for processing speed
- Detect all "person" class objects
- Filter by bounding box size (too small = distant spectator, too large = close-up artifact)
- Use foot position (bottom-center of bbox) as ground contact point

### Stage 4: Player Tracking (BoT-SORT via BoxMOT)
- BoT-SORT with Camera Motion Compensation (CMC) enabled — critical for PTZ footage
- Outputs persistent `tracker_id` per player across frames
- ReID embeddings (OSNet) handle re-identification after occlusion

### Stage 5: Team Classification (K-Means)
- Collect torso crops (upper half of bbox) from first 30 seconds
- K-Means k=3 on HSV histograms: home, away, referee
- Assign each `tracker_id` a team label by majority vote across appearances

### Stage 6: Coordinate Transform
- For each player on each frame: foot position (pixel) -> apply frame's H matrix -> (x_meters, y_meters)
- Coordinate space: 9v9 field, 0-55m x 0-36m
- Clamp to field bounds

### Stage 7: Output
- JSON array: `{frame, time, player_id, x_meters, y_meters, team, confidence}` per player per frame
- Metadata: `{fps, duration, frame_count, field_template, processing_fps}`
- Stored as `uploads/{video_id}.json` on server

### Performance Estimates
- Processing every 3rd frame at 1080p on A10: ~10-15 min for a 75-min match
- Cost: ~$0.69-1.00/match on Modal A10

## Frontend Architecture

### Replace SVG/framer-motion with Canvas2D

Current approach (framer-motion SVG) filters by exact frame and doesn't interpolate — dots "pop" instead of gliding. Replace with Canvas2D + requestAnimationFrame + linear interpolation for 60fps smooth playback.

### Components

**`ReplayView`** — Main container. Side-by-side layout. Owns shared timeline state (currentTime, isPlaying, playbackSpeed).

**`VideoPlayer`** — Existing component, minor update. Reports `currentTime` on `timeupdate` events. Responds to external seek commands.

**`TacticalCanvas`** — New component. Two stacked `<canvas>` elements:
- Bottom layer (static): 9v9 field diagram drawn once. Redraws only on resize.
- Top layer (dynamic): Player dots redrawn every rAF tick (~60fps). Linearly interpolates between nearest data keyframes.

**`TimelineControl`** — Single scrubber driving both video and canvas. Play/pause, speed selector (0.5x/1x/2x), frame-step buttons.

**`ProcessingStatus`** — Shown during Modal processing. Polls `/api/process/status/{jobId}` every 5 seconds. Progress bar with stage name and ETA.

### Animation Logic

```
On each requestAnimationFrame tick:
  1. Get currentTime from video element
  2. For each player_id, binary search for bracketing keyframes
  3. Compute t = (currentTime - prev.time) / (next.time - prev.time)
  4. x = lerp(prev.x_meters, next.x_meters, t)
  5. y = lerp(prev.y_meters, next.y_meters, t)
  6. Draw colored circle at (x, y) on canvas
  7. Players appearing/disappearing fade over 150ms
```

### Data Structure in Browser

`Map<string, PlayerKeyframe[]>` keyed by `player_id`. Each keyframe: `{time, x_meters, y_meters, team}`. Binary search for O(log n) lookup.

Memory: 18 players x 10fps x 75 min = ~810K keyframes x ~40 bytes = ~32MB. Comfortable for any modern browser.

## API Changes

### New Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/process` | POST | Kick off Modal job, return `{job_id}` immediately |
| `/api/process/status/[jobId]` | GET | Poll progress: `{stage, percent, eta_seconds, status}` |
| `/api/process/result/[jobId]` | GET | Fetch completed position JSON |

### Modified Routes

| Route | Change |
|-------|--------|
| `/api/upload` | No change — already works |
| `/api/videos/[id]` | No change — already works |

### Removed Routes

| Route | Reason |
|-------|--------|
| `/api/calibration` | No longer needed — auto-calibration replaces manual |

### Processing Flow

**Video transfer to Modal:** The Next.js server uploads the video file to a Modal Volume (shared network filesystem) using the Modal Python SDK's `.put()` method. The Modal function then reads from the Volume — no JSON-encoded bytes, no size limits. A small Python helper script on the server handles the Volume upload.

**Async execution:** Use Modal's `.spawn()` to launch the processing function asynchronously. This returns a `function_call_id` which serves as the job_id. Use `.get()` to check if results are ready. Job status and progress are tracked via a simple JSON file on the Modal Volume (`{job_id}_status.json`) that the Modal function updates as it progresses through stages.

```
POST /api/process {video_id, field_template: "9v9"}
  -> Python helper uploads video to Modal Volume
  -> modal_fn.spawn(video_path, field_template) returns function_call_id
  -> Store job_id mapping on disk: uploads/{video_id}.job -> {job_id}
  -> Return {job_id} to browser immediately

GET /api/process/status/{job_id}  (polled every 5s)
  -> Read {job_id}_status.json from Modal Volume via Python helper
  -> {status: "processing", stage: "detection", percent: 45, eta_seconds: 320}
  -> {status: "complete"}
  -> {status: "failed", error: "reason"}

GET /api/process/result/{job_id}
  -> Read {job_id}_result.json from Modal Volume
  -> Return full player position JSON
  -> Cache locally as uploads/{video_id}.json
```

### Result Caching

Results stored as `uploads/{video_id}.json`. If a result file exists when processing is requested, return it immediately without reprocessing.

## Error Handling

### Modal Failures
- GPU OOM, timeout, crash: status endpoint returns `{status: "failed", error}`. UI shows "Retry" button.
- 60-minute Modal timeout: split video into halves, process separately, merge results.

### Field Calibration Gaps
- PnLCalib fails on a stretch of frames (tight zoom, no visible field lines): interpolate H from last good keyframe to next good keyframe.
- Gap exceeds 10 seconds: mark frames as `low_confidence`. Frontend renders dots at reduced opacity.

### Player Tracking Edge Cases
- Players leaving/entering frame: BoT-SORT handles natively. ReID re-associates returning players.
- Substitutions: new `tracker_id` assigned. Correct behavior.
- Players standing close (huddle, throw-in): occasional ID swaps acceptable — positions remain correct.

### Browser
- User navigates away during processing: polling stops via useEffect cleanup. Return to same video_id resumes status polling.
- Large result files: 32MB in memory is fine for modern browsers.

## Tech Stack Summary

| Layer | Technology | Version/Model |
|-------|-----------|---------------|
| Detection | YOLOv11n (COCO pretrained) | ultralytics latest |
| Tracking | BoT-SORT with CMC + ReID | BoxMOT latest |
| Field Calibration | PnLCalib | keypoint detector |
| Homography Propagation | OpenCV optical flow | cv2.calcOpticalFlowFarneback |
| Team Classification | K-Means k=3 on HSV | scikit-learn |
| GPU Compute | Modal.com A10 | ~$0.69-1.00/match |
| CV Glue | Roboflow supervision | 0.26.x |
| Frontend Animation | Canvas2D + rAF + lerp | Native browser APIs |
| Framework | Next.js 16 + React 19 | Existing stack |
| Video Processing | FFmpeg | Frame extraction |

## What Gets Removed

- `src/components/video/CalibrationOverlay.tsx` — no manual calibration
- `src/app/api/calibration/route.ts` — no calibration API
- `src/lib/field/detection.ts` — green field detection replaced by PnLCalib on Modal
- `src/lib/field/homography.ts` — homography computed on Modal, not in browser
- `src/lib/video-processing/` — detection/tracking moved to Modal
- `src/components/tactical/PlayerMarker.tsx` — replaced by Canvas2D drawing
- framer-motion dependency — no longer needed

## What Gets Added

- `modal_app.py` — Complete rewrite with 7-stage pipeline
- `src/components/replay/ReplayView.tsx` — Main replay container
- `src/components/replay/TacticalCanvas.tsx` — Canvas2D animated field
- `src/components/replay/TimelineControl.tsx` — Shared scrubber
- `src/components/replay/ProcessingStatus.tsx` — Progress indicator
- `src/app/api/process/status/[jobId]/route.ts` — Status polling endpoint
- `src/app/api/process/result/[jobId]/route.ts` — Result fetch endpoint
- `src/lib/replay/interpolation.ts` — Binary search + lerp logic
- `src/lib/replay/field-renderer.ts` — Canvas field diagram drawing
- `src/types/replay.ts` — Replay-specific types

## What Gets Modified

- `src/app/page.tsx` — Simplified tabs: Upload and Replay (no Calibrate tab)
- `src/app/api/process/route.ts` — Async job submission instead of blocking
- `src/lib/modal-client.ts` — Updated to support job submission + status polling
- `src/components/video/VideoPlayer.tsx` — Expose currentTime via callback, accept external seek
- `package.json` — Remove framer-motion, add no new frontend deps
