import { describe, it, expect } from 'vitest';
import { computeHomography, applyHomography } from '@/lib/field/homography';
import type { CalibrationPoint } from '@/types';

describe('homography', () => {
  // Identity-like mapping: pixel coords = field coords
  const identityPoints: CalibrationPoint[] = [
    { pixel_x: 0, pixel_y: 0, field_x: 0, field_y: 0 },
    { pixel_x: 100, pixel_y: 0, field_x: 100, field_y: 0 },
    { pixel_x: 100, pixel_y: 100, field_x: 100, field_y: 100 },
    { pixel_x: 0, pixel_y: 100, field_x: 0, field_y: 100 },
  ];

  it('computes a homography from 4 points', () => {
    const H = computeHomography(identityPoints);
    expect(H).toHaveLength(3);
    expect(H[0]).toHaveLength(3);
  });

  it('throws with fewer than 4 points', () => {
    expect(() => computeHomography(identityPoints.slice(0, 3))).toThrow('At least 4');
  });

  it('maps points close to expected values with identity-like mapping', () => {
    const H = computeHomography(identityPoints);
    const result = applyHomography(H, 50, 50);
    expect(result.x).toBeCloseTo(50, 0);
    expect(result.y).toBeCloseTo(50, 0);
  });

  it('maps corner points correctly', () => {
    const H = computeHomography(identityPoints);

    const topLeft = applyHomography(H, 0, 0);
    expect(topLeft.x).toBeCloseTo(0, 0);
    expect(topLeft.y).toBeCloseTo(0, 0);

    const bottomRight = applyHomography(H, 100, 100);
    expect(bottomRight.x).toBeCloseTo(100, 0);
    expect(bottomRight.y).toBeCloseTo(100, 0);
  });

  // Scaled mapping: pixel space 0-1920 x 0-1080 -> field 0-55 x 0-36
  const scaledPoints: CalibrationPoint[] = [
    { pixel_x: 0, pixel_y: 0, field_x: 0, field_y: 0 },
    { pixel_x: 1920, pixel_y: 0, field_x: 55, field_y: 0 },
    { pixel_x: 1920, pixel_y: 1080, field_x: 55, field_y: 36 },
    { pixel_x: 0, pixel_y: 1080, field_x: 0, field_y: 36 },
  ];

  it('handles scaled mapping', () => {
    const H = computeHomography(scaledPoints);
    const center = applyHomography(H, 960, 540);
    expect(center.x).toBeCloseTo(27.5, 0);
    expect(center.y).toBeCloseTo(18, 0);
  });
});
