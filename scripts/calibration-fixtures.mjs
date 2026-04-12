#!/usr/bin/env node

import path from 'node:path';

const ROOT = '/root/aisoccercoach';

function fixture(id, label, relativePath, expected = 'pass', processChecks = null) {
  return {
    id,
    label,
    localPath: path.join(ROOT, relativePath),
    relativePath,
    expected,
    processChecks,
  };
}

export const calibrationSuites = {
  smoke: [
    fixture('easy-wide', 'Easy Wide', 'test-clips/02b_easy_wide_midfield_29m55s_30m15s.mp4', 'pass', {
      tracksMin: 1,
      mappedMin: 1,
      ballMin: 1,
    }),
    fixture('kickoff-20s', 'Kickoff 20s', 'test-clips/01b_bootstrap_kickoff_20s_01m50s_02m10s.mp4', 'pass', {
      tracksMin: 1,
      mappedMin: 1,
      ballMin: 1,
    }),
  ],
  core: [
    fixture('easy-wide', 'Easy Wide', 'test-clips/02b_easy_wide_midfield_29m55s_30m15s.mp4', 'pass', {
      tracksMin: 1,
      mappedMin: 1,
      ballMin: 1,
    }),
    fixture('kickoff-20s', 'Kickoff 20s', 'test-clips/01b_bootstrap_kickoff_20s_01m50s_02m10s.mp4', 'pass', {
      tracksMin: 1,
      mappedMin: 1,
      ballMin: 1,
    }),
    fixture('partial-45s', 'Partial Field 45s', 'test-clips/03a_hard_partialfield_short_39m30s_40m15s.mp4', 'pass', {
      tracksMin: 1,
      mappedMin: 1,
      ballMin: 1,
    }),
    fixture('zoom-fail', 'Zoom Fail', 'test-clips/00_fail_zoom_06m55s_07m15s.mp4', 'fail'),
  ],
};

export const processSuites = {
  smoke: [
    fixture('easy-wide', 'Easy Wide', 'test-clips/02b_easy_wide_midfield_29m55s_30m15s.mp4', 'pass'),
    fixture('kickoff-20s', 'Kickoff 20s', 'test-clips/01b_bootstrap_kickoff_20s_01m50s_02m10s.mp4', 'pass'),
  ],
  core: [
    fixture('easy-wide', 'Easy Wide', 'test-clips/02b_easy_wide_midfield_29m55s_30m15s.mp4', 'pass'),
    fixture('kickoff-20s', 'Kickoff 20s', 'test-clips/01b_bootstrap_kickoff_20s_01m50s_02m10s.mp4', 'pass'),
    fixture('partial-45s', 'Partial Field 45s', 'test-clips/03a_hard_partialfield_short_39m30s_40m15s.mp4', 'pass'),
    fixture('zoom-fail', 'Zoom Fail', 'test-clips/00_fail_zoom_06m55s_07m15s.mp4', 'fail'),
  ],
};

export function getCalibrationSuite(name = 'core') {
  const suite = calibrationSuites[name];
  if (!suite) {
    throw new Error(`Unknown calibration suite: ${name}`);
  }
  return suite;
}

export function getProcessSuite(name = 'core') {
  const suite = processSuites[name];
  if (!suite) {
    throw new Error(`Unknown process suite: ${name}`);
  }
  return suite;
}
