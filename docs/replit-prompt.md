# Replit Prompt: AI Soccer Coach — Video to Tactical Replay

## What This App Does

Build a web app that takes sideline video footage of 9v9 youth soccer games and produces an animated top-down tactical board replay showing all players as colored dots moving in real-time, synced to the original video. The user uploads a video, waits 20-25 minutes while it processes on a GPU, then watches the replay side-by-side with the original footage.

## Who It's For

A single youth soccer coach who records games with an **XBotGo Falcon** — an AI-powered PTZ (pan-tilt-zoom) camera mounted on a fixed tripod at midfield, 13 feet high. The camera automatically pans, tilts, and zooms to follow play throughout the entire game. This means the field view is constantly changing — sometimes wide showing the full field, sometimes zoomed in tracking action near one goal.

## The User Flow (3 steps, zero configuration)

### Step 1: Upload
- Drag-drop or browse for a video file (MP4 or MOV, typically 2-4GB for a full match)
- Show upload progress bar
- The XBotGo Falcon may export H.265/HEVC codec — the backend must handle this

### Step 2: Processing (automatic, no user input)
- After upload completes, processing starts automatically
- Show a progress indicator with the current stage name and percent complete
- Tell the user "Processing typically takes 20-25 minutes for a full match"
- Stages: transcoding → field detection → player detection → tracking → team classification → coordinate mapping
- The user can navigate away and come back — processing continues server-side

### Step 3: Replay
- Side-by-side layout: original video on the left, animated tactical board on the right
- A single timeline scrubber controls both simultaneously
- Play/pause button, playback speed (0.5x, 1x, 2x), frame-step forward/back buttons
- The tactical board shows a top-down 9v9 soccer field (55m × 36m) with colored dots:
  - Blue dots = home team
  - Red dots = away team
  - Yellow dot = referee
  - Gray dots = unclassified
- Dots must glide smoothly between positions (interpolate at 60fps), not jump between frames
- When scrubbing the video, dots should update instantly to match the current time

## The Computer Vision Pipeline (runs on GPU)

This is the hard part. Process the uploaded video through these stages:

### 1. Transcode
FFmpeg: normalize codec to H.264 (the XBotGo may export H.265). Strip audio.

### 2. Field Keypoint Detection + Homography (per frame)
**Use the Roboflow sports stack** — this is the most production-ready approach:
- `pip install git+https://github.com/roboflow/sports.git`
- `pip install supervision inference-gpu`
- Use the pretrained model `football-field-detection-f07vi/14` from Roboflow Universe (free API key required) — it detects 32 characteristic field keypoints (corners, penalty area corners, center circle, etc.)
- Per frame: detect keypoints → filter by confidence > 0.5 → build homography via `ViewTransformer` from `sports.common.view`
- This handles PTZ footage because the 32-keypoint model is dense enough that even zoomed-in views have 4+ visible points
- `SoccerPitchConfiguration` from `sports.configs.soccer` defines all 32 points in centimeters

```python
from sports.configs.soccer import SoccerPitchConfiguration
from sports.common.view import ViewTransformer
import supervision as sv
import numpy as np

CONFIG = SoccerPitchConfiguration()

# Per-frame calibration
result = pitch_model.infer(frame, confidence=0.3)[0]
keypoints = sv.KeyPoints.from_inference(result)
mask = keypoints.confidence[0] > 0.5

if mask.sum() >= 4:  # need at least 4 points for homography
    transformer = ViewTransformer(
        source=keypoints.xy[0][mask].astype(np.float32),
        target=np.array(CONFIG.vertices)[mask].astype(np.float32)
    )
    # transformer.transform_points() maps pixel coords → field coords (cm)
```

