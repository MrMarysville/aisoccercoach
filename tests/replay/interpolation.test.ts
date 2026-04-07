import { describe, it, expect } from 'vitest';
import { binarySearchKeyframes, lerp, interpolatePosition } from '@/lib/replay/interpolation';
import type { Keyframe } from '@/types/replay';

const keyframes: Keyframe[] = [
  { time: 0, x: 0, y: 0, confidence: 1 },
  { time: 1, x: 10, y: 20, confidence: 0.9 },
  { time: 2, x: 20, y: 10, confidence: 0.8 },
  { time: 3, x: 30, y: 30, confidence: 1 },
];

describe('lerp', () => {
  it('returns start when alpha is 0', () => {
    expect(lerp(0, 10, 0)).toBe(0);
  });

  it('returns end when alpha is 1', () => {
    expect(lerp(0, 10, 1)).toBe(10);
  });

  it('returns midpoint when alpha is 0.5', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
  });
});

describe('binarySearchKeyframes', () => {
  it('returns 0 for time before first keyframe', () => {
    expect(binarySearchKeyframes(keyframes, -1)).toBe(0);
  });

  it('returns last index for time after last keyframe', () => {
    expect(binarySearchKeyframes(keyframes, 5)).toBe(3);
  });

  it('returns correct bracketing index for mid value', () => {
    expect(binarySearchKeyframes(keyframes, 1.5)).toBe(1);
  });

  it('returns exact index on keyframe time', () => {
    expect(binarySearchKeyframes(keyframes, 2)).toBe(2);
  });

  it('handles single-element array', () => {
    const single: Keyframe[] = [{ time: 5, x: 10, y: 10, confidence: 1 }];
    expect(binarySearchKeyframes(single, 3)).toBe(0);
    expect(binarySearchKeyframes(single, 7)).toBe(0);
  });
});

describe('interpolatePosition', () => {
  it('clamps to first keyframe before start', () => {
    const pos = interpolatePosition(keyframes, -1);
    expect(pos).toEqual({ x: 0, y: 0, opacity: 1 });
  });

  it('fades out after last keyframe', () => {
    const pos = interpolatePosition(keyframes, 3.25);
    expect(pos).not.toBeNull();
    expect(pos!.opacity).toBeLessThan(1);
    expect(pos!.opacity).toBeGreaterThan(0);
  });

  it('returns null when fully faded (500ms after last)', () => {
    const pos = interpolatePosition(keyframes, 3.6);
    expect(pos).toBeNull();
  });

  it('interpolates between keyframes', () => {
    const pos = interpolatePosition(keyframes, 0.5);
    expect(pos).toEqual({ x: 5, y: 10, opacity: 1 });
  });

  it('reduces opacity for low confidence', () => {
    const lowConf: Keyframe[] = [
      { time: 0, x: 0, y: 0, confidence: 0.3 },
      { time: 1, x: 10, y: 10, confidence: 0.4 },
    ];
    const pos = interpolatePosition(lowConf, 0.5);
    expect(pos!.opacity).toBe(0.5);
  });
});
