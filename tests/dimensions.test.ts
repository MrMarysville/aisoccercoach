import { describe, it, expect } from 'vitest';
import { FIELD_DIMENSIONS, CALIBRATION_REFERENCE_POINTS } from '@/lib/field/dimensions';

describe('field dimensions', () => {
  it('exports 9v9 dimensions', () => {
    expect(FIELD_DIMENSIONS['9v9']).toEqual({ width: 55, height: 36 });
  });

  it('exports 11v11 dimensions', () => {
    expect(FIELD_DIMENSIONS['11v11']).toEqual({ width: 105, height: 68 });
  });
});

describe('calibration reference points', () => {
  it('has 9v9 reference points', () => {
    const refs = CALIBRATION_REFERENCE_POINTS['9v9'];
    expect(refs.length).toBeGreaterThanOrEqual(5);
    // All points within field bounds
    for (const ref of refs) {
      expect(ref.x).toBeGreaterThanOrEqual(0);
      expect(ref.x).toBeLessThanOrEqual(55);
      expect(ref.y).toBeGreaterThanOrEqual(0);
      expect(ref.y).toBeLessThanOrEqual(36);
    }
  });

  it('has 11v11 reference points', () => {
    const refs = CALIBRATION_REFERENCE_POINTS['11v11'];
    expect(refs.length).toBeGreaterThanOrEqual(5);
    for (const ref of refs) {
      expect(ref.x).toBeGreaterThanOrEqual(0);
      expect(ref.x).toBeLessThanOrEqual(105);
      expect(ref.y).toBeGreaterThanOrEqual(0);
      expect(ref.y).toBeLessThanOrEqual(68);
    }
  });

  it('includes corner and center points for 9v9', () => {
    const labels = CALIBRATION_REFERENCE_POINTS['9v9'].map((r) => r.label);
    expect(labels).toContain('Top-Left Corner');
    expect(labels).toContain('Center Spot');
  });
});
