#!/usr/bin/env node

import {
  formatStatusLine,
  loadEnvFileIfPresent,
  printFinalSummary,
  sleep,
  summarizeCalibration,
} from './calibration-utils.mjs';

function usage() {
  console.error('Usage: node scripts/poll-calibration.mjs <video_url> [field_template]');
  process.exit(1);
}

async function main() {
  loadEnvFileIfPresent();

  const videoUrl = process.argv[2];
  const fieldTemplate = process.argv[3] ?? '9v9';
  const endpoint = process.env.MODAL_ENDPOINT;

  if (!videoUrl) usage();
  if (!endpoint) {
    console.error('MODAL_ENDPOINT is not set');
    process.exit(1);
  }

  const submitResponse = await fetch(`${endpoint}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_url: videoUrl, field_template: fieldTemplate }),
  });

  if (!submitResponse.ok) {
    console.error(`Submit failed: ${submitResponse.status}`);
    console.error(await submitResponse.text());
    process.exit(1);
  }

  const { call_id: callId } = await submitResponse.json();
  console.log(`call_id=${callId}`);

  for (;;) {
    const statusResponse = await fetch(`${endpoint}/status/${callId}`);
    const status = await statusResponse.json();

    if (!statusResponse.ok) {
      console.error(`[${new Date().toISOString()}] status error`, status);
      process.exit(1);
    }

    console.log(formatStatusLine(status));

    if (status.status === 'failed') {
      console.log('FAILED');
      if (status.failure_code) console.log(`failure_code=${status.failure_code}`);
      if (status.error) console.log(`error=${status.error}`);
      console.log(summarizeCalibration(status.calibration));
      process.exit(2);
    }

    if (status.status === 'complete') {
      const resultResponse = await fetch(`${endpoint}/result/${callId}`);
      const result = await resultResponse.json();
      if (!resultResponse.ok) {
        console.error('Failed to fetch final result', result);
        process.exit(1);
      }

      const calibration = result.calibration ?? result.metadata?.calibration;
      console.log('COMPLETE');
      printFinalSummary({ ...result, calibration });
      process.exit(0);
    }

    await sleep(5000);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
