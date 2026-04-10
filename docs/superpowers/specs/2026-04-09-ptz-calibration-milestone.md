# PTZ Calibration Milestone

**Date:** 2026-04-09
**Status:** Proposed
**Priority:** Highest
**Applies to:** `9v9` youth match replay pipeline on sideline tripod PTZ footage
**Supersedes:** The fallback-heavy calibration behavior in [2026-04-07-video-to-tactical-replay-design.md](./2026-04-07-video-to-tactical-replay-design.md)

## Decision

Build the automatic PTZ field-registration stage first and make it a hard gate for the rest of the pipeline.

No replay JSON is emitted unless calibration passes. There is no normalized-pixel fallback, no frontend low-confidence mode, and no manual calibration path in this milestone.

## Why This Is First

If the pixel-to-field homography is wrong, then:

- player trajectories are wrong even if tracking is perfect
- team labels are attached to the wrong field trajectories
- ball coordinates are meaningless
- the replay can look plausible while being false

The calibration stage is therefore the correctness bottleneck.

## Milestone Goal

Given a single uploaded video, produce either:

1. a per-frame homography timeline with enough confidence to support replay, plus calibration diagnostics, or
2. a hard failure with a machine-readable error code and a debug artifact explaining why calibration was rejected.

This milestone does not need player tracking, team segmentation, or ball tracking to be considered successful.

## Non-Goals

- player detection or tracking
- team segmentation
- ball detection
- replay UI polish
- manual correction workflows
- support for field templates other than `9v9`

## Input Contract

### Function Input

```python
video_url: str
field_template: Literal["9v9"]
```

### Assumptions

- source video is sideline footage from an elevated tripod
- camera is PTZ and may pan, tilt, and zoom during play
- the field may be partially visible for long stretches
- the pitch is a planar surface

## Output Contract

Create a calibration-only result type first, then make `process_video()` depend on it.

### `CalibrationResult`

```json
{
  "metadata": {
    "video_id": "match-123",
    "fps": 30.0,
    "duration": 4521.8,
    "frame_count": 135654,
    "field_template": "9v9",
    "sampled_keyframe_interval_frames": 15,
    "anchor_interval_frames": 15
  },
  "summary": {
    "status": "passed",
    "failure_code": null,
    "accepted_anchor_count": 618,
    "rejected_anchor_count": 144,
    "coverage_ratio": 0.93,
    "longest_gap_seconds": 1.4,
    "median_anchor_line_iou": 0.28,
    "median_temporal_consistency_px": 18.7,
    "max_temporal_consistency_px": 64.1,
    "median_landmark_jitter_px": 7.3,
    "debug_artifact_path": "/tmp/calibration_debug.mp4"
  },
  "frames": [
    {
      "frame": 0,
      "time": 0.0,
      "valid": true,
      "source": "anchor_pnl",
      "confidence": 0.93,
      "anchor_age_frames": 0,
      "line_iou": 0.31,
      "temporal_consistency_px": 0.0,
      "landmark_jitter_px": 0.0,
      "homography": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    }
  ]
}
```

### Failure Example

```json
{
  "summary": {
    "status": "failed",
    "failure_code": "CALIBRATION_BOOTSTRAP_FAILED",
    "failure_message": "No valid field anchor found in first 15 seconds",
    "debug_artifact_path": "/tmp/calibration_debug.mp4"
  }
}
```

## Failure Codes

- `CALIBRATION_PNLCALIB_UNAVAILABLE`
- `CALIBRATION_BOOTSTRAP_FAILED`
- `CALIBRATION_COVERAGE_TOO_LOW`
- `CALIBRATION_GAP_TOO_LONG`
- `CALIBRATION_ANCHOR_SCORE_TOO_LOW`
- `CALIBRATION_TEMPORAL_INCONSISTENT`
- `CALIBRATION_ORIENTATION_INVALID`
- `CALIBRATION_DEBUG_RENDER_FAILED`

## Canonical Field Model

Use a single canonical `9v9` field definition for both frontend rendering and calibration logic.

