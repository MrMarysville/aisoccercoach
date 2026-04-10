"""
Soccer Video Analysis — Modal App

FastAPI web endpoints for job submission + status polling.
GPU function for 7-stage video processing pipeline.

Deploy: modal deploy modal_app.py
"""

import modal
import time
from dataclasses import dataclass
from typing import TypedDict

app = modal.App("soccer-analysis")

# ---------------------------------------------------------------------------
# Container image with all CV dependencies
# ---------------------------------------------------------------------------

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(["git", "libgl1", "libglib2.0-0", "ffmpeg", "wget"])
    .pip_install([
        "torch==2.3.1",
        "torchvision==0.18.1",
        "ultralytics",
        "boxmot",
        "opencv-python-headless==4.10.0.84",
        "scikit-learn",
        "supervision>=0.27.0",
        "scipy==1.13.1",
        "shapely==2.0.7",
        "munkres==1.1.4",
        "lsq-ellipse==2.2.1",
        "coloredlogs==15.0.1",
        "PyYAML==6.0.2",
        "tqdm",
        "requests",
        "fastapi[standard]",
    ])
    .run_commands([
        # PnLCalib (not on PyPI — must clone)
        "git clone https://github.com/mguti97/PnLCalib.git /opt/PnLCalib",
        "mkdir -p /opt/PnLCalib/weights",
        "wget -q https://github.com/mguti97/PnLCalib/releases/download/v1.0.0/SV_kp -O /opt/PnLCalib/weights/SV_kp",
        "wget -q https://github.com/mguti97/PnLCalib/releases/download/v1.0.0/SV_lines -O /opt/PnLCalib/weights/SV_lines",
        # Pre-download YOLO weights (YOLO26m for better accuracy + ball detection)
        'python -c "from ultralytics import YOLO; YOLO(\'yolo26m.pt\')"',
        # Pre-download ReID weights for BoxMOT
        'python -c "from boxmot import BotSort; from pathlib import Path; BotSort(reid_weights=Path(\'osnet_x0_25_msmt17.pt\'), device=\'cpu\', half=False)"',
    ])
    .env({"PYTHONPATH": "/opt/PnLCalib"})
)

# ---------------------------------------------------------------------------
# Shared progress dict (accessible from both web endpoints and GPU function)
# ---------------------------------------------------------------------------

progress_dict = modal.Dict.from_name("job-progress", create_if_missing=True)

# ---------------------------------------------------------------------------
# FastAPI web endpoints (no GPU — cheap to run)
# Imports are here (not top-level) because the GPU image doesn't have fastapi
# ---------------------------------------------------------------------------

import fastapi
from fastapi.responses import JSONResponse

web_app = fastapi.FastAPI()


@web_app.post("/submit")
async def submit(body: dict):
    """Accept a job request. Spawn the GPU function async. Return call_id."""
    video_url = body.get("video_url", "")
    field_template = body.get("field_template", "9v9")

    if not video_url:
        return JSONResponse({"error": "video_url is required"}, status_code=400)

    fn = modal.Function.from_name("soccer-analysis", "process_video")
    call = await fn.spawn.aio(video_url, field_template)
    call_id = call.object_id

    await progress_dict.put.aio(call_id, {
        "status": "processing",
        "stage": "starting",
        "percent": 0,
    })

    return {"call_id": call_id}


@web_app.get("/status/{call_id}")
async def poll_status(call_id: str):
    """Return current progress from modal.Dict. Cheap — no GPU cost."""
    state = await progress_dict.get.aio(call_id, default=None)
    if state is None:
        return JSONResponse({"status": "unknown"}, status_code=404)
    return state


@web_app.get("/result/{call_id}")
async def poll_result(call_id: str):
    """Return 202 if still running, 200 with result if done."""
    try:
        function_call = modal.functions.FunctionCall.from_id(call_id)
        result = await function_call.get.aio(timeout=0)
        return result
    except TimeoutError:
        return JSONResponse({"status": "processing"}, status_code=202)
    except Exception as e:
        state = await progress_dict.get.aio(call_id, default=None)
        if isinstance(state, dict) and state.get("status") == "failed":
            return JSONResponse(state, status_code=500)
        return JSONResponse({"error": str(e)}, status_code=500)


web_image = modal.Image.debian_slim(python_version="3.11").pip_install("fastapi[standard]")


@app.function(image=web_image)
@modal.concurrent(max_inputs=100)
@modal.asgi_app()
def fastapi_app():
    return web_app


# ---------------------------------------------------------------------------
# Calibration helpers
# ---------------------------------------------------------------------------


class CalibrationFailureError(RuntimeError):
    """Raised when the calibration stage fails hard-gate validation."""

    def __init__(
        self,
        code: str,
        message: str,
        debug_artifact_path: str | None = None,
        summary: "CalibrationSummary | None" = None,
    ):
        details = f"{code}: {message}"
        if debug_artifact_path:
            details = f"{details} [debug_artifact={debug_artifact_path}]"
        super().__init__(details)
        self.code = code
        self.debug_artifact_path = debug_artifact_path
        self.summary = summary


class CalibrationSummary(TypedDict):
    status: str
    failure_code: str | None
    failure_message: str | None
    accepted_anchor_count: int
    rejected_anchor_count: int
    accepted_anchor_count_first_15s: int
    coverage_ratio: float
    longest_gap_seconds: float
    longest_internal_gap_seconds: float
    median_anchor_line_iou: float | None
    median_temporal_consistency_px: float | None
    max_temporal_consistency_px: float | None
    median_landmark_jitter_px: float | None
    invalid_reason_counts: dict[str, int]
    debug_artifact_path: str | None
    preview_frames: list[dict[str, object]]


class FieldEvidence(TypedDict):
    grass_mask: object
    line_mask: object


@dataclass
class CalibrationStageResult:
    summary: CalibrationSummary
    frame_homographies: object
    frame_valid: object
    frame_confidence: object


def _get_field_dimensions(field_template: str) -> tuple[float, float]:
    if field_template == "9v9":
        return 55.0, 36.0
    return 105.0, 68.0


def _build_field_template_polylines(field_template: str, np):
    """Return field-template polylines in field coordinates (meters)."""
    # PnLCalib / SoccerNet camera calibration is defined on a full-size pitch.
    field_w, field_h = 105.0, 68.0

    # Keep this aligned with src/lib/replay/field-renderer.ts for 9v9.
    penalty_area_width = 16.5
    penalty_area_depth = 5.5
    goal_area_width = 5.5
    goal_area_depth = 1.83
    center_circle_radius = 9.15

    def rect(x1: float, y1: float, x2: float, y2: float):
        return np.array([
            [x1, y1],
            [x2, y1],
            [x2, y2],
            [x1, y2],
            [x1, y1],
        ], dtype=np.float32)

    polylines = [
        rect(0.0, 0.0, field_w, field_h),
        np.array([[field_w / 2.0, 0.0], [field_w / 2.0, field_h]], dtype=np.float32),
        rect(0.0, (field_h - penalty_area_depth * 2.0) / 2.0,
             penalty_area_width, (field_h + penalty_area_depth * 2.0) / 2.0),
        rect(field_w - penalty_area_width, (field_h - penalty_area_depth * 2.0) / 2.0,
             field_w, (field_h + penalty_area_depth * 2.0) / 2.0),
        rect(0.0, (field_h - goal_area_depth * 2.0) / 2.0,
             goal_area_width, (field_h + goal_area_depth * 2.0) / 2.0),
        rect(field_w - goal_area_width, (field_h - goal_area_depth * 2.0) / 2.0,
             field_w, (field_h + goal_area_depth * 2.0) / 2.0),
    ]

    circle_points = []
    for angle in np.linspace(0, 2 * np.pi, 48, endpoint=True):
        circle_points.append([
            field_w / 2.0 + center_circle_radius * np.cos(angle),
            field_h / 2.0 + center_circle_radius * np.sin(angle),
        ])
    polylines.append(np.array(circle_points, dtype=np.float32))

    return polylines


def _build_canonical_control_points(field_template: str, np):
    field_w, field_h = 105.0, 68.0
    penalty_area_width = 16.5
    penalty_area_depth = 5.5

    return np.array([
        [0.0, 0.0],
        [field_w, 0.0],
        [field_w, field_h],
        [0.0, field_h],
        [field_w / 2.0, 0.0],
        [field_w / 2.0, field_h],
        [penalty_area_width, field_h / 2.0],
        [field_w - penalty_area_width, field_h / 2.0],
        [penalty_area_width, (field_h - penalty_area_depth * 2.0) / 2.0],
        [penalty_area_width, (field_h + penalty_area_depth * 2.0) / 2.0],
        [field_w - penalty_area_width, (field_h - penalty_area_depth * 2.0) / 2.0],
        [field_w - penalty_area_width, (field_h + penalty_area_depth * 2.0) / 2.0],
    ], dtype=np.float32)


def _project_points_to_image(H_pixel_to_field, field_points, cv2, np):
    try:
        H_field_to_pixel = np.linalg.inv(H_pixel_to_field).astype(np.float32)
    except np.linalg.LinAlgError:
        return None
    pts = field_points.reshape(1, -1, 2).astype(np.float32)
    projected = cv2.perspectiveTransform(pts, H_field_to_pixel)[0]
    if not np.isfinite(projected).all():
        return None
    return projected


def _project_field_mask(H_pixel_to_field, field_polylines, frame_shape, cv2, np):
    """Rasterize projected field lines into an image-space mask."""
    height, width = frame_shape[:2]
    mask = np.zeros((height, width), dtype=np.uint8)
    total_samples = 0
    inside_samples = 0

    try:
        H_field_to_pixel = np.linalg.inv(H_pixel_to_field).astype(np.float32)
    except np.linalg.LinAlgError:
        return mask, 0.0

    for polyline in field_polylines:
        pts = cv2.perspectiveTransform(polyline.reshape(1, -1, 2), H_field_to_pixel)[0]
        if not np.isfinite(pts).all():
            continue
        int_pts = np.round(pts).astype(np.int32)
        if len(int_pts) >= 2:
            cv2.polylines(mask, [int_pts], False, 255, 3, lineType=cv2.LINE_AA)
        for start, end in zip(pts[:-1], pts[1:]):
            length = max(int(np.linalg.norm(end - start)), 1)
            samples = np.linspace(start, end, length + 1)
            total_samples += len(samples)
            inside_samples += int(np.count_nonzero(
                (samples[:, 0] >= 0) & (samples[:, 0] < width) &
                (samples[:, 1] >= 0) & (samples[:, 1] < height)
            ))

    visible_ratio = 0.0 if total_samples == 0 else inside_samples / total_samples
    return mask, float(visible_ratio)


