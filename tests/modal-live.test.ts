import { describe, it, expect } from 'vitest';

/**
 * Live integration tests — hit the real Modal endpoint.
 * Run with: pnpm test tests/modal-live.test.ts
 *
 * These are SKIPPED by default (no MODAL_LIVE_TEST env var).
 * To run: MODAL_LIVE_TEST=1 pnpm test tests/modal-live.test.ts
 */

const ENDPOINT = process.env.MODAL_ENDPOINT ?? 'https://zak-18531--soccer-analysis-fastapi-app.modal.run';
const shouldRun = process.env.MODAL_LIVE_TEST === '1';

describe.skipIf(!shouldRun)('Modal live endpoint', () => {
  it('POST /submit accepts a video URL and returns call_id', async () => {
    const res = await fetch(`${ENDPOINT}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_url: 'https://example.com/test.mp4', field_template: '9v9' }),
    });

    expect(res.ok).toBe(true);
    const data = await res.json() as { call_id: string };
    expect(data.call_id).toBeDefined();
    expect(data.call_id).toMatch(/^fc-/);
  });

  it('GET /status returns valid status for a call_id', async () => {
    // First submit to get a call_id
    const submitRes = await fetch(`${ENDPOINT}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_url: 'https://example.com/test.mp4', field_template: '9v9' }),
    });
    const { call_id } = await submitRes.json() as { call_id: string };

    // Then check status
    const statusRes = await fetch(`${ENDPOINT}/status/${call_id}`);
    expect(statusRes.ok).toBe(true);

    const status = await statusRes.json() as { status: string };
    expect(['processing', 'complete', 'failed']).toContain(status.status);
  });

  it('GET /status returns 404 for unknown call_id', async () => {
    const res = await fetch(`${ENDPOINT}/status/fc-nonexistent-id`);
    expect(res.status).toBe(404);
  });
});
