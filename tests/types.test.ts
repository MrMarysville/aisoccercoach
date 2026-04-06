import { describe, it, expect } from 'vitest';
import { FIELD_DIMENSIONS } from '@/types';

describe('FIELD_DIMENSIONS', () => {
  it('has correct 9v9 dimensions', () => {
    expect(FIELD_DIMENSIONS['9v9']).toEqual({ width: 55, height: 36 });
  });

  it('has correct 11v11 dimensions', () => {
    expect(FIELD_DIMENSIONS['11v11']).toEqual({ width: 105, height: 68 });
  });
});