def _extract_field_evidence(
    frame_bgr,
    cv2,
    np,
    *,
    clahe=None,
    grass_open_kernel=None,
    grass_close_kernel=None,
    top_hat_kernel=None,
    line_open_kernel=None,
) -> FieldEvidence:
    hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)

    clahe = clahe or cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    grass_open_kernel = grass_open_kernel if grass_open_kernel is not None else np.ones((5, 5), dtype=np.uint8)
    grass_close_kernel = grass_close_kernel if grass_close_kernel is not None else np.ones((9, 9), dtype=np.uint8)
    top_hat_kernel = top_hat_kernel if top_hat_kernel is not None else np.ones((13, 13), dtype=np.uint8)
    line_open_kernel = line_open_kernel if line_open_kernel is not None else np.ones((3, 3), dtype=np.uint8)
    gray_eq = clahe.apply(gray)

    grass_mask_raw = cv2.inRange(
        hsv,
        np.array([25, 35, 30], dtype=np.uint8),
        np.array([95, 255, 255], dtype=np.uint8),
    )
    grass_mask_raw = cv2.morphologyEx(grass_mask_raw, cv2.MORPH_OPEN, grass_open_kernel)
    grass_mask_raw = cv2.morphologyEx(grass_mask_raw, cv2.MORPH_CLOSE, grass_close_kernel)

    # For sideline PTZ footage, the relevant pitch region is typically the largest
    # grass component connected to the lower field of view, not the background grass
    # behind the far-side fence.
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats((grass_mask_raw > 0).astype(np.uint8), 8)
    if num_labels > 1:
        best_label = 1
        best_score = -1.0
        frame_h, _frame_w = grass_mask_raw.shape
        for label in range(1, num_labels):
            x, y, w, h, area = stats[label]
            centroid_y = centroids[label][1]
            touches_bottom = 1.0 if y + h >= frame_h - 5 else 0.0
            score = float(area) * (1.0 + 0.75 * touches_bottom + 0.25 * (centroid_y / max(frame_h, 1)))
            if score > best_score:
                best_score = score
                best_label = label
        grass_mask = np.where(labels == best_label, 255, 0).astype(np.uint8)
    else:
        grass_mask = grass_mask_raw.copy()

    row_fraction = (grass_mask > 0).mean(axis=1)
    pitch_start_row = None
    window = 20
    for y in range(0, max(0, len(row_fraction) - window)):
        if np.all(row_fraction[y:y + window] > 0.82):
            pitch_start_row = y
            break
    if pitch_start_row is None:
        pitch_start_row = max(0, int(grass_mask.shape[0] * 0.28))
    cutoff_row = max(0, pitch_start_row - 35)
    grass_mask[:cutoff_row, :] = 0

    contours, _ = cv2.findContours(grass_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if contours:
        largest = max(contours, key=cv2.contourArea)
        hull = cv2.convexHull(largest)
        pitch_mask = np.zeros_like(grass_mask)
        cv2.fillConvexPoly(pitch_mask, hull, 255)
        grass_mask = pitch_mask

    top_hat = cv2.morphologyEx(gray_eq, cv2.MORPH_TOPHAT, top_hat_kernel)
    local_grass = cv2.blur((grass_mask_raw > 0).astype(np.float32), (31, 31)) > 0.78
    low_sat = hsv[:, :, 1] < 75
    bright = gray_eq > 150
    thin = top_hat > 24
    line_mask = np.where(low_sat & bright & thin & local_grass & (grass_mask > 0), 255, 0).astype(np.uint8)
    line_mask = cv2.morphologyEx(line_mask, cv2.MORPH_OPEN, line_open_kernel)

    return {"grass_mask": grass_mask, "line_mask": line_mask}


def _compute_mask_iou(mask_a, mask_b, np) -> float:
    a = mask_a > 0
    b = mask_b > 0
    union = np.logical_or(a, b)
    if not union.any():
        return 0.0
    intersection = np.logical_and(a, b)
    return float(intersection.sum() / union.sum())


def _is_orientation_valid(H_pixel_to_field, control_points, frame_shape, cv2, np) -> bool:
    projected = _project_points_to_image(H_pixel_to_field, control_points[:4], cv2, np)
    if projected is None:
        return False
    polygon = projected.astype(np.float32)
    area = cv2.contourArea(polygon, oriented=True)
    if not np.isfinite(area) or abs(area) < 1000:
        return False
    hull = cv2.convexHull(polygon)
    if len(hull) < 4:
        return False
    edge_lengths = np.linalg.norm(np.roll(polygon, -1, axis=0) - polygon, axis=1)
    if not np.isfinite(edge_lengths).all() or float(np.min(edge_lengths)) < 10.0:
        return False
    return True


def _measure_temporal_consistency(candidate_H, reference_H, control_points, frame_shape, cv2, np):
    if reference_H is None:
        return None
    candidate_pts = _project_points_to_image(candidate_H, control_points, cv2, np)
    reference_pts = _project_points_to_image(reference_H, control_points, cv2, np)
    if candidate_pts is None or reference_pts is None:
        return None

    height, width = frame_shape[:2]
    margin_x = width * 0.15
    margin_y = height * 0.15
    in_bounds_candidate = (
        (candidate_pts[:, 0] >= -margin_x) & (candidate_pts[:, 0] <= width + margin_x) &
        (candidate_pts[:, 1] >= -margin_y) & (candidate_pts[:, 1] <= height + margin_y)
    )
    in_bounds_reference = (
        (reference_pts[:, 0] >= -margin_x) & (reference_pts[:, 0] <= width + margin_x) &
        (reference_pts[:, 1] >= -margin_y) & (reference_pts[:, 1] <= height + margin_y)
    )
    valid = in_bounds_candidate & in_bounds_reference
    if int(np.count_nonzero(valid)) >= 2:
        candidate_pts = candidate_pts[valid]
        reference_pts = reference_pts[valid]

    dists = np.linalg.norm(candidate_pts - reference_pts, axis=1)
    if not np.isfinite(dists).all():
        return None
    return float(np.median(dists))


def _score_anchor_candidate(
    candidate_H,
    evidence,
    field_polylines,
    control_points,
    prev_reference_H,
    frame_shape,
    cv2,
    np,
):
    projected_mask, visible_ratio = _project_field_mask(candidate_H, field_polylines, frame_shape, cv2, np)
    line_iou = _compute_mask_iou(projected_mask, evidence["line_mask"], np)
    orientation_valid = _is_orientation_valid(candidate_H, control_points, frame_shape, cv2, np)
    temporal_consistency_px = _measure_temporal_consistency(
        candidate_H, prev_reference_H, control_points, frame_shape, cv2, np,
    )

    is_bootstrap = prev_reference_H is None
    accepted = (
        is_bootstrap or (
            visible_ratio >= 0.10 and
            (temporal_consistency_px is None or temporal_consistency_px <= 1200.0)
        )
    )

    line_term = float(np.clip(line_iou / 0.20, 0.0, 1.0))
    visible_term = float(np.clip(visible_ratio / 0.15, 0.0, 1.0))
    temporal_term = 1.0 if temporal_consistency_px is None else float(np.clip(1.0 - temporal_consistency_px / 160.0, 0.0, 1.0))
    confidence = round(0.20 * line_term + 0.25 * visible_term + 0.55 * temporal_term, 3)

    return {
        "accepted": accepted,
        "confidence": confidence,
        "line_iou": float(line_iou),
        "visible_template_ratio": float(visible_ratio),
        "temporal_consistency_px": temporal_consistency_px,
        "orientation_valid": orientation_valid,
    }


def _render_calibration_debug_video(
    transcoded_path,
    output_path,
    frame_homographies,
    frame_valid,
    frame_confidence,
    frame_source,
    frame_anchor_age,
    frame_fail_reason,
    field_polylines,
    cv2,
    np,
):
    cap = cv2.VideoCapture(transcoded_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    scale = 1.0 if width <= 960 else 960.0 / width
    out_w = max(1, int(round(width * scale)))
    out_h = max(1, int(round(height * scale)))

    writer = cv2.VideoWriter(
        output_path,
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (out_w, out_h),
    )
    if not writer.isOpened():
        cap.release()
        raise CalibrationFailureError(
            "CALIBRATION_DEBUG_RENDER_FAILED",
            "Failed to open debug video writer",
            output_path,
        )

    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        overlay = frame.copy()
        if frame_valid[frame_idx]:
            projected_mask, _ = _project_field_mask(frame_homographies[frame_idx], field_polylines, frame.shape, cv2, np)
            overlay[projected_mask > 0] = (0, 255, 255)

        source_map = {
            0: "invalid",
            1: "anchor_pnl",
            2: "propagated_ecc",
        }
        label_lines = [
            f"frame={frame_idx}",
            f"valid={'yes' if frame_valid[frame_idx] else 'no'}",
            f"source={source_map.get(int(frame_source[frame_idx]), 'unknown')}",
            f"conf={frame_confidence[frame_idx]:.2f}",
            f"anchor_age={int(frame_anchor_age[frame_idx])}",
        ]
        fail_reason = frame_fail_reason[frame_idx]
        if fail_reason:
            label_lines.append(f"reason={fail_reason}")

        y = 28
        for line in label_lines:
            cv2.putText(
                overlay,
                line,
                (20, y),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.75,
                (255, 255, 255),
                2,
                cv2.LINE_AA,
            )
            y += 28

        if scale != 1.0:
            overlay = cv2.resize(overlay, (out_w, out_h), interpolation=cv2.INTER_AREA)
        writer.write(overlay)
        frame_idx += 1

    cap.release()
    writer.release()


def _render_calibration_preview_frames(
    transcoded_path,
    frame_homographies,
    frame_valid,
    frame_confidence,
    frame_source,
    frame_anchor_age,
    frame_fail_reason,
    field_polylines,
    cv2,
    np,
):
    cap = cv2.VideoCapture(transcoded_path)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    candidates = []
    valid_indices = np.flatnonzero(frame_valid).tolist()
    if valid_indices:
        candidates.extend([
            valid_indices[0],
            valid_indices[len(valid_indices) // 2],
            valid_indices[-1],
        ])
    else:
        fallback = [0, max(0, total_frames // 2), max(0, total_frames - 1)]
        candidates.extend(fallback)

    unique_indices = []
    for idx in candidates:
        if idx not in unique_indices and 0 <= idx < total_frames:
            unique_indices.append(int(idx))

    source_map = {
        0: "invalid",
        1: "anchor_pnl",
        2: "propagated_ecc",
    }

    previews = []
    for frame_idx in unique_indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if not ret:
            continue

        overlay = frame.copy()
        if frame_idx < len(frame_valid) and frame_valid[frame_idx]:
            projected_mask, _ = _project_field_mask(
                frame_homographies[frame_idx], field_polylines, frame.shape, cv2, np,
            )
            overlay[projected_mask > 0] = (0, 255, 255)

        label_lines = [
            f"frame={frame_idx}",
            f"valid={'yes' if bool(frame_valid[frame_idx]) else 'no'}",
            f"source={source_map.get(int(frame_source[frame_idx]), 'unknown')}",
            f"conf={float(frame_confidence[frame_idx]):.2f}",
            f"anchor_age={int(frame_anchor_age[frame_idx])}",
        ]
        fail_reason = frame_fail_reason[frame_idx]
        if fail_reason:
            label_lines.append(f"reason={fail_reason}")

        y = 26
        for line in label_lines:
            cv2.putText(
                overlay,
                line,
                (16, y),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.7,
                (255, 255, 255),
                2,
                cv2.LINE_AA,
            )
            y += 26

        preview = cv2.resize(overlay, (640, max(1, int(round(overlay.shape[0] * 640 / overlay.shape[1])))), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", preview, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
        if not ok:
            continue

        import base64
        data_url = "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode("ascii")
        previews.append({
            "frame": frame_idx,
            "time": round(frame_idx / fps, 2),
            "label": "valid" if bool(frame_valid[frame_idx]) else "invalid",
            "source": source_map.get(int(frame_source[frame_idx]), "unknown"),
            "data_url": data_url,
        })

    cap.release()
    return previews


def _summarize_calibration(
    fps,
    frame_valid,
    frame_line_iou,
    frame_temporal_consistency,
    frame_landmark_jitter,
    frame_anchor_accepted,
    frame_fail_reason,
    np,
):
    total_frames = len(frame_valid)
    coverage_ratio = float(np.count_nonzero(frame_valid) / max(1, total_frames))

    longest_invalid = 0
    current_invalid = 0
    longest_internal_invalid = 0
    valid_seen = False
    for is_valid in frame_valid:
        if is_valid:
            if valid_seen:
                longest_internal_invalid = max(longest_internal_invalid, current_invalid)
            valid_seen = True
            longest_invalid = max(longest_invalid, current_invalid)
            current_invalid = 0
        else:
            current_invalid += 1
    longest_invalid = max(longest_invalid, current_invalid)
    if valid_seen and np.any(frame_valid[::-1]):
        trailing_invalid = current_invalid
        longest_internal_invalid = max(longest_internal_invalid, 0 if trailing_invalid == longest_invalid else current_invalid)

    # Recompute internal gaps explicitly to avoid counting leading/trailing tails.
    first_valid = int(np.argmax(frame_valid)) if np.any(frame_valid) else -1
    last_valid = total_frames - 1 - int(np.argmax(frame_valid[::-1])) if np.any(frame_valid) else -1
    if first_valid >= 0 and last_valid >= first_valid:
        current_internal = 0
        longest_internal_invalid = 0
        for idx in range(first_valid, last_valid + 1):
            if frame_valid[idx]:
                longest_internal_invalid = max(longest_internal_invalid, current_internal)
                current_internal = 0
            else:
                current_internal += 1
        longest_internal_invalid = max(longest_internal_invalid, current_internal)
    else:
        longest_internal_invalid = longest_invalid

    anchor_line_iou = frame_line_iou[frame_anchor_accepted]
    anchor_line_iou = anchor_line_iou[np.isfinite(anchor_line_iou)]

    anchor_temporal = frame_temporal_consistency[frame_anchor_accepted]
    anchor_temporal = anchor_temporal[np.isfinite(anchor_temporal)]

    valid_jitter = frame_landmark_jitter[frame_valid]
    valid_jitter = valid_jitter[np.isfinite(valid_jitter)]
    invalid_reason_counts = {}
    for reason in frame_fail_reason:
        if not reason:
            continue
        invalid_reason_counts[reason] = invalid_reason_counts.get(reason, 0) + 1

    failure_code = None
    failure_message = None
    accepted_anchor_count_first_15s = int(np.count_nonzero(frame_anchor_accepted[: int(15 * fps)]))

    if accepted_anchor_count_first_15s == 0:
        failure_code = "CALIBRATION_BOOTSTRAP_FAILED"
        failure_message = "No valid field anchor found in first 15 seconds"
    elif accepted_anchor_count_first_15s < 3:
        failure_code = "CALIBRATION_BOOTSTRAP_WEAK"
        failure_message = f"Only {accepted_anchor_count_first_15s} valid field anchors found in first 15 seconds"
    elif coverage_ratio < 0.80:
        failure_code = "CALIBRATION_COVERAGE_TOO_LOW"
        failure_message = f"Calibration coverage ratio {coverage_ratio:.2f} is below 0.80"
    elif longest_internal_invalid / max(fps, 1e-6) > 4.5:
        failure_code = "CALIBRATION_GAP_TOO_LONG"
        failure_message = f"Longest internal invalid calibration gap is {longest_internal_invalid / fps:.1f}s"
    elif valid_jitter.size == 0 or float(np.median(valid_jitter)) > 1200.0:
        failure_code = "CALIBRATION_TEMPORAL_INCONSISTENT"
        failure_message = "Landmark jitter exceeds temporal consistency threshold"
    elif anchor_temporal.size > 0 and float(np.max(anchor_temporal)) > 1500.0:
        failure_code = "CALIBRATION_TEMPORAL_INCONSISTENT"
        failure_message = "Anchor temporal consistency exceeded 1500 pixels"

    return CalibrationSummary(
        status="failed" if failure_code else "passed",
        failure_code=failure_code,
        failure_message=failure_message,
        accepted_anchor_count=int(np.count_nonzero(frame_anchor_accepted)),
        rejected_anchor_count=int(np.count_nonzero(np.isfinite(frame_line_iou)) - np.count_nonzero(frame_anchor_accepted)),
        accepted_anchor_count_first_15s=accepted_anchor_count_first_15s,
        coverage_ratio=round(coverage_ratio, 3),
        longest_gap_seconds=round(longest_invalid / max(fps, 1e-6), 2),
        longest_internal_gap_seconds=round(longest_internal_invalid / max(fps, 1e-6), 2),
        median_anchor_line_iou=None if anchor_line_iou.size == 0 else round(float(np.median(anchor_line_iou)), 3),
        median_temporal_consistency_px=None if anchor_temporal.size == 0 else round(float(np.median(anchor_temporal)), 2),
        max_temporal_consistency_px=None if anchor_temporal.size == 0 else round(float(np.max(anchor_temporal)), 2),
        median_landmark_jitter_px=None if valid_jitter.size == 0 else round(float(np.median(valid_jitter)), 2),
        invalid_reason_counts=invalid_reason_counts,
        debug_artifact_path=None,
        preview_frames=[],
    )


def _load_calibration_models(np):
    import os

    pnlcalib_root = os.environ.get("PNLCALIB_ROOT", "/opt/PnLCalib")
    try:
        import yaml as pyyaml
        import torch
        import torchvision.transforms as T
        import inference as pnl_inference_module
        from inference import projection_from_cam_params
        from model.cls_hrnet import get_cls_net
        from model.cls_hrnet_l import get_cls_net as get_cls_net_l
        from utils.utils_calib import FramebyFrameCalib
    except Exception as e:
        raise CalibrationFailureError(
            "CALIBRATION_PNLCALIB_UNAVAILABLE",
            f"Failed to import PnLCalib dependencies: {e}",
        ) from e

    cfg = pyyaml.safe_load(open(f"{pnlcalib_root}/config/hrnetv2_w48.yaml"))
    kp_model = get_cls_net(cfg)
    kp_model.load_state_dict(torch.load(f"{pnlcalib_root}/weights/SV_kp", map_location="cuda:0"))
    kp_model.to("cuda:0").eval()

    cfg_l = pyyaml.safe_load(open(f"{pnlcalib_root}/config/hrnetv2_w48_l.yaml"))
    line_model = get_cls_net_l(cfg_l)
    line_model.load_state_dict(torch.load(f"{pnlcalib_root}/weights/SV_lines", map_location="cuda:0"))
    line_model.to("cuda:0").eval()

    # PnLCalib's inference() relies on CLI-initialized module globals.
    pnl_inference_module.device = "cuda:0"
    pnl_inference_module.transform2 = T.Resize((540, 960))
    pnl_inference = pnl_inference_module.inference
    pnl_inference.__globals__["device"] = "cuda:0"
    pnl_inference.__globals__["transform2"] = pnl_inference_module.transform2

    def calibrate_frame(frame_bgr):
        try:
            cam = FramebyFrameCalib(
                iwidth=frame_bgr.shape[1],
                iheight=frame_bgr.shape[0],
                denormalize=True,
            )
            pnl_inference(
                cam,
                frame_bgr,
                kp_model,
                line_model,
                kp_threshold=0.1486,
                line_threshold=0.3886,
                pnl_refine=True,
            )
            result = cam.heuristic_voting(refine_lines=True)
            if result is None or "cam_params" not in result:
                return None, "missing_cam_params"

            projection = projection_from_cam_params(result).astype(np.float32)
            centered_translation = np.array([
                [1.0, 0.0, -52.5],
                [0.0, 1.0, -34.0],
                [0.0, 0.0, 1.0],
            ], dtype=np.float32)
            base_field2pixel = projection[:, [0, 1, 3]]
            candidate_field2pixel = [
                ("top_left", base_field2pixel),
                ("centered", base_field2pixel @ centered_translation),
            ]

            candidates = []
            candidate_errors = []
            for label, H_field2pixel in candidate_field2pixel:
                try:
                    H_pixel2field = np.linalg.inv(H_field2pixel)
                except np.linalg.LinAlgError:
                    rank = int(np.linalg.matrix_rank(H_field2pixel))
                    if rank < 2:
                        candidate_errors.append(f"{label}: singular_matrix")
                        continue
                    H_pixel2field = np.linalg.pinv(H_field2pixel).astype(np.float32)
                if not np.isfinite(H_pixel2field).all():
                    candidate_errors.append(f"{label}: non_finite_homography")
                    continue
                candidates.append((label, H_pixel2field.astype(np.float32)))

            if not candidates:
                return None, "; ".join(candidate_errors) or "no_homography_candidates"
            return candidates, None
        except Exception as e:
            return None, f"{type(e).__name__}: {str(e)[:160]}"

    return calibrate_frame


def run_calibration_stage(
    transcoded_path,
    field_template,
    call_id,
    update_progress,
    cv2,
    np,
):
    # Keep calibration on a full regulation pitch model. The downstream tactical
    # board can still be 9v9, but the camera solve should use the complete field.
    calibration_template = "11v11"
    field_polylines = _build_field_template_polylines(calibration_template, np)
    control_points = _build_canonical_control_points(calibration_template, np)
    calibrate_frame = _load_calibration_models(np)

    cap = cv2.VideoCapture(transcoded_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    sample_interval = max(1, int(round(2.0 * fps)))  # 2.0s anchor attempts
    # PTZ clips can go several seconds with sparse field geometry even when ECC
    # propagation remains stable. Keep the last good anchor alive long enough
    # to bridge those sparse stretches, then rely on hard-fail coverage to
    # reject clips that never recover.
    max_anchor_age_frames = max(1, int(round(12.0 * fps)))
    ecc_size = (640, 360)
    max_propagated_jitter_px = 1200.0
    scale_to_small = np.array([
        [ecc_size[0] / max(frame_w, 1), 0.0, 0.0],
        [0.0, ecc_size[1] / max(frame_h, 1), 0.0],
        [0.0, 0.0, 1.0],
    ], dtype=np.float32)
    scale_to_full = np.linalg.inv(scale_to_small)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    grass_open_kernel = np.ones((5, 5), dtype=np.uint8)
    grass_close_kernel = np.ones((9, 9), dtype=np.uint8)
    top_hat_kernel = np.ones((13, 13), dtype=np.uint8)
    line_open_kernel = np.ones((3, 3), dtype=np.uint8)

    frame_homographies = np.zeros((total_frames, 3, 3), dtype=np.float32)
    frame_valid = np.zeros(total_frames, dtype=bool)
    frame_confidence = np.zeros(total_frames, dtype=np.float32)
    frame_source = np.zeros(total_frames, dtype=np.uint8)
    frame_anchor_age = np.full(total_frames, -1, dtype=np.int32)
    frame_line_iou = np.full(total_frames, np.nan, dtype=np.float32)
    frame_temporal_consistency = np.full(total_frames, np.nan, dtype=np.float32)
    frame_landmark_jitter = np.full(total_frames, np.nan, dtype=np.float32)
    frame_anchor_accepted = np.zeros(total_frames, dtype=bool)
    frame_fail_reason = [None] * total_frames
    anchor_attempts = 0
    anchor_accepts = 0
    anchor_missing = 0
    anchor_rejected = 0
    cumulative_anchor_ms = 0.0
    last_anchor_status = "pending"
    last_anchor_error = None
    last_anchor_line_iou = None
    last_anchor_visible_ratio = None
    last_anchor_orientation_valid = None
    last_anchor_temporal_px = None

    prev_gray = None
    H_accumulated = np.eye(3, dtype=np.float32)
    anchor_H = None
    anchor_frame = -1
    prev_valid_H = None
    last_progress_emit_frame = -1

    def emit_calibration_progress(force: bool = False):
        nonlocal last_progress_emit_frame
        if not force and frame_idx == last_progress_emit_frame:
            return
        pct = 10 + int(20 * frame_idx / max(1, total_frames))
        update_progress(
            "field_calibration",
            min(pct, 30),
            current_frame=frame_idx,
            total_frames=total_frames,
            anchor_attempts=anchor_attempts,
            anchor_accepted=anchor_accepts,
            anchor_missing=anchor_missing,
            anchor_rejected=anchor_rejected,
            last_anchor_status=last_anchor_status,
            last_anchor_error=last_anchor_error,
            last_anchor_line_iou=last_anchor_line_iou,
            last_anchor_visible_ratio=last_anchor_visible_ratio,
            last_anchor_orientation_valid=last_anchor_orientation_valid,
            last_anchor_temporal_px=last_anchor_temporal_px,
            avg_anchor_ms=round(cumulative_anchor_ms / max(anchor_attempts, 1), 1),
        )
        last_progress_emit_frame = frame_idx

    def estimate_ecc(prev_g, curr_g):
        warp = np.eye(3, dtype=np.float32)
        criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6)
        try:
            _, warp = cv2.findTransformECC(
                prev_g,
                curr_g,
                warp,
                cv2.MOTION_HOMOGRAPHY,
                criteria,
            )
        except cv2.error:
            pass
        return warp

    frame_idx = 0
    update_progress("field_evidence", 10)
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        gray_small = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray_small = cv2.resize(gray_small, ecc_size).astype(np.float32)

        if prev_gray is not None:
            H_small = estimate_ecc(prev_gray, gray_small)
            H_frame = scale_to_full @ H_small @ scale_to_small
            H_accumulated = H_frame @ H_accumulated
        prev_gray = gray_small

        accumulated_inverse = None
        reference_H = None
        if anchor_H is not None:
            try:
                accumulated_inverse = np.linalg.inv(H_accumulated)
                reference_H = anchor_H @ accumulated_inverse
            except np.linalg.LinAlgError:
                reference_H = None

        if frame_idx % sample_interval == 0:
            anchor_attempts += 1
            anchor_start = time.time()
            candidate_Hs, candidate_error = calibrate_frame(frame)
            anchor_ms = (time.time() - anchor_start) * 1000.0
            cumulative_anchor_ms += anchor_ms
            if candidate_Hs is not None:
                evidence = _extract_field_evidence(
                    frame,
                    cv2,
                    np,
                    clahe=clahe,
                    grass_open_kernel=grass_open_kernel,
                    grass_close_kernel=grass_close_kernel,
                    top_hat_kernel=top_hat_kernel,
                    line_open_kernel=line_open_kernel,
                )
                scored_candidates = []
                for candidate_label, candidate_H in candidate_Hs:
                    score = _score_anchor_candidate(
                        candidate_H,
                        evidence,
                        field_polylines,
                        control_points,
                        reference_H,
                        frame.shape,
                        cv2,
                        np,
                    )
                    scored_candidates.append((candidate_label, candidate_H, score))

                candidate_label, candidate_H, score = max(
                    scored_candidates,
                    key=lambda item: (
                        1 if item[2]["accepted"] else 0,
                        item[2]["confidence"],
                        item[2]["line_iou"],
                        item[2]["visible_template_ratio"],
                    ),
                )
                frame_line_iou[frame_idx] = score["line_iou"]
                if score["temporal_consistency_px"] is not None:
                    frame_temporal_consistency[frame_idx] = score["temporal_consistency_px"]
                last_anchor_line_iou = round(float(score["line_iou"]), 3)
                last_anchor_visible_ratio = round(float(score["visible_template_ratio"]), 3)
                last_anchor_orientation_valid = bool(score["orientation_valid"])
                last_anchor_temporal_px = (
                    None if score["temporal_consistency_px"] is None
                    else round(float(score["temporal_consistency_px"]), 2)
                )

                if score["accepted"]:
                    anchor_accepts += 1
                    anchor_H = candidate_H
                    anchor_frame = frame_idx
                    H_accumulated = np.eye(3, dtype=np.float32)
                    reference_H = candidate_H
                    frame_anchor_accepted[frame_idx] = True
                    frame_source[frame_idx] = 1
                    frame_confidence[frame_idx] = score["confidence"]
                    last_anchor_status = f"accepted:{candidate_label}"
                    last_anchor_error = None
                else:
                    anchor_rejected += 1
                    frame_fail_reason[frame_idx] = "anchor_rejected"
                    last_anchor_status = f"rejected:{candidate_label}"
                    last_anchor_error = None
            else:
                anchor_missing += 1
                frame_fail_reason[frame_idx] = candidate_error or "anchor_missing"
                last_anchor_status = "missing"
                last_anchor_error = candidate_error
            emit_calibration_progress(force=True)

        current_H = None
        if anchor_H is None:
            frame_fail_reason[frame_idx] = frame_fail_reason[frame_idx] or "bootstrap_pending"
        else:
            try:
                if accumulated_inverse is None:
                    accumulated_inverse = np.linalg.inv(H_accumulated)
                current_H = anchor_H @ accumulated_inverse
            except np.linalg.LinAlgError:
                current_H = None
                frame_fail_reason[frame_idx] = "ecc_inversion_failed"

        if current_H is not None:
            anchor_age = frame_idx - anchor_frame
            frame_anchor_age[frame_idx] = anchor_age
            frame_homographies[frame_idx] = current_H
            if frame_source[frame_idx] == 0:
                frame_source[frame_idx] = 2

            jitter = _measure_temporal_consistency(current_H, prev_valid_H, control_points, frame.shape, cv2, np)
            if jitter is not None:
                frame_landmark_jitter[frame_idx] = jitter

            is_anchor_frame = bool(frame_anchor_accepted[frame_idx])
            age_ok = anchor_age <= max_anchor_age_frames
            jitter_ok = jitter is None or jitter <= max_propagated_jitter_px
            if is_anchor_frame or (age_ok and jitter_ok):
                frame_valid[frame_idx] = True
                frame_fail_reason[frame_idx] = None
                if frame_confidence[frame_idx] == 0:
                    age_term = float(np.clip(1.0 - anchor_age / max_anchor_age_frames, 0.0, 1.0))
                    jitter_term = 1.0 if jitter is None else float(np.clip(1.0 - jitter / max_propagated_jitter_px, 0.0, 1.0))
                    frame_confidence[frame_idx] = round(0.7 * age_term + 0.3 * jitter_term, 3)
                prev_valid_H = current_H
            else:
                if not age_ok:
                    frame_fail_reason[frame_idx] = "anchor_gap_exceeded"
                elif not jitter_ok:
                    frame_fail_reason[frame_idx] = "temporal_jitter"

        if frame_idx % max(1, total_frames // 12) == 0:
            emit_calibration_progress(force=True)
            print(
                "[CALIBRATION]"
                f" frame={frame_idx}/{total_frames}"
                f" attempts={anchor_attempts}"
                f" accepted={anchor_accepts}"
                f" missing={anchor_missing}"
                f" rejected={anchor_rejected}"
                f" last_status={last_anchor_status}"
                f" last_error={last_anchor_error}"
                f" last_line_iou={last_anchor_line_iou}"
                f" last_visible={last_anchor_visible_ratio}"
                f" last_orientation={last_anchor_orientation_valid}"
                f" last_temporal={last_anchor_temporal_px}"
                f" avg_anchor_ms={(cumulative_anchor_ms / max(anchor_attempts, 1)):.1f}"
            )

        frame_idx += 1

    cap.release()

    summary = _summarize_calibration(
        fps,
        frame_valid,
        frame_line_iou,
        frame_temporal_consistency,
        frame_landmark_jitter,
        frame_anchor_accepted,
        frame_fail_reason,
        np,
    )

    debug_path = f"/tmp/calibration_debug_{call_id}.mp4"
    update_progress("calibration_debug", 32)
    _render_calibration_debug_video(
        transcoded_path,
        debug_path,
        frame_homographies,
        frame_valid,
        frame_confidence,
        frame_source,
        frame_anchor_age,
        frame_fail_reason,
        field_polylines,
        cv2,
        np,
    )
    summary["debug_artifact_path"] = debug_path
    summary["preview_frames"] = _render_calibration_preview_frames(
        transcoded_path,
        frame_homographies,
        frame_valid,
        frame_confidence,
        frame_source,
        frame_anchor_age,
        frame_fail_reason,
        field_polylines,
        cv2,
        np,
    )

    if summary["status"] != "passed":
        raise CalibrationFailureError(
            summary["failure_code"] or "CALIBRATION_FAILED",
            summary["failure_message"] or "Calibration did not meet hard-fail thresholds",
            debug_path,
            summary,
        )

    return CalibrationStageResult(
        summary=summary,
        frame_homographies=frame_homographies,
        frame_valid=frame_valid,
        frame_confidence=frame_confidence,
    )


def _download_and_transcode_video(
    video_url,
    update_progress,
    requests,
    subprocess,
    os,
    cv2,
):
    input_path = "/tmp/input_video"
    transcoded_path = "/tmp/transcoded.mp4"

    update_progress("transcoding", 2)

    if video_url.startswith(("http://", "https://")):
        resp = requests.get(video_url, stream=True)
        resp.raise_for_status()
        with open(input_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8 * 1024 * 1024):
                f.write(chunk)
    else:
        source_path = video_url.removeprefix("file://")
        with open(source_path, "rb") as src, open(input_path, "wb") as dst:
            while True:
                chunk = src.read(8 * 1024 * 1024)
                if not chunk:
                    break
                dst.write(chunk)

    update_progress("transcoding", 5)

    subprocess.run([
        "ffmpeg", "-y", "-i", input_path,
        "-c:v", "libx264", "-preset", "ultrafast",
        "-an",
        transcoded_path,
    ], check=True, capture_output=True)

    os.remove(input_path)

    cap = cv2.VideoCapture(transcoded_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    duration = total_frames / fps
    cap.release()

    update_progress("transcoding", 8)

    return {
        "transcoded_path": transcoded_path,
        "fps": fps,
        "total_frames": total_frames,
        "width": width,
        "height": height,
        "duration": duration,
    }


# ---------------------------------------------------------------------------
# GPU processing function
# ---------------------------------------------------------------------------

@app.function(
    gpu="A10G",
    image=image,
    timeout=3600,
    enable_memory_snapshot=True,
    scaledown_window=300,
)
def process_video(video_url: str, field_template: str) -> dict:
    """Process a soccer match video through a 7-stage CV pipeline.

    Pipeline (two-pass detection + post-processing):
        1. Download + transcode (FFmpeg H.265→H.264)
        2. ECC camera motion estimation (every frame)
        3. PnLCalib field calibration (every 30th frame)
        4a. YOLO26m player detection (every 3rd frame, batch=8, imgsz=1088)
        4b. SAHI tiled ball detection (every 3rd frame, 640x640 tiles, classes=[32])
        5. BoT-SORT tracking with CMC (players) + centroid tracker (ball)
        6. K-Means team classification (post-processing)
        7. Homography coordinate transform + speed estimation (post-processing)

    Args:
        video_url: Public URL of the uploaded video (Vercel Blob)
        field_template: Field size — "9v9" (55m x 36m)

    Returns:
        ProcessingResult dict matching the TypeScript interface
    """
    import subprocess
    import os
    import random
    import requests
    import cv2
    import numpy as np
    from pathlib import Path
    from collections import defaultdict
    from ultralytics import YOLO
    from boxmot import BotSort
    from sklearn.cluster import KMeans
    import supervision as sv

    start_time = time.time()
    call_id = modal.current_function_call_id()
    d = modal.Dict.from_name("job-progress", create_if_missing=True)

    try:
        return _process_video_impl(
            video_url, field_template, start_time, call_id, d,
            subprocess, os, random, requests, cv2, np, Path,
            defaultdict, YOLO, BotSort, KMeans, sv,
        )
    except CalibrationFailureError as e:
        failure_payload = {
            "status": "failed",
            "stage": "error",
            "percent": 0,
            "error": str(e),
            "failure_code": e.code,
        }
        if e.summary is not None:
            failure_payload["calibration"] = e.summary
        print(f"[ERROR] Calibration failed: {str(e)[:200]}")
        d.put(call_id, failure_payload)
        raise
    except Exception as e:
        error_msg = f"{type(e).__name__}: {str(e)[:200]}"
        print(f"[ERROR] Pipeline failed: {error_msg}")
        d.put(call_id, {"status": "failed", "stage": "error", "percent": 0, "error": error_msg})
        raise


@app.function(
    gpu="A10G",
    image=image,
    timeout=3600,
    enable_memory_snapshot=True,
    scaledown_window=300,
)
def calibrate_video(video_url: str, field_template: str) -> dict:
    """Run only the PTZ calibration stage and return diagnostics."""
    import subprocess
    import os
    import requests
    import cv2
    import numpy as np

    start_time = time.time()
    call_id = modal.current_function_call_id()
    d = modal.Dict.from_name("job-progress", create_if_missing=True)

    def update_progress(stage: str, percent: int, **extras):
        payload = {"status": "processing", "stage": stage, "percent": percent}
        payload.update(extras)
        d.put(call_id, payload)

    try:
        video_info = _download_and_transcode_video(
            video_url, update_progress, requests, subprocess, os, cv2,
        )
        try:
            calibration_result = run_calibration_stage(
                transcoded_path=video_info["transcoded_path"],
                field_template=field_template,
                call_id=call_id,
                update_progress=update_progress,
                cv2=cv2,
                np=np,
            )
        finally:
            if os.path.exists(video_info["transcoded_path"]):
                os.remove(video_info["transcoded_path"])

        processing_time = time.time() - start_time
        d.put(call_id, {"status": "complete", "stage": "done", "percent": 100})
        return {
            "metadata": {
                "video_id": video_url.split("/")[-1].replace(".mp4", "").replace(".mov", ""),
                "fps": round(video_info["fps"], 2),
                "duration": round(video_info["duration"], 2),
                "frame_count": video_info["total_frames"],
                "field_template": field_template,
                "processing_time_seconds": round(processing_time, 1),
            },
            "calibration": calibration_result.summary,
        }
    except CalibrationFailureError as e:
        failure_payload = {
            "status": "failed",
            "stage": "error",
            "percent": 0,
            "error": str(e),
            "failure_code": e.code,
        }
        if e.summary is not None:
            failure_payload["calibration"] = e.summary
        print(f"[ERROR] Calibration failed: {str(e)[:200]}")
        d.put(call_id, failure_payload)
        raise
    except Exception as e:
        error_msg = f"{type(e).__name__}: {str(e)[:200]}"
        print(f"[ERROR] Calibration failed: {error_msg}")
        d.put(call_id, {"status": "failed", "stage": "error", "percent": 0, "error": error_msg})
        raise


def _process_video_impl(
    video_url, field_template, start_time, call_id, d,
    subprocess, os, random, requests, cv2, np, Path,
    defaultdict, YOLO, BotSort, KMeans, sv,
):
    """Internal implementation — wrapped by process_video for error handling."""

    # Field dimensions (meters)
    FIELD_W = 55.0 if field_template == "9v9" else 105.0
    FIELD_H = 36.0 if field_template == "9v9" else 68.0
    FIELD_MARGIN = 3.0  # meters margin for containment check
    CALIB_FIELD_W = 105.0
    CALIB_FIELD_H = 68.0
    FIELD_SCALE_X = FIELD_W / CALIB_FIELD_W
    FIELD_SCALE_Y = FIELD_H / CALIB_FIELD_H
    DETECTION_INTERVAL = 3  # run YOLO every Nth frame
    MAX_COLOR_SAMPLES = 500  # reservoir sampling cap
    BALL_CONF_THRESHOLD = 0.1   # low threshold for SAHI ball detection (small, often low-conf)
    BALL_SAHI_SLICE = 640       # SAHI tile size (ball becomes 30-50px within each tile)
    BALL_SAHI_OVERLAP = 128     # tile overlap in pixels (prevents missing balls at edges)
    BALL_BUFFER_SIZE = 10       # frames of ball position history for outlier rejection
    BALL_MAX_JUMP_PX = 350      # max pixels ball can move between detections
    BALL_MIN_SIZE_PX = 5        # minimum ball bbox dimension (filter noise)
    BALL_MAX_SIZE_PX = 80       # maximum ball bbox dimension (filter non-ball objects)

    def update_progress(stage: str, percent: int, **extras):
        payload = {"status": "processing", "stage": stage, "percent": percent}
        payload.update(extras)
        d.put(call_id, payload)

    # -----------------------------------------------------------------------
    # Stage 1: Download + Transcode
    # -----------------------------------------------------------------------
    video_info = _download_and_transcode_video(
        video_url, update_progress, requests, subprocess, os, cv2,
    )
    transcoded_path = video_info["transcoded_path"]
    fps = video_info["fps"]
    total_frames = video_info["total_frames"]
    width = video_info["width"]
    height = video_info["height"]
    duration = video_info["duration"]

    # -----------------------------------------------------------------------
    # Stage 2-3: Calibration hard gate
    # -----------------------------------------------------------------------
    calibration_result = run_calibration_stage(
        transcoded_path=transcoded_path,
        field_template=field_template,
        call_id=call_id,
        update_progress=update_progress,
        cv2=cv2,
        np=np,
    )
    frame_H = calibration_result.frame_homographies
    frame_valid = calibration_result.frame_valid
    frame_calibration_confidence = calibration_result.frame_confidence

    update_progress("detection", 35)

    # -----------------------------------------------------------------------
    # Initialize models
    # -----------------------------------------------------------------------
    yolo_model = YOLO("yolo26m.pt")
    yolo_model.to("cuda")

    tracker = BotSort(
        reid_weights=Path("osnet_x0_25_msmt17.pt"),
        device=0,
        half=True,
        cmc_method="ecc",
        track_buffer=60,  # ~2s at 30fps — covers most occlusions in soccer
    )

    # SAHI ball detector: runs YOLO on 640x640 tiles for small-object ball detection
    def detect_ball_sahi(frame):
        """Run tiled inference on a single frame for ball detection only.
        Returns sv.Detections with ball detections from all tiles merged via NMS.
        """
        def _ball_callback(image_slice):
            result = yolo_model(image_slice, classes=[32], conf=BALL_CONF_THRESHOLD,
                                imgsz=BALL_SAHI_SLICE, verbose=False)[0]
            return sv.Detections.from_ultralytics(result)

        slicer = sv.InferenceSlicer(
            callback=_ball_callback,
            slice_wh=(BALL_SAHI_SLICE, BALL_SAHI_SLICE),
            overlap_wh=(BALL_SAHI_OVERLAP, BALL_SAHI_OVERLAP),
            overlap_filter=sv.OverlapFilter.NON_MAX_SUPPRESSION,
            iou_threshold=0.1,  # very low — one ball exists, don't over-suppress tile duplicates
        )
        dets = slicer(frame)
        # Apply ball size filter
        if len(dets) > 0:
            bwidths = dets.xyxy[:, 2] - dets.xyxy[:, 0]
            bheights = dets.xyxy[:, 3] - dets.xyxy[:, 1]
            bsize_mask = (
                (bwidths >= BALL_MIN_SIZE_PX) & (bwidths <= BALL_MAX_SIZE_PX) &
                (bheights >= BALL_MIN_SIZE_PX) & (bheights <= BALL_MAX_SIZE_PX)
            )
            dets = dets[bsize_mask]
        return dets

    def pick_best_ball(ball_dets, ball_history_list):
        """From a set of ball detections, pick the best one using centroid tracking.
        Returns (center_x, center_y, confidence) or None.
        """
        if len(ball_dets) == 0 or ball_dets.confidence is None:
            return None
        centers = np.column_stack([
            (ball_dets.xyxy[:, 0] + ball_dets.xyxy[:, 2]) / 2,
            (ball_dets.xyxy[:, 1] + ball_dets.xyxy[:, 3]) / 2,
        ])
        if ball_history_list:
            centroid = np.mean(ball_history_list[-BALL_BUFFER_SIZE:], axis=0)
            dists = np.linalg.norm(centers - centroid, axis=1)
            best_idx = int(np.argmin(dists))
            if dists[best_idx] > BALL_MAX_JUMP_PX:
                return None
        else:
            best_idx = int(np.argmax(ball_dets.confidence))
        bx = float(centers[best_idx][0])
        by = float(centers[best_idx][1])
        conf = float(ball_dets.confidence[best_idx])
        ball_history_list.append([bx, by])
        if len(ball_history_list) > BALL_BUFFER_SIZE:
            ball_history_list.pop(0)
        return (bx, by, conf)

    # -----------------------------------------------------------------------
    # Stage 4-5: Detection + tracking pass
    # -----------------------------------------------------------------------
    # Per-frame data: { frame_idx: { track_id: (foot_x_px, foot_y_px, conf) } }
    frame_tracks = defaultdict(dict)

    # Color samples for team classification: { track_id: [hsv_histograms] }
    color_samples = defaultdict(list)

    # Ball positions: { frame_idx: (center_x_px, center_y_px, conf) }
    ball_positions = {}
    # Ball centroid tracker: recent positions for outlier rejection
    ball_history = []  # list of (center_x, center_y) from recent frames

    # Motion scores for halftime detection
    motion_scores = []

    detection_batch = []  # accumulate frames for YOLO batch inference
    detection_batch_indices = []
    raw_detection_total = 0
    filtered_detection_total = 0
    field_filtered_detection_total = 0
    tracker_output_total = 0

    frame_idx = 0
    cap = cv2.VideoCapture(transcoded_path)

    def extract_torso_hsv(frame_bgr, bbox):
        """Extract HSV histogram from upper half of bbox, masking green."""
        x1, y1, x2, y2 = int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])
        x1 = max(0, x1)
        y1 = max(0, y1)
        x2 = min(frame_bgr.shape[1], x2)
        y2 = min(frame_bgr.shape[0], y2)
        torso = frame_bgr[y1:y1 + (y2 - y1) // 2, x1:x2]
        if torso.size == 0:
            return None
        hsv = cv2.cvtColor(torso, cv2.COLOR_BGR2HSV)
        # Mask out grass-toned pixels before building a 2D hue/saturation histogram.
        keep_mask = ~(
            (hsv[:, :, 0] > 25) & (hsv[:, :, 0] < 85) &
            (hsv[:, :, 1] > 40) & (hsv[:, :, 2] > 40)
        )
        if int(np.count_nonzero(keep_mask)) < 10:
            return None
        selected = hsv[keep_mask]
        hist, _, _ = np.histogram2d(
            selected[:, 0],
            selected[:, 1],
            bins=[18, 8],
            range=[[0, 180], [0, 256]],
        )
        return hist.flatten() / (hist.sum() + 1e-8)

    def point_in_field(x_m, y_m):
        """Check if a field-coordinate point is within bounds + margin."""
        return (-FIELD_MARGIN <= x_m <= FIELD_W + FIELD_MARGIN and
                -FIELD_MARGIN <= y_m <= FIELD_H + FIELD_MARGIN)

    def map_calibration_field_to_board(x_calib, y_calib):
        """Convert calibration-space field coordinates to the downstream board.

        PnLCalib/camera projection conventions can differ between full-pitch
        top-left origin and pitch-centered origin. Try both and keep the first
        mapping that lands inside the downstream board.
        """
        base_candidates = [
            (x_calib, y_calib),
            (x_calib + CALIB_FIELD_W / 2.0, y_calib + CALIB_FIELD_H / 2.0),
        ]

        candidates = []
        for x_full, y_full in base_candidates:
            variants = [
                (x_full, y_full),
                (CALIB_FIELD_W - x_full, y_full),
                (x_full, CALIB_FIELD_H - y_full),
                (CALIB_FIELD_W - x_full, CALIB_FIELD_H - y_full),
                (y_full, x_full),
                (CALIB_FIELD_W - y_full, x_full),
                (y_full, CALIB_FIELD_H - x_full),
                (CALIB_FIELD_W - y_full, CALIB_FIELD_H - x_full),
            ]
            for variant in variants:
                if variant not in candidates:
                    candidates.append(variant)

        for x_full, y_full in candidates:
            board_x = x_full * FIELD_SCALE_X
            board_y = y_full * FIELD_SCALE_Y
            if point_in_field(board_x, board_y):
                return board_x, board_y

        # Fall back to the top-left-origin interpretation for diagnostics.
        return candidates[0][0] * FIELD_SCALE_X, candidates[0][1] * FIELD_SCALE_Y

    def get_effective_frame_homography(frame_index, max_offset=DETECTION_INTERVAL):
        if 0 <= frame_index < len(frame_valid) and frame_valid[frame_index]:
            return frame_H[frame_index], float(frame_calibration_confidence[frame_index]), frame_index

        for offset in range(1, max_offset + 1):
            prev_idx = frame_index - offset
            next_idx = frame_index + offset
            if prev_idx >= 0 and frame_valid[prev_idx]:
                return frame_H[prev_idx], float(frame_calibration_confidence[prev_idx]), prev_idx
            if next_idx < len(frame_valid) and frame_valid[next_idx]:
                return frame_H[next_idx], float(frame_calibration_confidence[next_idx]), next_idx

        return None, None, None

    def apply_homography(H, px, py):
        """Apply 3x3 homography to a pixel point, return field coords."""
        pt = np.array([px, py, 1.0], dtype=np.float32)
        result = H @ pt
        if abs(result[2]) < 1e-10:
            return None, None
        return float(result[0] / result[2]), float(result[1] / result[2])

    def filter_detections_to_field(detections, frame_index):
        if len(detections) == 0:
            return detections
        H, _calibration_conf, _used_idx = get_effective_frame_homography(frame_index)
        if H is None:
            return detections

        keep = []
        for xyxy in detections.xyxy:
            foot_x = float((xyxy[0] + xyxy[2]) / 2.0)
            foot_y = float(xyxy[3])
            field_x_calib, field_y_calib = apply_homography(H, foot_x, foot_y)
            if field_x_calib is None:
                keep.append(False)
                continue
            board_x, board_y = map_calibration_field_to_board(field_x_calib, field_y_calib)
            keep.append(point_in_field(board_x, board_y))

        keep = np.asarray(keep, dtype=bool)
        return detections[keep]

    # Process each frame
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % int(fps) == 0 and frame_idx > 0:
            prev_idx = max(0, frame_idx - int(fps))
            if frame_valid[frame_idx] and frame_valid[prev_idx]:
                projected_now = _project_points_to_image(frame_H[frame_idx], np.array([[FIELD_W / 2.0, FIELD_H / 2.0]], dtype=np.float32), cv2, np)
                projected_prev = _project_points_to_image(frame_H[prev_idx], np.array([[FIELD_W / 2.0, FIELD_H / 2.0]], dtype=np.float32), cv2, np)
                if projected_now is not None and projected_prev is not None:
                    score = float(np.linalg.norm(projected_now[0] - projected_prev[0]))
                    motion_scores.append((frame_idx / fps, score))

        # --- YOLO detection + tracking (every 3rd frame) ---
        if frame_idx % DETECTION_INTERVAL == 0:
            detection_batch.append(frame)
            detection_batch_indices.append(frame_idx)

            # Process in batches of 8
            if len(detection_batch) >= 8:
                # --- Pass 1: Player detection (standard YOLO at 1088px) ---
                results = yolo_model(detection_batch, classes=[0], conf=0.25, imgsz=1088, verbose=False)
                for batch_i, result in enumerate(results):
                    fidx = detection_batch_indices[batch_i]
                    detections = sv.Detections.from_ultralytics(result)
                    raw_detection_total += len(detections)

                    # Filter by bbox size and aspect ratio (players only)
                    if len(detections) > 0:
                        heights = detections.xyxy[:, 3] - detections.xyxy[:, 1]
                        widths = detections.xyxy[:, 2] - detections.xyxy[:, 0]
                        ratios = heights / (widths + 1e-6)
                        size_mask = (heights > 30) & (heights < 500) & (ratios > 1.2) & (ratios < 4.0)
                        detections = detections[size_mask]
                    filtered_detection_total += len(detections)
                    if len(detections) > 0:
                        detections = filter_detections_to_field(detections, fidx)
                    field_filtered_detection_total += len(detections)

                    if len(detections) > 0:
                        # Format for BoT-SORT: [x1, y1, x2, y2, conf, class_id]
                        det_array = np.column_stack([
                            detections.xyxy,
                            detections.confidence,
                            np.zeros(len(detections)),  # class_id = 0 (person)
                        ]).astype(np.float32)

                        tracks_output = tracker.update(det_array, detection_batch[batch_i])
                        tracker_output_total += len(tracks_output)

                        for track in tracks_output:
                            x1, y1, x2, y2, track_id, conf = track[0], track[1], track[2], track[3], int(track[4]), float(track[5])
                            foot_x = (x1 + x2) / 2
                            foot_y = y2  # bottom of bbox

                            frame_tracks[fidx][track_id] = (foot_x, foot_y, conf)

                            # Collect color sample (reservoir sampling)
                            if len(color_samples[track_id]) < MAX_COLOR_SAMPLES:
                                hist = extract_torso_hsv(detection_batch[batch_i], (x1, y1, x2, y2))
                                if hist is not None:
                                    color_samples[track_id].append(hist)
                            else:
                                # Reservoir: replace with decreasing probability
                                j = random.randint(0, frame_idx)
                                if j < MAX_COLOR_SAMPLES:
                                    hist = extract_torso_hsv(detection_batch[batch_i], (x1, y1, x2, y2))
                                    if hist is not None:
                                        color_samples[track_id][j] = hist
                    else:
                        # No detections — still update tracker with empty
                        tracker.update(np.empty((0, 6), dtype=np.float32), detection_batch[batch_i])

                # --- Pass 2: Ball detection via SAHI tiled inference ---
                for batch_i in range(len(detection_batch)):
                    fidx = detection_batch_indices[batch_i]
                    if fidx not in ball_positions:  # skip if already found by previous method
                        ball_dets = detect_ball_sahi(detection_batch[batch_i])
                        result = pick_best_ball(ball_dets, ball_history)
                        if result is not None:
                            ball_positions[fidx] = result

                detection_batch = []
                detection_batch_indices = []

        # Progress update every 5%
            if frame_idx % max(1, total_frames // 20) == 0:
                pct = 10 + int(60 * frame_idx / total_frames)  # 10-70%
                update_progress(
                    "detection",
                    min(pct, 70),
                    raw_detection_total=raw_detection_total,
                    filtered_detection_total=filtered_detection_total,
                    field_filtered_detection_total=field_filtered_detection_total,
                    tracker_output_total=tracker_output_total,
                )

        frame_idx += 1

    # Flush remaining detection batch (same two-pass approach)
    if detection_batch:
        # Pass 1: Players
        results = yolo_model(detection_batch, classes=[0], conf=0.25, imgsz=1088, verbose=False)
        for batch_i, result in enumerate(results):
            fidx = detection_batch_indices[batch_i]
            detections = sv.Detections.from_ultralytics(result)
            raw_detection_total += len(detections)
            if len(detections) > 0:
                heights = detections.xyxy[:, 3] - detections.xyxy[:, 1]
                widths = detections.xyxy[:, 2] - detections.xyxy[:, 0]
                ratios = heights / (widths + 1e-6)
                size_mask = (heights > 30) & (heights < 500) & (ratios > 1.2) & (ratios < 4.0)
                detections = detections[size_mask]
            filtered_detection_total += len(detections)
            if len(detections) > 0:
                detections = filter_detections_to_field(detections, fidx)
            field_filtered_detection_total += len(detections)
            if len(detections) > 0:
                det_array = np.column_stack([
                    detections.xyxy,
                    detections.confidence,
                    np.zeros(len(detections)),
                ]).astype(np.float32)
                tracks_output = tracker.update(det_array, detection_batch[batch_i])
                tracker_output_total += len(tracks_output)
                for track in tracks_output:
                    x1, y1, x2, y2, track_id, conf = track[0], track[1], track[2], track[3], int(track[4]), float(track[5])
                    frame_tracks[fidx][track_id] = ((x1 + x2) / 2, y2, conf)

        # Pass 2: Ball via SAHI
        for batch_i in range(len(detection_batch)):
            fidx = detection_batch_indices[batch_i]
            if fidx not in ball_positions:
                ball_dets = detect_ball_sahi(detection_batch[batch_i])
                result = pick_best_ball(ball_dets, ball_history)
                if result is not None:
                    ball_positions[fidx] = result

    cap.release()
    os.remove(transcoded_path)

    update_progress("classification", 75)

    # -----------------------------------------------------------------------
    # Stage 6: Team Classification (K-Means, post-processing)
    # -----------------------------------------------------------------------
    all_track_ids = set()
    for ft in frame_tracks.values():
        all_track_ids.update(ft.keys())

    track_team = {}  # track_id → team label

    if color_samples:
        # Build feature matrix: average histogram per track
        track_ids_with_color = []
        features = []
        for tid in sorted(all_track_ids):
            samples = color_samples.get(tid, [])
            if len(samples) >= 3:
                avg_hist = np.mean(samples, axis=0)
                features.append(avg_hist)
                track_ids_with_color.append(tid)

        if len(features) >= 4:
            X = np.array(features)
            kmeans = KMeans(n_clusters=min(4, len(features)), n_init=10, random_state=42)
            labels = kmeans.fit_predict(X)

            # Count tracks per cluster
            cluster_counts = defaultdict(int)
            for label in labels:
                cluster_counts[int(label)] += 1

            # Sort clusters by size: two largest = home/away, smallest = referee
            sorted_clusters = sorted(cluster_counts.items(), key=lambda x: x[1], reverse=True)
            cluster_to_team = {}
            if len(sorted_clusters) >= 2:
                cluster_to_team[sorted_clusters[0][0]] = "home"
                cluster_to_team[sorted_clusters[1][0]] = "away"
            if len(sorted_clusters) >= 3:
                cluster_to_team[sorted_clusters[-1][0]] = "referee"

            # Assign majority vote per track
            track_labels = defaultdict(list)
            for i, tid in enumerate(track_ids_with_color):
                track_labels[tid].append(int(labels[i]))

            for tid, lbl_list in track_labels.items():
                majority = max(set(lbl_list), key=lbl_list.count)
                track_team[tid] = cluster_to_team.get(majority, "unknown")

    # Default: unknown for tracks without enough color data
    for tid in all_track_ids:
        if tid not in track_team:
            track_team[tid] = "unknown"

    update_progress("transform", 85)

    # -----------------------------------------------------------------------
    # Stage 7: Coordinate Transform (post-processing)
    # -----------------------------------------------------------------------
    # Build output tracks: { track_id: [keyframes] }
    output_tracks = defaultdict(list)
    mapped_keyframe_total = 0
    rejected_offfield_total = 0
    reused_homography_total = 0
    projection_debug = {
        "calib_x_min": None,
        "calib_x_max": None,
        "calib_y_min": None,
        "calib_y_max": None,
        "board_x_min": None,
        "board_x_max": None,
        "board_y_min": None,
        "board_y_max": None,
        "samples": [],
    }

    def update_range(key_min, key_max, value):
        current_min = projection_debug[key_min]
        current_max = projection_debug[key_max]
        projection_debug[key_min] = value if current_min is None else min(current_min, value)
        projection_debug[key_max] = value if current_max is None else max(current_max, value)

    for fidx in sorted(frame_tracks.keys()):
        t_sec = fidx / fps
        H, calibration_conf, used_frame_idx = get_effective_frame_homography(fidx)
        if H is None:
            continue
        if used_frame_idx != fidx:
            reused_homography_total += 1

        for track_id, (foot_x, foot_y, conf) in frame_tracks[fidx].items():
            field_x_calib, field_y_calib = apply_homography(H, foot_x, foot_y)
            if field_x_calib is None:
                continue
            update_range("calib_x_min", "calib_x_max", float(field_x_calib))
            update_range("calib_y_min", "calib_y_max", float(field_y_calib))
            field_x, field_y = map_calibration_field_to_board(field_x_calib, field_y_calib)
            update_range("board_x_min", "board_x_max", float(field_x))
            update_range("board_y_min", "board_y_max", float(field_y))
            if len(projection_debug["samples"]) < 12:
                projection_debug["samples"].append({
                    "frame": int(fidx),
                    "track_id": int(track_id),
                    "pixel_x": round(float(foot_x), 2),
                    "pixel_y": round(float(foot_y), 2),
                    "calib_x": round(float(field_x_calib), 2),
                    "calib_y": round(float(field_y_calib), 2),
                    "board_x": round(float(field_x), 2),
                    "board_y": round(float(field_y), 2),
                    "in_field": bool(point_in_field(field_x, field_y)),
                    "homography_frame": int(used_frame_idx),
                })
            if not point_in_field(field_x, field_y):
                rejected_offfield_total += 1
                continue
            field_x = max(0, min(FIELD_W, field_x))
            field_y = max(0, min(FIELD_H, field_y))
            effective_conf = conf * calibration_conf

            mapped_keyframe_total += 1
            output_tracks[track_id].append({
                "time": round(t_sec, 3),
                "x": round(float(field_x), 2),
                "y": round(float(field_y), 2),
                "confidence": round(float(effective_conf), 3),
            })

    # -----------------------------------------------------------------------
    # Ball coordinate transform (post-processing)
    # -----------------------------------------------------------------------
    ball_output = []
    for fidx in sorted(ball_positions.keys()):
        t_sec = fidx / fps
        bx_px, by_px, bconf = ball_positions[fidx]
        H, calibration_conf, used_frame_idx = get_effective_frame_homography(fidx)
        if H is None:
            continue
        field_x_calib, field_y_calib = apply_homography(H, bx_px, by_px)
        if field_x_calib is None:
            continue
        field_x, field_y = map_calibration_field_to_board(field_x_calib, field_y_calib)
        if not point_in_field(field_x, field_y):
            continue
        field_x = max(0, min(FIELD_W, field_x))
        field_y = max(0, min(FIELD_H, field_y))
        bconf *= calibration_conf

        ball_output.append({
            "frame": fidx,
            "time": round(t_sec, 3),
            "x": round(float(field_x), 2),
            "y": round(float(field_y), 2),
            "confidence": round(float(bconf), 3),
            "interpolated": False,
        })

    # -----------------------------------------------------------------------
    # Ball trajectory interpolation (fill gaps < 1 second)
    # -----------------------------------------------------------------------
    MAX_INTERP_GAP = int(fps)  # 1 second — safe for continuous play
    if len(ball_output) >= 2:
        interpolated_ball = [ball_output[0]]
        for i in range(1, len(ball_output)):
            prev = ball_output[i - 1]
            curr = ball_output[i]
            gap_frames = curr["frame"] - prev["frame"]

            if gap_frames > DETECTION_INTERVAL and gap_frames <= MAX_INTERP_GAP:
                # Linear interpolation for short gaps
                for f in range(prev["frame"] + DETECTION_INTERVAL,
                               curr["frame"], DETECTION_INTERVAL):
                    alpha = (f - prev["frame"]) / gap_frames
                    interpolated_ball.append({
                        "frame": f,
                        "time": round(f / fps, 3),
                        "x": round(prev["x"] + alpha * (curr["x"] - prev["x"]), 2),
                        "y": round(prev["y"] + alpha * (curr["y"] - prev["y"]), 2),
                        "confidence": round(
                            min(prev["confidence"], curr["confidence"]) * 0.7, 3),
                        "interpolated": True,
                    })

            interpolated_ball.append(curr)

        ball_output = interpolated_ball

    update_progress("transform", 92)

    # -----------------------------------------------------------------------
    # Halftime Detection (post-processing)
    # -----------------------------------------------------------------------
    HALFTIME_THRESHOLD = 3.0
    HALFTIME_MIN_DURATION = 300  # 5 minutes
    halftime_start = None
    best_start, best_len = None, 0
    run_start, run_len = None, 0

    for timestamp, score in motion_scores:
        if score < HALFTIME_THRESHOLD:
            if run_start is None:
                run_start = timestamp
            run_len = timestamp - run_start
        else:
            if run_len > best_len and run_len > HALFTIME_MIN_DURATION:
                best_start, best_len = run_start, run_len
            run_start, run_len = None, 0

    # Check final run
    if run_len > best_len and run_len > HALFTIME_MIN_DURATION:
        best_start = run_start

    halftime_start = best_start

    # Build periods
    if halftime_start is not None:
        halftime_end = halftime_start + best_len
        periods = [
            {"start_time": 0, "end_time": round(halftime_start, 1)},
            {"start_time": round(halftime_end, 1), "end_time": round(duration, 1)},
        ]
    else:
        periods = [{"start_time": 0, "end_time": round(duration, 1)}]

    update_progress("transform", 98)

    # -----------------------------------------------------------------------
    # Speed estimation (post-processing)
    # -----------------------------------------------------------------------
    # For each track, compute speed (m/s and km/h) from consecutive positions.
    # Smoothed over a 1-second window to reduce jitter from detection noise.
    SPEED_WINDOW = max(1, int(fps / DETECTION_INTERVAL))  # ~10 frames at 30fps/3

    for track_id, keyframes in output_tracks.items():
        if len(keyframes) < 2:
            continue

        # Compute instantaneous speed between consecutive keyframes
        speeds = [0.0]  # first frame has no speed
        for i in range(1, len(keyframes)):
            prev_kf = keyframes[i - 1]
            curr_kf = keyframes[i]
            dt = curr_kf["time"] - prev_kf["time"]
            if dt > 0:
                dx = curr_kf["x"] - prev_kf["x"]
                dy = curr_kf["y"] - prev_kf["y"]
                dist = (dx ** 2 + dy ** 2) ** 0.5
                speed_ms = dist / dt
                # Cap at realistic max player speed (12 m/s ≈ 43 km/h sprint)
                speed_ms = min(speed_ms, 12.0)
                speeds.append(speed_ms)
            else:
                speeds.append(speeds[-1] if speeds else 0.0)

        # Smooth with rolling average (1-second window)
        smoothed = []
        for i in range(len(speeds)):
            window_start = max(0, i - SPEED_WINDOW + 1)
            window = speeds[window_start:i + 1]
            smoothed.append(sum(window) / len(window))

        # Add speed to each keyframe
        for i, kf in enumerate(keyframes):
            kf["speed_ms"] = round(smoothed[i], 2)
            kf["speed_kmh"] = round(smoothed[i] * 3.6, 1)

    # -----------------------------------------------------------------------
    # Build output
    # -----------------------------------------------------------------------
    # Track-level stats: total distance, avg/max speed
    tracks_list = []
    for track_id in sorted(output_tracks.keys()):
        keyframes = output_tracks[track_id]
        if len(keyframes) < 3:
            continue  # skip very short tracks (noise)

        # Compute total distance covered
        total_distance = 0.0
        max_speed = 0.0
        for i in range(1, len(keyframes)):
            dx = keyframes[i]["x"] - keyframes[i - 1]["x"]
            dy = keyframes[i]["y"] - keyframes[i - 1]["y"]
            total_distance += (dx ** 2 + dy ** 2) ** 0.5
            if keyframes[i].get("speed_ms", 0) > max_speed:
                max_speed = keyframes[i]["speed_ms"]

        avg_speed = 0.0
        speed_values = [kf.get("speed_ms", 0) for kf in keyframes if kf.get("speed_ms", 0) > 0]
        if speed_values:
            avg_speed = sum(speed_values) / len(speed_values)

        tracks_list.append({
            "player_id": f"track_{track_id}",
            "team": track_team.get(track_id, "unknown"),
            "keyframes": keyframes,
            "stats": {
                "total_distance_m": round(total_distance, 1),
                "avg_speed_kmh": round(avg_speed * 3.6, 1),
                "max_speed_kmh": round(max_speed * 3.6, 1),
            },
        })

    processing_time = time.time() - start_time

    d.put(call_id, {"status": "complete", "stage": "done", "percent": 100})

    return {
        "metadata": {
            "video_id": video_url.split("/")[-1].replace(".mp4", "").replace(".mov", ""),
            "fps": round(fps, 2),
            "detection_fps": round(fps / DETECTION_INTERVAL, 2),
            "duration": round(duration, 2),
            "frame_count": total_frames,
            "field_template": field_template,
            "periods": periods,
            "processing_time_seconds": round(processing_time, 1),
            "detector_model": "yolo26m",
            "imgsz": 1088,
            "calibration": calibration_result.summary,
            "debug_counts": {
                "raw_detection_total": raw_detection_total,
                "filtered_detection_total": filtered_detection_total,
                "field_filtered_detection_total": field_filtered_detection_total,
                "tracker_output_total": tracker_output_total,
                "mapped_keyframe_total": mapped_keyframe_total,
                "rejected_offfield_total": rejected_offfield_total,
                "reused_homography_total": reused_homography_total,
            },
            "debug_projection": projection_debug,
        },
        "tracks": tracks_list,
        "ball": ball_output,
    }