Current frontend constants live in [field-renderer.ts](/root/aisoccercoach/src/lib/replay/field-renderer.ts).

For this milestone:

- keep the dimensions `55m x 36m`
- define a Python-side canonical field graph with named control points and line segments
- use the same graph for:
  - projecting template overlays into video
  - scoring anchor candidates
  - temporal consistency checks

### Minimum Control Points

Use at least these named field points:

- `corner_tl`, `corner_tr`, `corner_bl`, `corner_br`
- `halfway_top`, `halfway_bottom`
- `penalty_left`, `penalty_right`
- `left_box_top`, `left_box_bottom`
- `right_box_top`, `right_box_bottom`

These are not assumed to be visible in every frame. They are only used as canonical probes for scoring and jitter checks.

## Calibration Algorithm

### 1. Decode and Normalize

- transcode once to H.264
- strip audio
- keep original frame size for anchor calibration
- create a grayscale downsample for motion estimation

### 2. Build Field Evidence Per Sampled Frame

Every `15` frames (`0.5s` at `30fps`):

- compute a grass/pitch mask from HSV
- compute a white-line candidate mask
- optionally apply CLAHE to help line extraction in low contrast

The line mask is used only for anchor scoring and debug overlays. It is not the primary homography solver.

### 3. Anchor Homography From PnLCalib

Every sampled frame:

- run `PnLCalib`
- derive `H_field_to_pixel`
- invert to obtain `H_pixel_to_field`
- reject immediately if:
  - matrix is singular or nearly singular
  - projected field polygon is mirrored or upside down
  - too little of the projected template is inside the frame

### 4. Anchor Validation

Every candidate anchor is scored independently before acceptance.

#### Anchor Metrics

- `line_iou`
  - rasterize projected field lines into image space
  - compute overlap against the white-line mask
- `visible_template_ratio`
  - fraction of projected template line pixels that land inside the frame
- `temporal_consistency_px`
  - compare the candidate anchor against the previous accepted anchor propagated forward by ECC
  - project the canonical control points into image space under both transforms
  - compute median pixel error
- `orientation_valid`
  - reject mirrored or impossible field orientation

#### Anchor Acceptance Thresholds

Accept an anchor only if all are true:

- `line_iou >= 0.18`
- `visible_template_ratio >= 0.12`
- `temporal_consistency_px <= 80`
- `orientation_valid == True`

If there is no previous accepted anchor yet, skip the temporal consistency check and rely on line overlap + orientation + visibility.

### 5. Between-Anchor Propagation

For every consecutive frame:

- run `cv2.findTransformECC(..., MOTION_HOMOGRAPHY, ...)`
- compute `H_prev_to_curr`
- accumulate motion from the last accepted anchor to the current frame
- derive the current frame homography as:

```python
H_pixel_to_field[current] = H_anchor_pixel_to_field @ inv(H_anchor_to_current_pixel)
```

Only propagate from the most recent accepted anchor. Never propagate indefinitely without a fresh anchor.

### 6. Frame Validity

A frame is valid if:

- there is a previously accepted anchor
- the anchor age is `<= 60` frames (`2s`)
- accumulated ECC did not fail catastrophically
- temporal landmark jitter remains below threshold

Otherwise the frame is invalid.

### 7. Hard-Fail Summary

The calibration pass fails if any of these are true:

- no accepted anchor appears in first `15s`
- valid-frame coverage ratio is `< 0.85`
- longest invalid gap is `> 2.0s`
- median accepted-anchor `line_iou < 0.22`
- median landmark jitter on valid frames is `> 12px`
- max temporal consistency on accepted anchors is `> 120px`

## Important Distinction: Runtime Gates vs Offline Benchmarks

The hard-fail gates above are runtime self-consistency checks. They do not require human-labeled ground truth.

For offline evaluation on labeled clips, also track:

- median field-coordinate error in meters
- 95th percentile field-coordinate error in meters

Target offline benchmark:

- median position error `<= 1.5m`
- 95th percentile position error `<= 3.0m`

These offline metrics are acceptance goals for the milestone, not runtime gating logic.

## Required Debug Artifact

