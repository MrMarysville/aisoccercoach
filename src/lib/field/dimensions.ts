import type { FieldTemplate, FieldDimension } from '@/types';

export const FIELD_DIMENSIONS: Record<FieldTemplate, FieldDimension> = {
  '9v9': { width: 55, height: 36 },
  '11v11': { width: 105, height: 68 },
};

/** Standard reference points for calibration (field coordinates in meters) */
export const CALIBRATION_REFERENCE_POINTS: Record<FieldTemplate, { label: string; x: number; y: number }[]> = {
  '9v9': [
    { label: 'Top-Left Corner', x: 0, y: 0 },
    { label: 'Top-Right Corner', x: 55, y: 0 },
    { label: 'Bottom-Left Corner', x: 0, y: 36 },
    { label: 'Bottom-Right Corner', x: 55, y: 36 },
    { label: 'Center Spot', x: 27.5, y: 18 },
    { label: 'Left Penalty Spot', x: 9, y: 18 },
    { label: 'Right Penalty Spot', x: 46, y: 18 },
    { label: 'Top Halfway', x: 27.5, y: 0 },
    { label: 'Bottom Halfway', x: 27.5, y: 36 },
  ],
  '11v11': [
    { label: 'Top-Left Corner', x: 0, y: 0 },
    { label: 'Top-Right Corner', x: 105, y: 0 },
    { label: 'Bottom-Left Corner', x: 0, y: 68 },
    { label: 'Bottom-Right Corner', x: 105, y: 68 },
    { label: 'Center Spot', x: 52.5, y: 34 },
    { label: 'Left Penalty Spot', x: 11, y: 34 },
    { label: 'Right Penalty Spot', x: 94, y: 34 },
    { label: 'Top Halfway', x: 52.5, y: 0 },
    { label: 'Bottom Halfway', x: 52.5, y: 68 },
  ],
};
