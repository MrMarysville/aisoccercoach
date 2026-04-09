import type { Keyframe, BallPosition } from '@/types/replay';

const FADE_DURATION = 0.5;
const LOW_CONFIDENCE_THRESHOLD = 0.5;
const LOW_CONFIDENCE_OPACITY = 0.5;

export interface InterpolatedPosition {
  x: number;
  y: number;
  opacity: number;
}

/**
 * Linear interpolation between two values.
 * @param a - Start value
 * @param b - End value
 * @param t - Interpolation factor in [0, 1]
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Binary search to find the index of the keyframe at or before time `t`.
 * Returns 0 if t is before the first keyframe, and the last index if t is
 * at or after the last keyframe.
 *
 * @param keyframes - Sorted array of keyframes (ascending by time)
 * @param t - Query time
 */
export function binarySearchKeyframes(keyframes: Keyframe[], t: number): number {
  if (keyframes.length <= 1) return 0;

  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];

  // Narrowing required by noUncheckedIndexedAccess — both are always defined here
  if (first === undefined || last === undefined) return 0;

  if (t <= first.time) return 0;
  if (t >= last.time) return keyframes.length - 1;

  let lo = 0;
  let hi = keyframes.length - 1;

  // Invariant: keyframes[lo].time <= t < keyframes[hi].time
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    const midFrame = keyframes[mid];
    if (midFrame !== undefined && midFrame.time <= t) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return lo;
}

/**
 * Compute the interpolated position of a tracked object at time `t`.
 *
 * - Before the first keyframe: clamps to first position.
 * - After the last keyframe: fades opacity to zero over FADE_DURATION seconds,
 *   returning null once fully faded.
 * - Between keyframes: linearly interpolates x/y; reduces opacity to
 *   LOW_CONFIDENCE_OPACITY when either neighbour has confidence below threshold.
 *
 * @param keyframes - Sorted array of keyframes
 * @param t - Query time in seconds
 */
export function interpolatePosition(
  keyframes: Keyframe[],
  t: number
): InterpolatedPosition | null {
  if (keyframes.length === 0) return null;

  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];

  if (first === undefined || last === undefined) return null;

  if (t <= first.time) {
    return {
      x: first.x,
      y: first.y,
      opacity: first.confidence < LOW_CONFIDENCE_THRESHOLD ? LOW_CONFIDENCE_OPACITY : 1,
    };
  }

  if (t >= last.time) {
    const elapsed = t - last.time;
    if (elapsed >= FADE_DURATION) return null;
    const fadeOpacity = Math.max(0, 1 - elapsed / FADE_DURATION);
    return { x: last.x, y: last.y, opacity: fadeOpacity };
  }

  const idx = binarySearchKeyframes(keyframes, t);
  const prev = keyframes[idx];
  const next = keyframes[idx + 1];

  // Both are guaranteed to be defined: t is strictly between first and last,
  // so idx is in [0, length-2] and idx+1 is in [1, length-1].
  if (prev === undefined || next === undefined) return null;

  const alpha = (t - prev.time) / (next.time - prev.time);
  const confidence = Math.min(prev.confidence, next.confidence);
  const opacity = confidence < LOW_CONFIDENCE_THRESHOLD ? LOW_CONFIDENCE_OPACITY : 1;

  return {
    x: lerp(prev.x, next.x, alpha),
    y: lerp(prev.y, next.y, alpha),
    opacity,
  };
}

/**
 * Interpolate ball position at time `t` from an array of BallPosition entries.
 *
 * Reuses the same binary-search + lerp approach as player interpolation.
 * Ball positions fade out faster (0.3s) since the ball moves quickly and
 * stale positions are misleading.
 *
 * @param positions - Sorted array of ball positions (ascending by time)
 * @param t - Query time in seconds
 */
export function interpolateBallPosition(
  positions: BallPosition[],
  t: number
): InterpolatedPosition | null {
  if (positions.length === 0) return null;

  const first = positions[0];
  const last = positions[positions.length - 1];

  if (first === undefined || last === undefined) return null;

  // Before first detection — don't show
  if (t < first.time) return null;

  // After last detection — fade quickly (0.3s)
  if (t >= last.time) {
    const elapsed = t - last.time;
    if (elapsed >= 0.3) return null;
    return { x: last.x, y: last.y, opacity: Math.max(0, 1 - elapsed / 0.3) };
  }

  // Binary search for bracket
  let lo = 0;
  let hi = positions.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    const midPos = positions[mid];
    if (midPos !== undefined && midPos.time <= t) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const prev = positions[lo];
  const next = positions[hi];

  if (prev === undefined || next === undefined) return null;

  const gap = next.time - prev.time;

  // If gap is zero or too large (>2s), don't interpolate — ball likely out of play
  if (gap <= 0 || gap > 2.0) {
    const elapsed = t - prev.time;
    if (elapsed >= 0.3) return null;
    return { x: prev.x, y: prev.y, opacity: Math.max(0, 1 - elapsed / 0.3) };
  }

  const alpha = (t - prev.time) / gap;
  const confidence = Math.min(prev.confidence, next.confidence);
  const isInterpolated = prev.interpolated === true || next.interpolated === true;
  const opacity = isInterpolated ? 0.7 : (confidence < LOW_CONFIDENCE_THRESHOLD ? 0.6 : 1);

  return {
    x: lerp(prev.x, next.x, alpha),
    y: lerp(prev.y, next.y, alpha),
    opacity,
  };
}