### 3. Player Detection
- Use YOLOv11n (or Roboflow's `football-players-detection-3zvbc` model which also classifies goalkeeper/referee)
- Run on every 3rd frame (10fps effective) for speed
- Use batch inference (batch size 8) for GPU efficiency
- Filter detections: bounding box height 30-500px, aspect ratio 1.2-4.0
- Primary spectator filter: transform foot position through homography, reject if outside field bounds (0-55m, 0-36m) with 3m margin

### 4. Player Tracking
- Use `supervision.ByteTrack` for multi-object tracking — it's built into the supervision library, no extra dependencies
- This gives each player a persistent `tracker_id` across frames
- For PTZ cameras, ByteTrack works well because the Roboflow homography recomputes per-frame (no accumulated drift)

```python
tracker = sv.ByteTrack()
detections = tracker.update_with_detections(detections)
# detections.tracker_id now has persistent IDs
```

### 5. Team Classification
- Use Roboflow's `TeamClassifier` from `sports.common.team` (SigLIP embeddings + UMAP + KMeans)
- Or simpler: K-Means k=4 on HSV histograms of torso crops (upper half of bounding box)
- Reservoir sampling across the full match (not just first 30 seconds — XBotGo zooms during kickoff)
- Mask out green pixels before computing histograms (grass contamination in torso crops)
- Assign: two largest clusters = home/away, smallest = referee, remainder = goalkeeper/unknown

### 6. Coordinate Transform
- For each tracked player on each detection frame:
  - Take foot position (bottom-center of bounding box)
  - Transform through the per-frame homography: pixel → field centimeters
  - Convert to meters (divide by 100) and clamp to field bounds (0-55m × 0-36m)
- The output coordinate space is a 9v9 field: x = 0-55 meters (length), y = 0-36 meters (width)

### 7. Halftime Detection
- The video is continuous (no file splits) — detect halftime by content analysis
- Compute frame-differencing motion scores at 1fps (downsample to 320×180 for speed)
- Find the longest continuous low-motion window exceeding 5 minutes → that's halftime
- When detected: split output into two periods, reset tracker IDs for second half

## Output Data Format

The pipeline outputs a JSON structure like this:

```json
{
  "metadata": {
    "video_id": "abc123",
    "fps": 30,
    "detection_fps": 10,
    "duration": 4500.0,
    "frame_count": 135000,
    "field_template": "9v9",
    "periods": [
      {"start_time": 0, "end_time": 2100},
      {"start_time": 3000, "end_time": 4500}
    ],
    "processing_time_seconds": 1200
  },
  "tracks": [
    {
      "player_id": "track_1",
      "team": "home",
      "keyframes": [
        {"time": 0.0, "x": 27.5, "y": 18.0, "confidence": 0.95},
        {"time": 0.1, "x": 27.8, "y": 17.9, "confidence": 0.92}
      ]
    }
  ]
}
```

Tracks are grouped by player_id. Keyframes are at detection_fps (every 0.1s if detection runs at 10fps). The frontend interpolates between keyframes for smooth 60fps animation.

## GPU Processing — Use Modal.com

The CV pipeline needs a GPU. Use Modal.com (serverless GPU):
- A10G GPU, ~$1.10/hr, processes a 75-min match in ~20-25 minutes
- Cost: ~$0.37 per match
- Deploy the Python pipeline as a Modal function
- Expose FastAPI web endpoints on Modal for job submission and status polling:
  - `POST /submit` — accepts `{video_url, field_template}`, spawns GPU function via `.spawn()`, returns `{call_id}`
  - `GET /status/{call_id}` — returns `{status, stage, percent}` from `modal.Dict` (progress reporting)
  - `GET /result/{call_id}` — returns 202 if still processing, 200 with full JSON when done

**Critical Modal patterns:**
- Use `@modal.concurrent(max_inputs=100)` on the ASGI app function — without it, requests queue serially
- Use async variants for Dict operations in async handlers: `await dict.get.aio()`, `await dict.put.aio()`
- Give the web endpoint its own lightweight image (`pip install fastapi[standard]`) — don't use the heavy GPU image
- Use `enable_memory_snapshot=True` on the GPU function for faster cold starts (2-5s instead of 20s)
- The GPU function updates progress via `modal.Dict.put()` as it moves through stages

## File Storage

Videos are too large for serverless function bodies (4.5MB limit). Use Vercel Blob or any cloud storage:
- Browser uploads directly to storage (client upload pattern) — server only handles token exchange
- The public blob URL is passed to Modal, which downloads the video at the start of processing
- Processing results (JSON) are also stored in blob storage for caching

## Frontend Animation — Use Canvas2D, Not SVG

For the tactical board replay, use HTML5 Canvas with `requestAnimationFrame`, NOT SVG or React animation libraries:
- SVG with React re-renders drops frames with 18+ moving elements
- Use two stacked canvas layers: bottom (static field diagram, drawn once), top (player dots, redrawn every frame)
- Handle `ResizeObserver` for responsive sizing and `devicePixelRatio` for retina displays
- Read `video.currentTime` directly on each animation frame — don't go through React state (avoids feedback loops)

**Interpolation between keyframes:**
```
For each player, on each animation frame:
  1. Binary search the keyframe array for the two keyframes bracketing current time
  2. Compute alpha = (currentTime - prevKeyframe.time) / (nextKeyframe.time - prevKeyframe.time)
  3. x = prevKeyframe.x + (nextKeyframe.x - prevKeyframe.x) * alpha
  4. y = prevKeyframe.y + (nextKeyframe.y - prevKeyframe.y) * alpha
  5. Draw colored circle at the interpolated position
```

Edge cases:
- Before first keyframe: clamp to first position
- After last keyframe: fade out over 500ms (player left the frame)
- Low confidence (<0.5): render at 50% opacity

## Environment Variables Needed

```
MODAL_ENDPOINT=https://your-workspace--soccer-analysis-fastapi-app.modal.run
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...  (or equivalent for your storage)
ROBOFLOW_API_KEY=rf_...  (free tier, for the field keypoint model)
```

## What NOT to Build

- No authentication (single-user tool)
- No database (blob storage + Modal Dict for state)
- No ball tracking (out of scope for v1)
- No jersey number detection
- No movement trails or heat maps
- No real-time/live processing — upload-then-wait only
- No multi-camera support
- No manual calibration UI — everything is automatic

## Performance Expectations

- Upload: depends on file size and connection (1-5 min for 4GB)
- Processing: 20-25 minutes for a 75-minute match on A10G GPU
- Replay: 60fps smooth animation for 18+ players
- Memory: ~65MB browser heap for a full match's tracking data (fine for desktop)
- Cost: ~$0.37/match on Modal

## Key Gotchas I Learned Building This

1. XBotGo Falcon exports H.265/HEVC — FFmpeg must transcode to H.264 before OpenCV can read it
2. PnLCalib and other academic repos are NOT pip-installable — use Roboflow's stack instead
3. Modal's ASGI app needs `@modal.concurrent` or it queues requests (causes timeouts)
4. Modal Dict operations must use `.aio()` variants in async handlers or they block the event loop
5. The field keypoint model needs at least 4 confident points for homography — when zoomed too tight, fall back gracefully
6. Team classification on "first 30 seconds" fails because XBotGo zooms on kickoff — use reservoir sampling across the whole match
7. Vercel has no persistent disk — use blob storage for uploaded videos, not local filesystem
8. Player foot position = bottom-center of bounding box, not center — this is the ground contact point for homography
9. Spectators near the touchline can have similar bounding box sizes to players — filter by homography (is the point on the field?) not by size alone
10. Halftime in a continuous video has no timestamp gap — detect it by sustained low motion (>5 min of frame differencing score < threshold)
