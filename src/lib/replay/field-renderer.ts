const FIELD_WIDTH = 55;
const FIELD_HEIGHT = 36;

const PENALTY_AREA_WIDTH = 16.5;
const PENALTY_AREA_DEPTH = 5.5;
const GOAL_AREA_WIDTH = 5.5;
const GOAL_AREA_DEPTH = 1.83;
const CENTER_CIRCLE_RADIUS = 9.15;
const PENALTY_SPOT_DIST = 11;

export interface ScaleFactors {
  scaleX: number;
  scaleY: number;
}

export function computeScaleFactors(canvasWidth: number, canvasHeight: number): ScaleFactors {
  return {
    scaleX: canvasWidth / FIELD_WIDTH,
    scaleY: canvasHeight / FIELD_HEIGHT,
  };
}

export function fieldToCanvas(
  fieldX: number,
  fieldY: number,
  scaleX: number,
  scaleY: number
): { px: number; py: number } {
  return { px: fieldX * scaleX, py: fieldY * scaleY };
}

export function drawField(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): void {
  const { scaleX, scaleY } = computeScaleFactors(width, height);
  const s = (x: number, y: number) => fieldToCanvas(x, y, scaleX, scaleY);

  ctx.fillStyle = '#2d7a3f';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'white';
  ctx.lineWidth = 2;

  ctx.strokeRect(0, 0, width, height);

  const center = s(FIELD_WIDTH / 2, 0);
  const centerBottom = s(FIELD_WIDTH / 2, FIELD_HEIGHT);
  ctx.beginPath();
  ctx.moveTo(center.px, center.py);
  ctx.lineTo(centerBottom.px, centerBottom.py);
  ctx.stroke();

  const centerCircle = s(FIELD_WIDTH / 2, FIELD_HEIGHT / 2);
  ctx.beginPath();
  ctx.arc(centerCircle.px, centerCircle.py, CENTER_CIRCLE_RADIUS * scaleX, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = 'white';
  ctx.beginPath();
  ctx.arc(centerCircle.px, centerCircle.py, 3, 0, Math.PI * 2);
  ctx.fill();

  const lpa = s(0, (FIELD_HEIGHT - PENALTY_AREA_DEPTH * 2) / 2);
  ctx.strokeRect(lpa.px, lpa.py, PENALTY_AREA_WIDTH * scaleX, PENALTY_AREA_DEPTH * 2 * scaleY);

  const lga = s(0, (FIELD_HEIGHT - GOAL_AREA_DEPTH * 2) / 2);
  ctx.strokeRect(lga.px, lga.py, GOAL_AREA_WIDTH * scaleX, GOAL_AREA_DEPTH * 2 * scaleY);

  const lps = s(PENALTY_SPOT_DIST, FIELD_HEIGHT / 2);
  ctx.beginPath();
  ctx.arc(lps.px, lps.py, 3, 0, Math.PI * 2);
  ctx.fill();

  const rpa = s(FIELD_WIDTH - PENALTY_AREA_WIDTH, (FIELD_HEIGHT - PENALTY_AREA_DEPTH * 2) / 2);
  ctx.strokeRect(rpa.px, rpa.py, PENALTY_AREA_WIDTH * scaleX, PENALTY_AREA_DEPTH * 2 * scaleY);

  const rga = s(FIELD_WIDTH - GOAL_AREA_WIDTH, (FIELD_HEIGHT - GOAL_AREA_DEPTH * 2) / 2);
  ctx.strokeRect(rga.px, rga.py, GOAL_AREA_WIDTH * scaleX, GOAL_AREA_DEPTH * 2 * scaleY);

  const rps = s(FIELD_WIDTH - PENALTY_SPOT_DIST, FIELD_HEIGHT / 2);
  ctx.beginPath();
  ctx.arc(rps.px, rps.py, 3, 0, Math.PI * 2);
  ctx.fill();
}
