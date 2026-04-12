# UI Product Flow: Upload to Replay

**Date:** 2026-04-10  
**Goal:** define the next-phase web app UX for uploading match footage, running calibration-first processing, and presenting trustworthy replay results.

## Product Principles

- Treat processing as a guided workflow, not a single opaque spinner.
- Make calibration quality visible. This pipeline can hard-fail, and the UI should explain why.
- Preserve the uploaded video as the primary source of truth; the tactical replay is the derived analysis.
- Prefer clear status and diagnostics over “magic” UI.
- Optimize for a coach or parent who is not technical.

## Current App Surface

Existing touchpoints already in the repo:

- upload entry: [src/components/video/VideoUploader.tsx](/root/aisoccercoach/src/components/video/VideoUploader.tsx)
- top-level page: [src/app/page.tsx](/root/aisoccercoach/src/app/page.tsx)
- processing poller: [src/components/replay/ProcessingStatus.tsx](/root/aisoccercoach/src/components/replay/ProcessingStatus.tsx)
- replay/result view: [src/components/replay/ReplayView.tsx](/root/aisoccercoach/src/components/replay/ReplayView.tsx)
- process submit route: [src/app/api/process/route.ts](/root/aisoccercoach/src/app/api/process/route.ts)
- status route: [src/app/api/process/status/[jobId]/route.ts](/root/aisoccercoach/src/app/api/process/status/[jobId]/route.ts)
- result route: [src/app/api/process/result/[jobId]/route.ts](/root/aisoccercoach/src/app/api/process/result/[jobId]/route.ts)
- result cache: [src/lib/result-cache.ts](/root/aisoccercoach/src/lib/result-cache.ts)

The current structure is serviceable, but it compresses too many states into two tabs: `Upload` and `Replay`.

## Recommended User Flow

### 1. Upload Screen

Purpose:
- let the user choose a file
- set expectations before upload
- explain supported recording modes

Content:
- primary upload dropzone
- supported formats and recommended capture guidance
- short “best results” note:
  - stable sideline tripod
  - avoid auto zoom if possible
  - keep lines visible
- optional advanced settings later:
  - field template
  - recording mode hint
  - manual calibration mode

Primary action:
- `Upload match video`

Secondary UX:
- show selected file name, duration if available, and upload progress

Implementation target:
- evolve [src/components/video/VideoUploader.tsx](/root/aisoccercoach/src/components/video/VideoUploader.tsx) from a bare dropzone into a first-class upload step

### 2. Job Preparation / Submission State

Purpose:
- bridge the gap between upload completion and background processing

Content:
- file successfully uploaded
- “Starting analysis” state
- explicit note that processing may take several minutes
- cached-result path if prior analysis exists

Implementation target:
- keep orchestration in [src/app/page.tsx](/root/aisoccercoach/src/app/page.tsx)
- add a dedicated client state for:
  - `idle`
  - `uploading`
  - `submitted`
  - `cached-result`
  - `processing`
  - `failed`
  - `complete`

### 3. Processing Dashboard

Purpose:
- replace the current isolated spinner card with a richer “job in progress” screen

Content:
- stage label
- progress bar
- elapsed time
- current analysis step explanation
- optional “what happens next” text
- calibration-specific live counters when available:
  - anchor attempts
  - accepted anchors
  - rejected anchors

Recommended layout:
- left: video thumbnail / uploaded asset summary
- right: processing status card
- below: “analysis pipeline” checklist

Stage grouping:
- `Upload complete`
- `Calibration`
- `Detection & tracking`
- `Team classification`
- `Replay assembly`

Implementation target:
- expand [src/components/replay/ProcessingStatus.tsx](/root/aisoccercoach/src/components/replay/ProcessingStatus.tsx)
- it should render more than a spinner and single label

### 4. Calibration Review Screen

Purpose:
- make calibration pass/fail legible before the user trusts the replay

Two outcomes:

#### Pass
- “Calibration passed”
- coverage
- longest gap
- temporal consistency
- jitter
- preview frames
- note that replay positions are trustworthy enough to display

#### Fail
- failure code
- plain-English failure reason
- preview frames
- suggested next action:
  - try a wider clip
  - avoid zoom
  - ensure field lines are visible

Recommended design:
- use a dedicated calibration summary section before the replay board
- use visual emphasis:
  - green/neutral for pass
  - red/warning for fail

Implementation target:
- extract the calibration UI out of [src/components/replay/ReplayView.tsx](/root/aisoccercoach/src/components/replay/ReplayView.tsx) into a dedicated component such as:
  - `CalibrationSummaryCard`
  - `CalibrationFailurePanel`

