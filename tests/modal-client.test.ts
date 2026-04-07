import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { submitJob, pollStatus, getResult } from '@/lib/modal-client';

describe('modal-client', () => {
  beforeEach(() => {
    vi.stubEnv('MODAL_ENDPOINT', 'https://test--soccer-analysis.modal.run');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('submitJob', () => {
    it('calls /submit with video URL and field template', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ call_id: 'fc-abc123' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await submitJob('https://blob.vercel-storage.com/video.mp4', '9v9');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test--soccer-analysis.modal.run/submit',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ video_url: 'https://blob.vercel-storage.com/video.mp4', field_template: '9v9' }),
        })
      );
      expect(result).toBe('fc-abc123');
    });
  });

  describe('pollStatus', () => {
    it('returns parsed JobStatus', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'processing', stage: 'detection', percent: 45 }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const status = await pollStatus('fc-abc123');
      expect(status.status).toBe('processing');
      expect(status.stage).toBe('detection');
      expect(status.percent).toBe(45);
    });
  });

  describe('getResult', () => {
    it('returns ProcessingResult when complete', async () => {
      const mockResult = { metadata: { video_id: 'v1' }, tracks: [] };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResult),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await getResult('fc-abc123');
      expect(result).toEqual(mockResult);
    });

    it('returns null when still processing (202)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        json: () => Promise.resolve({ status: 'processing' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await getResult('fc-abc123');
      expect(result).toBeNull();
    });

    it('throws on server error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal error'),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(getResult('fc-abc123')).rejects.toThrow();
    });
  });
});
