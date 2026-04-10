#!/usr/bin/env node

import { loadEnvFileIfPresent, uploadClip } from './calibration-utils.mjs';

function usage() {
  console.error('Usage: node scripts/upload-clip.mjs <local_video_path> [remote_prefix]');
  process.exit(1);
}

async function main() {
  loadEnvFileIfPresent();

  const localPath = process.argv[2];
  const remotePrefix = process.argv[3] ?? 'clips';
  const token = process.env.BLOB_READ_WRITE_TOKEN;

  if (!localPath) usage();
  if (!token) {
    console.error('BLOB_READ_WRITE_TOKEN is not set');
    process.exit(1);
  }

  const result = await uploadClip(localPath, remotePrefix);

  console.log(result.url);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
