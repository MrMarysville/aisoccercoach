import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

vi.mock('@/lib/modal-client', async () => {
  const actual = await vi.importActual('@/lib/modal-client');
  return {
    ...actual,
  };
});

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
