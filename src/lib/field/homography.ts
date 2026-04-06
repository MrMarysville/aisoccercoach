import type { CalibrationPoint } from '@/types';

/**
 * Compute a 3x3 homography matrix mapping pixel coords to field coords.
 * Uses the Direct Linear Transform with h9 = 1 normalization.
 * Requires at least 4 point pairs.
 */
export function computeHomography(points: CalibrationPoint[]): number[][] {
  if (points.length < 4) {
    throw new Error('At least 4 calibration points are required');
  }

  // For H mapping pixel (u,v) -> field (x,y):
  //   x = (h1*u + h2*v + h3) / (h7*u + h8*v + 1)
  //   y = (h4*u + h5*v + h6) / (h7*u + h8*v + 1)
  //
  // Rearranged (setting h9=1):
  //   h1*u + h2*v + h3 - x*h7*u - x*h8*v = x
  //   h4*u + h5*v + h6 - y*h7*u - y*h8*v = y
  //
  // 8 unknowns (h1..h8), 2 equations per point pair.

  const A: number[][] = [];
  const b: number[] = [];

  for (const p of points) {
    const { pixel_x: u, pixel_y: v, field_x: x, field_y: y } = p;
    A.push([u, v, 1, 0, 0, 0, -x * u, -x * v]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -y * u, -y * v]);
    b.push(y);
  }

  // Solve the (over-determined) linear system A * h = b via least squares: (A^T A) h = A^T b
  const ATA = matMulTransposeA(A);  // 8x8
  const ATb = vecMulTransposeA(A, b); // 8x1

  const h = solveLinearSystem(ATA, ATb);
  if (!h) {
    throw new Error('Failed to solve homography - points may be degenerate');
  }

  return [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1],
  ];
}

/**
 * Apply a 3x3 homography matrix to transform pixel coordinates to field coordinates.
 */
export function applyHomography(
  matrix: number[][],
  pixelX: number,
  pixelY: number
): { x: number; y: number } {
  const w = matrix[2][0] * pixelX + matrix[2][1] * pixelY + matrix[2][2];
  if (Math.abs(w) < 1e-10) {
    return { x: 0, y: 0 };
  }
  const x = (matrix[0][0] * pixelX + matrix[0][1] * pixelY + matrix[0][2]) / w;
  const y = (matrix[1][0] * pixelX + matrix[1][1] * pixelY + matrix[1][2]) / w;
  return { x, y };
}

// --- Internal helpers ---

/** Compute A^T * A where A is m x n, result is n x n */
function matMulTransposeA(A: number[][]): number[][] {
  const n = A[0].length;
  const result: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let sum = 0;
      for (let k = 0; k < A.length; k++) {
        sum += A[k][i] * A[k][j];
      }
      result[i][j] = sum;
      result[j][i] = sum;
    }
  }
  return result;
}

/** Compute A^T * b where A is m x n and b is m x 1, result is n x 1 */
function vecMulTransposeA(A: number[][], b: number[]): number[] {
  const n = A[0].length;
  const result = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < A.length; k++) {
      result[i] += A[k][i] * b[k];
    }
  }
  return result;
}

/** Solve Ax = b using Gaussian elimination with partial pivoting. */
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  const aug: number[][] = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    let maxVal = Math.abs(aug[col][col]);
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > maxVal) {
        maxVal = Math.abs(aug[row][col]);
        maxRow = row;
      }
    }
    if (maxVal < 1e-15) return null;
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    for (let row = col + 1; row < n; row++) {
      const factor = aug[row][col] / aug[col][col];
      for (let j = col; j <= n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = aug[i][n];
    for (let j = i + 1; j < n; j++) {
      x[i] -= aug[i][j] * x[j];
    }
    x[i] /= aug[i][i];
  }
  return x;
}
