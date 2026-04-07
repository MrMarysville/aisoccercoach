import { describe, it, expect } from 'vitest';
import { computeScaleFactors, fieldToCanvas } from '@/lib/replay/field-renderer';

describe('computeScaleFactors', () => {
  it('computes correct scale for a 550x360 canvas', () => {
    const { scaleX, scaleY } = computeScaleFactors(550, 360);
    expect(scaleX).toBe(10);
    expect(scaleY).toBe(10);
  });

  it('computes correct scale for a 275x180 canvas', () => {
    const { scaleX, scaleY } = computeScaleFactors(275, 180);
    expect(scaleX).toBe(5);
    expect(scaleY).toBe(5);
  });
});

describe('fieldToCanvas', () => {
  it('maps field center to canvas center', () => {
    const { px, py } = fieldToCanvas(27.5, 18, 10, 10);
    expect(px).toBe(275);
    expect(py).toBe(180);
  });

  it('maps field origin to canvas origin', () => {
    const { px, py } = fieldToCanvas(0, 0, 10, 10);
    expect(px).toBe(0);
    expect(py).toBe(0);
  });

  it('maps field max to canvas max', () => {
    const { px, py } = fieldToCanvas(55, 36, 10, 10);
    expect(px).toBe(550);
    expect(py).toBe(360);
  });
});
