#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function usage() {
  console.error('Usage: node scripts/compare-calibration-results.mjs <result.json> <result.json> [...]');
  process.exit(1);
}

function formatMetric(value, fallback = '-') {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  return String(value);
}

function summarize(filePath) {
  const fullPath = path.resolve(filePath);
  const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const metadata = data.metadata ?? {};
  const calibration = data.calibration ?? metadata.calibration ?? {};
  const debugCounts = metadata.debug_counts ?? {};

  return {
    file: path.basename(fullPath),
    status: calibration.status ?? 'unknown',
    failure: calibration.failure_code ?? data.failure_code ?? '',
    coverage: calibration.coverage_ratio,
    anchors: `${(calibration.accepted_anchor_count ?? 0)}/${(calibration.accepted_anchor_count ?? 0) + (calibration.rejected_anchor_count ?? 0)}`,
    gap_s: calibration.longest_gap_seconds,
    internal_gap_s: calibration.longest_internal_gap_seconds,
    tracks: Array.isArray(data.tracks) ? data.tracks.length : 0,
    ball: Array.isArray(data.ball) ? data.ball.length : 0,
    mapped: debugCounts.mapped_keyframe_total,
    offField: debugCounts.rejected_offfield_total,
    fieldFiltered: debugCounts.field_filtered_detection_total,
    raw: debugCounts.raw_detection_total,
    runtime_s: metadata.processing_time_seconds,
  };
}

function printTable(rows) {
  const columns = [
    ['file', 'File'],
    ['status', 'Status'],
    ['failure', 'Failure'],
    ['coverage', 'Coverage'],
    ['anchors', 'Anchors'],
    ['gap_s', 'Gap(s)'],
    ['internal_gap_s', 'InternalGap'],
    ['tracks', 'Tracks'],
    ['ball', 'Ball'],
    ['mapped', 'Mapped'],
    ['offField', 'OffField'],
    ['fieldFiltered', 'FieldFilt'],
    ['raw', 'RawDet'],
    ['runtime_s', 'Run(s)'],
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

function main() {
  const files = process.argv.slice(2);
  if (files.length < 1) usage();
  const rows = files.map(summarize);
  printTable(rows);
}

main();
