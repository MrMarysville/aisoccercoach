#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function usage() {
  console.error('Usage: node scripts/watch-local-status.mjs <status-file> [output-file]');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function summarizeOutput(output) {
  const calibration = output?.calibration ?? output?.metadata?.calibration ?? null;
  const tracks = Array.isArray(output?.tracks) ? output.tracks.length : 0;
  const ball = Array.isArray(output?.ball) ? output.ball.length : 0;
  return {
    calibration_status: calibration?.status ?? null,
    failure_code: output?.failure_code ?? calibration?.failure_code ?? null,
    coverage_ratio: calibration?.coverage_ratio ?? null,
    accepted_anchor_count: calibration?.accepted_anchor_count ?? null,
    rejected_anchor_count: calibration?.rejected_anchor_count ?? null,
    longest_internal_gap_seconds: calibration?.longest_internal_gap_seconds ?? null,
    invalid_reason_counts: calibration?.invalid_reason_counts ?? null,
    tracks,
    ball,
  };
}

async function main() {
  const statusArg = process.argv[2];
  const outputArg = process.argv[3];
  if (!statusArg) usage();

  const statusPath = path.resolve(statusArg);
  const outputPath = outputArg ? path.resolve(outputArg) : statusPath.replace(/\.status\.json$/, '');
  let lastLine = null;

  for (;;) {
    const status = readJsonIfExists(statusPath);
    if (status) {
      const line = JSON.stringify(status);
      if (line !== lastLine) {
        console.log(`[local-watch] ${line}`);
        lastLine = line;
      }
      if (status.status === 'complete' || status.status === 'failed') {
        const output = readJsonIfExists(outputPath);
        if (output) {
          console.log(`[local-watch-final] ${JSON.stringify(summarizeOutput(output))}`);
        }
        return;
      }
    }

    const output = readJsonIfExists(outputPath);
    if (output && (output.failure_code || output.calibration || output.metadata)) {
      console.log(`[local-watch-final] ${JSON.stringify(summarizeOutput(output))}`);
      return;
    }

    await sleep(5000);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
