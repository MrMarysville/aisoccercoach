# Calibration Working Notes

**Last updated:** 2026-04-10
**Goal:** get automatic PTZ calibration passing on sideline tripod Trace/XbotGo youth soccer footage

## Current Decision

- Stay on `PnLCalib + ECC` path.
- Do not add `SAM 3.1` yet.
- Keep testing on short clips until one passes reliably.
- Stay on `A10G`; `H100` did not materially fix the real bottleneck.

## Camera / Footage Assumptions

- Single sideline PTZ camera
- Elevated tripod, roughly 12-13 ft high
- Trace or XbotGo Falcon style footage
- Youth soccer, downstream tactical board is `9v9`
- Calibration should use a **full 105x68 pitch model first**, then downstream mapping can stay `9v9`

## Test Fixtures

Source full match:

- `trace-1080p.mp4`

Primary clips:

- `test-clips/02a_easy_midfield_short_20m00s_20m20s.mp4`
- `test-clips/02b_easy_wide_midfield_29m55s_30m15s.mp4`
- `test-clips/01a_bootstrap_kickoff_short_01m50s_02m35s.mp4`
- `test-clips/01b_bootstrap_kickoff_20s_01m50s_02m10s.mp4`
- `test-clips/03a_hard_partialfield_short_39m30s_40m15s.mp4`

Reference manifest:

- [test-clips/README.md](/root/aisoccercoach/test-clips/README.md)

## Breakthroughs Already Achieved

1. Bad manual Blob uploads were identified and corrected.
2. The calibration worker now reaches and runs the real calibration stage on uploaded clips.
3. The singular bootstrap failure was reduced by fixing the homography derivation path.
4. The downsampled ECC warp is now converted back into full-resolution pixel coordinates before composition.
5. Calibration scoring now uses a **full-pitch model** instead of the `9v9` board too early.
6. Sideline-specific pitch ROI filtering was added to reduce fence / sky / background contamination.
7. `orientation_valid` was removed as a hard acceptance gate.
8. Visible-only temporal consistency was added.
9. On the best wide-midfield runs, anchors are now accepted repeatedly instead of failing at bootstrap.
10. The downstream projection bug was identified: `PnLCalib` normalized keypoints were being used with full-resolution intrinsics because `FramebyFrameCalib` was created with `denormalize=False`.
11. After switching `FramebyFrameCalib(..., denormalize=True)`, mapped field coordinates became sane and the same wide clip produced real tracks and ball output.
12. Calibration progress reporting now emits on each anchor attempt, not just coarse frame milestones.
13. A local clip uploader script now exists: `pnpm calibration:upload <local_path>`.
14. A reusable calibration benchmark runner now exists: `pnpm calibration:benchmark [suite] [field_template]`.

## Current Code Intent

The current calibration flow should be understood as:

- bootstrap from `PnLCalib`
- propagate between anchors with ECC
- accept anchors on partial-field PTZ views if visibility is reasonable and temporal consistency is not catastrophic
- hard-fail if final coverage is still too low

## Current High-Signal Findings

- `line_iou` is effectively not useful right now; it often sits at `0.0`
- the earlier blocker was bootstrap / singular matrix failures
- the later blocker became temporal consistency on off-screen control points
- after relaxing the temporal gate and fixing ECC composition, wide-midfield runs started accepting anchors consistently
- the old origin-guess bug was not the main cause of empty outputs
- the real empty-output cause was the missing PnLCalib denormalization step
- after the denormalization fix, `mapped_keyframe_total` went from `0` to `2072` and `rejected_offfield_total` dropped to `0` on the primary wide clip

## External Repo Nuggets

- `BroadTrack` reinforces the tripod/camera-motion point: use explicit temporal confidence and reinit logic instead of trusting every frame equally.
- `TVCalib` reinforces that distortion-aware acceptance/scoring matters; plain homography-only thinking is too weak for wide lenses.
- `PnLCalib` and `No-Bells-Just-Whistles` reinforce geometry expansion: richer keypoints / line intersections are worth stealing before replacing the pipeline.
- `Eagle` is the closest public end-to-end soccer analytics repo, but it depends on custom weights and is more useful for workflow ideas than as a drop-in runtime.
- `soccer_tracker` is useful as a cautionary baseline: single-video pose/homography works in principle, but its assumptions are too weak for youth sideline PTZ.

## Best Completed Result So Far

Best completed successful pass:

- `fc-01KNTPZ1XTKMTACQ8JEJNQY6DT`
- clip: `02b_easy_wide_midfield_29m55s_30m15s_denormfix_1775791720946.mp4`
- summary:
  - `status = passed`
  - `accepted_anchor_count = 8`
  - `rejected_anchor_count = 2`
  - `coverage_ratio = 0.802`
  - `longest_gap_seconds = 3.97`
  - `median_landmark_jitter_px = 1.14`
  - `tracks = 32`
  - `ball = 150`
  - `mapped_keyframe_total = 2072`
  - `rejected_offfield_total = 0`

Interpretation:

- the pipeline can calibrate this footage class and produce real replay coordinates
- the hardest blocker is no longer “can calibration work at all?”
- the next phase is validation on broader clips, not proving the same easy wide clip again

## Current Monitoring Rule

- one active Modal run at a time
- `pnpm calibration:watch <call_id>` is the source of truth for live status
- fetch `/result/<call_id>` immediately on completion for the final diagnostics
- do not mix manual polling loops with the watcher
- prefer `pnpm calibration:benchmark --list` and named suites over one-off clip commands when comparing algorithm changes

## Local GPU Workflow

- local `RTX 2070 SUPER` is available and CUDA works
- default iteration path should now be local first
- useful commands:
  - `pnpm calibration:local <video_path> --mode calibration`
  - `pnpm calibration:local <video_path> --mode process`
  - `pnpm calibration:benchmark:local --list`
  - `pnpm calibration:benchmark:local smoke`
- keep Modal for final proof and app-path verification, not day-to-day tuning

## Current Validation Notes

- The `45s` kickoff bootstrap clip is valid for realism but too expensive for fast iteration.
- The `20s` kickoff subset is the preferred kickoff validation loop.
- The `03a` partial-field short clip is uploaded and ready for the next harder validation step.

## Current Tunables That Matter

These are the levers most likely to matter next:

- clip-to-clip validation thresholds
- kickoff / partial-field calibration coverage
- downstream team / ball robustness on clips beyond the easy wide case

These are less important right now:

- GPU tier
- line IoU thresholding
- orientation gate
- homography origin variants

## Do Not Revisit Unless Necessary

- `SAM 3.1` as a calibration component
- `H100` as the primary iteration GPU
- `modal run` as the main benchmarking method
- manual calibration / user-click fallback

## Next Actions When Resuming

1. Validate the same build on the kickoff/bootstrap clip.
2. Validate the same build on the hard partial-field clip.
3. Compare calibration coverage, mapped keyframes, tracks, and ball output across clips.
4. Only after the broader clip set is healthy, move to improving replay quality rather than calibration survival.
