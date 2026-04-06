/**
 * Detect the bounding box of the green field area in a video frame.
 * Used for PTZ camera auto-calibration assistance.
 */
export function detectFieldBounds(imageData: ImageData): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  const { data, width, height } = imageData;

  let top = height;
  let bottom = 0;
  let left = width;
  let right = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      if (isGreenPixel(r, g, b)) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }

  // If no green detected, return full frame
  if (top > bottom || left > right) {
    return { top: 0, bottom: height - 1, left: 0, right: width - 1 };
  }

  return { top, bottom, left, right };
}

/**
 * Check if a pixel is "soccer field green" using HSV-space thresholds.
 * Converts RGB to HSV and checks:
 * - Hue in green range (60-170 degrees)
 * - Saturation > 20%
 * - Value > 25%
 */
function isGreenPixel(r: number, g: number, b: number): boolean {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;

  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  // Value check
  if (max < 0.25) return false;

  // Saturation check
  const saturation = max === 0 ? 0 : delta / max;
  if (saturation < 0.2) return false;

  // Hue calculation
  let hue = 0;
  if (delta > 0) {
    if (max === rn) {
      hue = 60 * (((gn - bn) / delta) % 6);
    } else if (max === gn) {
      hue = 60 * ((bn - rn) / delta + 2);
    } else {
      hue = 60 * ((rn - gn) / delta + 4);
    }
  }
  if (hue < 0) hue += 360;

  // Green hue range (60-170 degrees)
  return hue >= 60 && hue <= 170;
}
