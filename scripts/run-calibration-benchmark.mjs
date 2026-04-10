#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  extractFinalSummary,
  formatStatusLine,
  loadEnvFileIfPresent,
  submitCalibration,
  summarizeCalibration,
  uploadClip,
  waitForCallCompletion,
} from './calibration-utils.mjs';
import { calibrationSuites, getCalibrationSuite } from './calibration-fixtures.mjs';

function usage() {
  console.error(
    'Usage: node scripts/run-calibration-benchmark.mjs [suite] [field_template]\n' +
    '       node scripts/run-calibration-benchmark.mjs --list\n' +
    '  suite: smoke | core (default: core)\n' +
    '  field_template: 9v9 | 11v11 (default: 9v9)'
  );
  process.exit(1);
}

function formatMetric(value, fallback = '-') {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  if (typeof value === 'number') return String(value);
  return value;
}

function stripCalibration(calibration) {
  if (!calibration) return null;
  const rest = { ...calibration };
  delete rest.preview_frames;
  return rest;
}

function buildRow(record) {
  return {
    id: record.id,
    expected: record.expected,
    status: record.status,
    coverage: record.coverage_ratio,
    anchors: `${record.accepted_anchor_count}/${record.anchor_attempts}`,
    gap_s: record.longest_gap_seconds,
    internal_gap_s: record.longest_internal_gap_seconds,
    tracks: record.tracks,
    ball: record.ball,
    mapped: record.mapped_keyframe_total,
    offfield: record.rejected_offfield_total,
    runtime_s: record.runtime_seconds,
    failure: record.failure_code ?? '',
  };
}

function printTable(records) {
  const rows = records.map(buildRow);
  const columns = [
    ['id', 'Fixture'],
    ['expected', 'Expect'],
    ['status', 'Status'],
    ['coverage', 'Coverage'],
    ['anchors', 'Anchors'],
    ['gap_s', 'Gap(s)'],
    ['internal_gap_s', 'InternalGap'],
    ['tracks', 'Tracks'],
    ['ball', 'Ball'],
    ['mapped', 'Mapped'],
    ['offfield', 'OffField'],
    ['runtime_s', 'Run(s)'],
    ['failure', 'Failure'],
  ];

  const widths = Object.fromEntries(columns.map(([key, label]) => [key, label.length]));
  for (const row of rows) {
    for (const [key] of columns) {
      widths[key] = Math.max(widths[key], String(formatMetric(row[key])).length);
    }
  }

  const header = columns
    .map(([key, label]) => label.padEnd(widths[key]))
    .join('  ');
  const divider = columns
    .map(([key]) => '-'.repeat(widths[key]))
    .join('  ');
  console.log(header);
  console.log(divider);
  for (const row of rows) {
    console.log(
      columns
        .map(([key]) => String(formatMetric(row[key])).padEnd(widths[key]))
        .join('  ')
    );
  }
}

