# Calibration Test Clips

Source file: `trace-1080p.mp4`

Observed from sampled frames:

- pregame / lineup from `00:00` to about `00:01:30`
- live play begins around `00:02:00`
- useful game footage continues well past `00:50:00`

## Clip Order

### `00_fail_zoom_06m55s_07m15s.mp4`

- Duration: `20.02s`
- Purpose: intentional hard-fail calibration test
- Why: the camera is tightly zoomed with very limited field geometry visible; the first 15 seconds should be difficult to bootstrap from reliably

### `01_bootstrap_kickoff_01m50s_03m50s.mp4`

- Duration: `120.02s`
- Purpose: bootstrap test
- Why: spans the transition from pregame setup into live play and should prove whether calibration can lock on as the match starts

### `02_easy_midfield_19m45s_21m15s.mp4`

- Duration: `90.02s`
- Purpose: easy positive control
- Why: midfield view with visible center line / circle and broad field coverage; this should pass if the calibration stage is healthy

### `03_hard_partialfield_39m30s_41m00s.mp4`

- Duration: `90.02s`
- Purpose: hard positive / stress test
- Why: partial-field PTZ view with aggressive crop; useful for checking drift, anchor refresh, and gap handling

### `04_lategame_46m30s_48m00s.mp4`

- Duration: `90.02s`
- Purpose: late-game validation
- Why: verifies the same calibration logic on a later match segment with different framing and player density

## Recommended Test Order

1. `02_easy_midfield_19m45s_21m15s.mp4`
2. `01_bootstrap_kickoff_01m50s_03m50s.mp4`
3. `03_hard_partialfield_39m30s_41m00s.mp4`
4. `04_lategame_46m30s_48m00s.mp4`
5. `00_fail_zoom_06m55s_07m15s.mp4`

## Expected Outcome

- Clips `01`-`04` should ideally pass calibration.
- Clip `00` is expected to fail or come very close to failing and is included to verify the hard-fail path.
