import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isModalConfigured } from '@/lib/modal-client';

describe('modal-client', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns false when NEXT_PUBLIC_MODAL_ENDPOINT is not set', () => {
    delete process.env.NEXT_PUBLIC_MODAL_ENDPOINT;
    expect(isModalConfigured()).toBe(false);
  });

  it('returns false when NEXT_PUBLIC_MODAL_ENDPOINT is empty', () => {
    process.env.NEXT_PUBLIC_MODAL_ENDPOINT = '';
    expect(isModalConfigured()).toBe(false);
  });

  it('returns true when NEXT_PUBLIC_MODAL_ENDPOINT is set', () => {
    process.env.NEXT_PUBLIC_MODAL_ENDPOINT = 'https://example.modal.run/process';
    expect(isModalConfigured()).toBe(true);
  });
});