Produce a calibration debug video for every job, pass or fail.

Each frame should show:

- projected field template lines
- anchor source label: `anchor_pnl` or `propagated_ecc`
- confidence score
- anchor age in frames
- current fail reason if invalid

This artifact is required because calibration errors are easiest to diagnose visually.

## `modal_app.py` Refactor Plan

Do not patch around the current `process_video()` flow. Split the calibration logic into explicit units.

### New Functions

- `_load_calibration_models()`
- `_extract_field_evidence(frame_bgr) -> FieldEvidence`
- `_run_pnl_anchor(frame_bgr) -> AnchorCandidate | None`
- `_score_anchor_candidate(candidate, evidence, prev_valid_H) -> AnchorScore`
- `_estimate_ecc_warp(prev_gray, curr_gray, mask=None) -> np.ndarray`
- `_propagate_homography(anchor_H, accumulated_ecc) -> np.ndarray | None`
- `_render_calibration_debug_video(...) -> str`
- `_summarize_calibration(frame_states) -> CalibrationSummary`
- `run_calibration_stage(video_url, field_template) -> CalibrationResult`

### Existing Code To Remove or Change

#### Remove

- normalized pixel fallback in [modal_app.py:691](/root/aisoccercoach/modal_app.py#L691)
- normalized pixel fallback in [modal_app.py:720](/root/aisoccercoach/modal_app.py#L720)
- low-confidence carry-forward semantics as a product behavior

#### Replace

- the boolean `frame_confidence` map with a richer per-frame calibration state object
- `last_good_H` semantics with strict validity windows and explicit anchor age

### Initial Integration Strategy

1. Add `run_calibration_stage()`
2. Expose it via a temporary Modal function for calibration-only testing
3. Make `process_video()` call `run_calibration_stage()` first
4. Abort the whole job if calibration fails
5. Only after that, wire player detection to consume valid frame homographies

## Python Data Structures

Use dataclasses or `TypedDict`, not loose dicts.

```python
class FieldEvidence(TypedDict):
    grass_mask: np.ndarray
    line_mask: np.ndarray

class AnchorCandidate(TypedDict):
    frame: int
    time: float
    homography: np.ndarray

class FrameCalibrationState(TypedDict):
    frame: int
    time: float
    valid: bool
    source: str
    confidence: float
    anchor_age_frames: int
    line_iou: float | None
    visible_template_ratio: float | None
    temporal_consistency_px: float | None
    landmark_jitter_px: float | None
    fail_reason: str | None
    homography: np.ndarray | None
```

## Progress Reporting

Use more precise status stages during this milestone:

- `transcoding`
- `field_evidence`
- `field_calibration`
- `camera_motion`
- `calibration_validation`
- `calibration_debug`
- `failed`
- `complete`

Add these fields to progress payloads where useful:

- `accepted_anchor_count`
- `coverage_ratio`
- `longest_gap_seconds`
- `failure_code`

## Tests

### Unit Tests

- ECC on identical frames returns near-identity
- ECC on synthetic transforms returns expected warp
- anchor scoring rejects mirrored homographies
- anchor scoring rejects low line overlap
- propagation invalidates frames after `2s` without anchor refresh
- summary hard-fails on low coverage

### Integration Tests

Use short real clips outside the repo and assert:

- bootstrap succeeds on easy midfield clip
- bootstrap fails on a clip with no visible field in first `15s`
- debug artifact is produced on both pass and fail

### Human Review

For each test clip, inspect the debug video and confirm:

- field lines stay glued to the source footage
- no sudden field flips
- no long drift after zooms or fast pans

## Acceptance Criteria

This milestone is done when all are true:

- calibration can run end-to-end without entering the detection stages
- successful clips produce stable field overlays
- invalid clips fail early with explicit error codes
- no normalized-pixel fallback remains in the production path
- `process_video()` is blocked on calibration success

## Next Milestone After This

Once calibration is accepted, the next build step is:

- `YOLO26L-pose + BoT-SORT/ReID` for players

That stage should consume only valid calibrated frames. It must not be allowed to invent tactical coordinates when calibration has failed.