async function runFixture(fixture, fieldTemplate) {
  console.log(`\n== ${fixture.label} (${fixture.id}) ==`);
  console.log(`local=${fixture.relativePath}`);
  const uploadStart = Date.now();
  const upload = await uploadClip(fixture.localPath);
  const uploadSeconds = ((Date.now() - uploadStart) / 1000).toFixed(1);
  console.log(`uploaded=${upload.url}`);
  console.log(`upload_s=${uploadSeconds}`);

  const callId = await submitCalibration(upload.url, fieldTemplate);
  console.log(`call_id=${callId}`);

  let lastStatusLine = null;
  const runStart = Date.now();
  const completion = await waitForCallCompletion(callId, {
    pollMs: 5000,
    onStatus(status) {
      const line = formatStatusLine(status);
      if (line !== lastStatusLine) {
        console.log(line);
        lastStatusLine = line;
      }
    },
  });
  const runtimeSeconds = Number(((Date.now() - runStart) / 1000).toFixed(1));

  const calibration = stripCalibration(
    completion.ok
      ? extractFinalSummary(completion.result).calibration
      : completion.status.calibration
  );
  const summary = completion.ok ? extractFinalSummary(completion.result) : null;

  const record = {
    id: fixture.id,
    label: fixture.label,
    expected: fixture.expected,
    local_path: fixture.relativePath,
    uploaded_url: upload.url,
    call_id: callId,
    status: calibration?.status ?? completion.status.status ?? 'unknown',
    failure_code: calibration?.failure_code ?? completion.status.failure_code ?? null,
    failure_message: calibration?.failure_message ?? completion.status.error ?? null,
    coverage_ratio: calibration?.coverage_ratio ?? null,
    accepted_anchor_count: calibration?.accepted_anchor_count ?? 0,
    rejected_anchor_count: calibration?.rejected_anchor_count ?? 0,
    anchor_attempts: (calibration?.accepted_anchor_count ?? 0) + (calibration?.rejected_anchor_count ?? 0),
    longest_gap_seconds: calibration?.longest_gap_seconds ?? null,
    longest_internal_gap_seconds: calibration?.longest_internal_gap_seconds ?? null,
    median_temporal_consistency_px: calibration?.median_temporal_consistency_px ?? null,
    max_temporal_consistency_px: calibration?.max_temporal_consistency_px ?? null,
    median_landmark_jitter_px: calibration?.median_landmark_jitter_px ?? null,
    invalid_reason_counts: calibration?.invalid_reason_counts ?? {},
    runtime_seconds: runtimeSeconds,
    tracks: summary?.tracksLen ?? 0,
    ball: summary?.ballLen ?? 0,
    raw_detection_total: summary?.debugCounts?.raw_detection_total ?? 0,
    filtered_detection_total: summary?.debugCounts?.filtered_detection_total ?? 0,
    field_filtered_detection_total: summary?.debugCounts?.field_filtered_detection_total ?? 0,
    tracker_output_total: summary?.debugCounts?.tracker_output_total ?? 0,
    mapped_keyframe_total: summary?.debugCounts?.mapped_keyframe_total ?? 0,
    rejected_offfield_total: summary?.debugCounts?.rejected_offfield_total ?? 0,
    reused_homography_total: summary?.debugCounts?.reused_homography_total ?? 0,
    calibration_summary: calibration,
    debug_projection: summary?.debugProjection ?? null,
  };

  console.log(completion.ok ? 'COMPLETE' : 'FAILED');
  console.log(summarizeCalibration(calibration));
  console.log(`tracks=${record.tracks} ball=${record.ball}`);
  if (record.invalid_reason_counts && Object.keys(record.invalid_reason_counts).length > 0) {
    console.log(`invalid_reason_counts=${JSON.stringify(record.invalid_reason_counts)}`);
  }

  return record;
}

async function main() {
  loadEnvFileIfPresent();

  if (process.argv.includes('--list')) {
    for (const [suiteName, fixtures] of Object.entries(calibrationSuites)) {
      console.log(`\n${suiteName}`);
      for (const fixture of fixtures) {
        console.log(`- ${fixture.id} :: ${fixture.relativePath} (${fixture.expected})`);
      }
    }
    return;
  }

  const suiteName = process.argv[2] ?? 'core';
  const fieldTemplate = process.argv[3] ?? '9v9';
  if (!['9v9', '11v11'].includes(fieldTemplate)) usage();

  const fixtures = getCalibrationSuite(suiteName);
  const startedAt = new Date();
  const records = [];

  for (const fixture of fixtures) {
    const record = await runFixture(fixture, fieldTemplate);
    records.push(record);
  }

  const finishedAt = new Date();
  const report = {
    suite: suiteName,
    field_template: fieldTemplate,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    records,
  };

  const outDir = path.join(process.cwd(), 'benchmark-results', 'calibration');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `${startedAt.toISOString().replace(/[:]/g, '-').replace(/\..+/, '')}_${suiteName}.json`
  );
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('\n== Summary ==');
  printTable(records);
  console.log(`\nreport=${outPath}`);

  const failedExpectations = records.filter((record) => {
    if (record.expected === 'fail') return record.status !== 'failed';
    return record.status !== 'passed';
  });
  if (failedExpectations.length > 0) {
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