### 5. Final Replay Screen

Purpose:
- present the result as a polished analysis workspace

Content:
- source video
- tactical board
- synchronized timeline
- match metadata
- calibration summary
- result stats:
  - number of player tracks
  - ball coverage
  - processing time

Recommended layout:
- top row:
  - left: source video
  - right: tactical replay board
- second row:
  - timeline and playback controls
- third row:
  - calibration quality
  - analysis stats
- bottom:
  - legend and future event/track detail panels

Implementation target:
- keep [src/components/replay/ReplayView.tsx](/root/aisoccercoach/src/components/replay/ReplayView.tsx) as the container
- split out presentational subcomponents so it stops carrying:
  - success state
  - failure state
  - calibration cards
  - legend
  - board/video orchestration
  in one file

## State Model Recommendation

Current state lives mostly in [src/app/page.tsx](/root/aisoccercoach/src/app/page.tsx) and [src/components/replay/ReplayView.tsx](/root/aisoccercoach/src/components/replay/ReplayView.tsx).

Recommended front-end state machine:

- `upload-idle`
- `uploading`
- `uploaded`
- `submitting-job`
- `processing`
- `processing-failed`
- `calibration-failed`
- `result-ready`

Why:
- right now `submitError`, `jobId`, and `cachedResult` are enough to work, but not enough to scale cleanly
- explicit state names will make the next UI layer much easier to reason about

## Error and Recovery UX

### Upload Errors

- invalid file type
- upload failure
- blob/network failure

UX:
- inline message near uploader
- retry without losing the entire page state

### Processing Errors

- status polling failure
- timeout
- Modal job failure

UX:
- error banner in processing dashboard
- preserve uploaded file identity
- offer `Retry analysis`

### Calibration Failures

These should be treated differently from generic server failures.

UX:
- show `failure_code`
- translate it into plain language
- keep preview frames visible
- offer specific remediation copy

### Empty Result Failures

Current behavior already treats “processing completed but no players detected” as a failure in [src/components/replay/ReplayView.tsx](/root/aisoccercoach/src/components/replay/ReplayView.tsx).

Keep that behavior, but make it its own failure panel:
- “Analysis finished, but the replay output was empty”
- include calibration status and detection stats when available

## Recommended Build Order

### Phase 1: Structural UI cleanup

Build first:
- split `ReplayView` into:
  - `ReplayFailureState`
  - `ReplaySuccessState`
  - `CalibrationSummaryCard`
  - `ReplayLegend`
- expand `ProcessingStatus` into a richer dashboard
- move top-level page state toward an explicit workflow state

Why first:
- this reduces UI coupling without changing the backend contract

### Phase 2: Better upload and submission experience

Build next:
- stronger upload screen copy
- file metadata preview
- “best capture practices” guidance
- better cached-result handoff

### Phase 3: Result summary and trust signals

Build next:
- analysis stats panel
- stronger calibration trust indicator
- clearer failure remediation

### Phase 4: Deferred / later

Do later:
- job history
- saved matches library
- manual calibration UI
- jersey-number identity enrichment panels
- tactical event summaries

## Best File Touchpoints

Highest-value insertion points:

- [src/app/page.tsx](/root/aisoccercoach/src/app/page.tsx)
  - turn into explicit upload/process/result workflow controller

- [src/components/video/VideoUploader.tsx](/root/aisoccercoach/src/components/video/VideoUploader.tsx)
  - upgrade from basic uploader to guided entry step

- [src/components/replay/ProcessingStatus.tsx](/root/aisoccercoach/src/components/replay/ProcessingStatus.tsx)
  - evolve into process dashboard

- [src/components/replay/ReplayView.tsx](/root/aisoccercoach/src/components/replay/ReplayView.tsx)
  - split into smaller subcomponents

- [src/types/replay.ts](/root/aisoccercoach/src/types/replay.ts)
  - extend UI-facing metadata types as needed for richer stats and clearer failures

- [src/lib/result-cache.ts](/root/aisoccercoach/src/lib/result-cache.ts)
  - later, likely the basis for a lightweight “recent analyses” experience

## Recommended Immediate Next Step

Implement the UI restructuring first, not a visual redesign from scratch.

Concretely:

1. Create dedicated replay state subcomponents.
2. Replace the current spinner-only processing card with a richer process dashboard.
3. Add a compact result summary panel above or beside the replay board.
4. Keep the backend API shape unchanged while stabilizing the front-end flow.

That gets the app ready for real users without reopening the CV foundation.
