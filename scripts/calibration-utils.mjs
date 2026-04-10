#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { put } from '@vercel/blob';

export function loadEnvFileIfPresent() {
  const envPath = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx);
    let value = trimmed.slice(idx + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getModalEndpoint() {
  const endpoint = process.env.MODAL_ENDPOINT;
  if (!endpoint) {
    throw new Error('MODAL_ENDPOINT is not set');
  }
  return endpoint;
}

export function summarizeCalibration(calibration) {
  if (!calibration) return 'No calibration summary present';

  const parts = [
    `status=${calibration.status}`,
    `coverage=${calibration.coverage_ratio}`,
    `anchors=${calibration.accepted_anchor_count}/${calibration.accepted_anchor_count + calibration.rejected_anchor_count}`,
    `gap=${calibration.longest_gap_seconds}s`,
    `jitter=${calibration.median_landmark_jitter_px ?? 'n/a'}px`,
  ];

  if (calibration.failure_code) parts.push(`failure=${calibration.failure_code}`);
  return parts.join(' ');
}

export function formatStatusLine(status) {
  const timestamp = new Date().toISOString();
  const extras = [];
  if (typeof status.current_frame === 'number' && typeof status.total_frames === 'number') {
    extras.push(`frame=${status.current_frame}/${status.total_frames}`);
  }
  if (typeof status.anchor_attempts === 'number') {
    extras.push(`anchors=${status.anchor_accepted ?? 0}/${status.anchor_attempts}`);
  }
  if (typeof status.avg_anchor_ms === 'number') {
    extras.push(`avg_anchor_ms=${status.avg_anchor_ms}`);
  }
  return `[${timestamp}] ${status.stage ?? 'unknown'} ${status.percent ?? '?'}% ${extras.join(' ')}`.trim();
}

export async function uploadClip(localPath, remotePrefix = 'clips') {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new Error('BLOB_READ_WRITE_TOKEN is not set');
  }

  const data = fs.readFileSync(localPath);
  const ext = path.extname(localPath) || '.mp4';
  const base = path.basename(localPath, ext).replace(/[^a-zA-Z0-9._-]/g, '_');
  const remoteName = `${remotePrefix}/${base}_${Date.now()}${ext}`;

  return put(remoteName, data, {
    access: 'public',
    token,
    addRandomSuffix: false,
    contentType: 'video/mp4',
  });
}

export async function submitCalibration(videoUrl, fieldTemplate = '9v9') {
  const endpoint = getModalEndpoint();
  const submitResponse = await fetch(`${endpoint}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_url: videoUrl, field_template: fieldTemplate }),
  });

  if (!submitResponse.ok) {
    throw new Error(`Submit failed (${submitResponse.status}): ${await submitResponse.text()}`);
  }

  const { call_id: callId } = await submitResponse.json();
  return callId;
}

export async function fetchCallStatus(callId) {
  const endpoint = getModalEndpoint();
  const response = await fetch(`${endpoint}/status/${callId}`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Status failed (${response.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

export async function fetchCallResult(callId) {
  const endpoint = getModalEndpoint();
  const response = await fetch(`${endpoint}/result/${callId}`);
  const data = await response.json();
  return { response, data };
}

export async function waitForCallCompletion(callId, { pollMs = 5000, onStatus } = {}) {
  for (;;) {
    const status = await fetchCallStatus(callId);
    if (onStatus) onStatus(status);

    if (status.status === 'failed') {
      return { status, result: null, ok: false };
    }

    if (status.status === 'complete') {
      const { response, data } = await fetchCallResult(callId);
      if (!response.ok) {
        throw new Error(`Result fetch failed (${response.status}): ${JSON.stringify(data)}`);
      }
      return { status, result: data, ok: true };
    }

    await sleep(pollMs);
  }
}

export function extractFinalSummary(result) {
  const metadata = result?.metadata ?? {};
  return {
    calibration: result?.calibration ?? metadata.calibration,
    tracksLen: Array.isArray(result?.tracks) ? result.tracks.length : 0,
    ballLen: Array.isArray(result?.ball) ? result.ball.length : 0,
    debugCounts: metadata.debug_counts ?? null,
    debugProjection: metadata.debug_projection ?? null,
  };
}

export function printFinalSummary(result) {
  const summary = extractFinalSummary(result);
  console.log(summarizeCalibration(summary.calibration));
  console.log(`tracks=${summary.tracksLen} ball=${summary.ballLen}`);
  if (summary.debugCounts) {
    console.log(`debug_counts=${JSON.stringify(summary.debugCounts)}`);
  }
  if (summary.debugProjection) {
    console.log(`debug_projection=${JSON.stringify(summary.debugProjection)}`);
  }
}
