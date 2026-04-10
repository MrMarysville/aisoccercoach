#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadEnvFileIfPresent } from './calibration-utils.mjs';
import { calibrationSuites, getCalibrationSuite } from './calibration-fixtures.mjs';

function usage() {
  console.error(
    'Usage: node scripts/run-local-calibration-benchmark.mjs [suite] [field_template]\n' +
    '       node scripts/run-local-calibration-benchmark.mjs --list\n' +
    '  suite: smoke | core (default: core)\n' +
    '  field_template: 9v9 | 11v11 (default: 9v9)'
  );
  process.exit(1);
}

function stripCalibration(calibration) {
  if (!calibration) return null;
  const rest = { ...calibration };
  delete rest.preview_frames;
  return rest;
}

function summarizeLocalResult(result) {
  const metadata = result?.metadata ?? {};
  const calibration = stripCalibration(result?.calibration ?? metadata.calibration);
  return {
    calibration,
    tracksLen: Array.isArray(result?.tracks) ? result.tracks.length : 0,
    ballLen: Array.isArray(result?.ball) ? result.ball.length : 0,
    debugCounts: metadata.debug_counts ?? null,
    debugProjection: metadata.debug_projection ?? null,
    runtimeSeconds: metadata.processing_time_seconds ?? null,
  };
}

function formatMetric(value, fallback = '-') {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  return String(value);
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
      widths[key] = Math.max(widths[key], formatMetric(row[key]).length);
    }
  }
  const header = columns.map(([key, label]) => label.padEnd(widths[key])).join('  ');
  const divider = columns.map(([key]) => '-'.repeat(widths[key])).join('  ');
  console.log(header);
  console.log(divider);
  for (const row of rows) {
    console.log(columns.map(([key]) => formatMetric(row[key]).padEnd(widths[key])).join('  '));
  }
}

async function runLocalFixture(fixture, fieldTemplate) {
  const repoRoot = '/root/aisoccercoach';
  const pythonBin = path.join(repoRoot, '.venv-local', 'bin', 'python');
  const outputDir = path.join(repoRoot, 'benchmark-results', 'local-calibration', 'artifacts');
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, `${fixture.id}.json`);

  console.log(`\n== ${fixture.label} (${fixture.id}) ==`);
  console.log(`local=${fixture.relativePath}`);

  let exitCode = null;
  await new Promise((resolve, reject) => {
    const child = spawn(
      pythonBin,
      [
        path.join(repoRoot, 'scripts', 'run-local-process.py'),
        fixture.localPath,
        '--mode', 'calibration',
        '--field-template', fieldTemplate,
        '--output', outputPath,
      ],
      {
        cwd: repoRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      exitCode = code ?? 1;
      if (exitCode === 0 || exitCode === 2) resolve();
      else reject(new Error(`Local fixture ${fixture.id} failed with exit code ${exitCode}`));
    });
  });

  if (!fs.existsSync(outputPath)) {
    throw new Error(`Local fixture ${fixture.id} did not write output at ${outputPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  const summary = summarizeLocalResult(parsed);
  const record = {
    id: fixture.id,
    label: fixture.label,
    expected: fixture.expected,
    local_path: fixture.relativePath,
    status: summary.calibration?.status ?? 'unknown',
    failure_code: summary.calibration?.failure_code ?? null,
    failure_message: summary.calibration?.failure_message ?? null,
    coverage_ratio: summary.calibration?.coverage_ratio ?? null,
    accepted_anchor_count: summary.calibration?.accepted_anchor_count ?? 0,
    rejected_anchor_count: summary.calibration?.rejected_anchor_count ?? 0,
    anchor_attempts:
      (summary.calibration?.accepted_anchor_count ?? 0) +
      (summary.calibration?.rejected_anchor_count ?? 0),
    longest_gap_seconds: summary.calibration?.longest_gap_seconds ?? null,
    longest_internal_gap_seconds: summary.calibration?.longest_internal_gap_seconds ?? null,
    median_temporal_consistency_px: summary.calibration?.median_temporal_consistency_px ?? null,
    max_temporal_consistency_px: summary.calibration?.max_temporal_consistency_px ?? null,
    median_landmark_jitter_px: summary.calibration?.median_landmark_jitter_px ?? null,
    invalid_reason_counts: summary.calibration?.invalid_reason_counts ?? {},
    runtime_seconds: summary.runtimeSeconds,
    tracks: summary.tracksLen,
    ball: summary.ballLen,
    raw_detection_total: summary.debugCounts?.raw_detection_total ?? 0,
    filtered_detection_total: summary.debugCounts?.filtered_detection_total ?? 0,
    field_filtered_detection_total: summary.debugCounts?.field_filtered_detection_total ?? 0,
    tracker_output_total: summary.debugCounts?.tracker_output_total ?? 0,
    mapped_keyframe_total: summary.debugCounts?.mapped_keyframe_total ?? 0,
    rejected_offfield_total: summary.debugCounts?.rejected_offfield_total ?? 0,
    reused_homography_total: summary.debugCounts?.reused_homography_total ?? 0,
    calibration_summary: summary.calibration,
    debug_projection: summary.debugProjection,
    artifact_path: path.relative(repoRoot, outputPath),
    local_exit_code: exitCode,
  };

  console.log(`fixture_status=${record.status} coverage=${record.coverage_ratio} tracks=${record.tracks} ball=${record.ball}`);
  if (Object.keys(record.invalid_reason_counts).length > 0) {
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
    records.push(await runLocalFixture(fixture, fieldTemplate));
  }

  const outDir = path.join(process.cwd(), 'benchmark-results', 'local-calibration');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `${startedAt.toISOString().replace(/[:]/g, '-').replace(/\..+/, '')}_${suiteName}.json`
  );
  const report = {
    suite: suiteName,
    field_template: fieldTemplate,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    records,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('\n== Summary ==');
  printTable(records);
  console.log(`\nreport=${outPath}`);

  const failedExpectations = records.filter((record) => {
    if (record.expected === 'fail') return record.status !== 'failed';
    return record.status !== 'passed';
  });
  if (failedExpectations.length > 0) process.exit(2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
