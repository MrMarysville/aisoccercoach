"""
Soccer Video Analysis — Modal App

FastAPI web endpoints for job submission + status polling.
GPU function for 7-stage video processing pipeline.

Deploy: modal deploy modal_app.py
"""

import modal
import fastapi
from fastapi.responses import JSONResponse
import time

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
# ---------------------------------------------------------------------------

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
        return JSONResponse({"error": str(e)}, status_code=500)


web_image = modal.Image.debian_slim(python_version="3.11").pip_install("fastapi[standard]")


@app.function(image=web_image)
@modal.concurrent(max_inputs=100)
@modal.asgi_app()
def fastapi_app():
    return web_app


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

    # Field dimensions (meters)
    FIELD_W = 55.0 if field_template == "9v9" else 105.0
    FIELD_H = 36.0 if field_template == "9v9" else 68.0
    FIELD_MARGIN = 3.0  # meters margin for containment check
    DETECTION_INTERVAL = 3  # run YOLO every Nth frame
    CALIBRATION_INTERVAL = 30  # run PnLCalib every Nth frame
    ECC_DOWNSAMPLE = (640, 360)  # downsample for ECC speed
    MAX_COLOR_SAMPLES = 500  # reservoir sampling cap
    BALL_CONF_THRESHOLD = 0.1   # low threshold for SAHI ball detection (small, often low-conf)
    BALL_SAHI_SLICE = 640       # SAHI tile size (ball becomes 30-50px within each tile)
    BALL_SAHI_OVERLAP = 128     # tile overlap in pixels (prevents missing balls at edges)
    BALL_BUFFER_SIZE = 10       # frames of ball position history for outlier rejection
    BALL_MAX_JUMP_PX = 350      # max pixels ball can move between detections
    BALL_MIN_SIZE_PX = 5        # minimum ball bbox dimension (filter noise)
    BALL_MAX_SIZE_PX = 80       # maximum ball bbox dimension (filter non-ball objects)

    def update_progress(stage: str, percent: int):
        d.put(call_id, {"status": "processing", "stage": stage, "percent": percent})

    # -----------------------------------------------------------------------
    # Stage 1: Download + Transcode
    # -----------------------------------------------------------------------
    update_progress("transcoding", 2)

    input_path = "/tmp/input_video"
    transcoded_path = "/tmp/transcoded.mp4"

    # Download video from Vercel Blob
    resp = requests.get(video_url, stream=True)
    resp.raise_for_status()
    with open(input_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=8 * 1024 * 1024):
            f.write(chunk)

    update_progress("transcoding", 5)

    # Transcode to H.264 (XBotGo Falcon may export H.265)
    subprocess.run([
        "ffmpeg", "-y", "-i", input_path,
        "-c:v", "libx264", "-preset", "ultrafast",
        "-an",  # strip audio
        transcoded_path,
    ], check=True, capture_output=True)

    os.remove(input_path)

    cap = cv2.VideoCapture(transcoded_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    duration = total_frames / fps

    update_progress("transcoding", 8)

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
            iou_threshold=0.3,
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

    # Try to load PnLCalib models (may fail if repo structure differs)
    pnlcalib_available = False
    try:
        import yaml as pyyaml
        import torch
        from model.cls_hrnet import get_cls_net
        from model.cls_hrnet_l import get_cls_net as get_cls_net_l
        from utils.utils_calib import FramebyFrameCalib
        from inference import inference as pnl_inference

        cfg = pyyaml.safe_load(open("/opt/PnLCalib/config/hrnetv2_w48.yaml"))
        kp_model = get_cls_net(cfg)
        kp_model.load_state_dict(torch.load("/opt/PnLCalib/weights/SV_kp", map_location="cuda:0"))
        kp_model.to("cuda:0").eval()

        cfg_l = pyyaml.safe_load(open("/opt/PnLCalib/config/hrnetv2_w48_l.yaml"))
        line_model = get_cls_net_l(cfg_l)
        line_model.load_state_dict(torch.load("/opt/PnLCalib/weights/SV_lines", map_location="cuda:0"))
        line_model.to("cuda:0").eval()

        pnlcalib_available = True
    except Exception as e:
        print(f"[WARN] PnLCalib not available, using ECC-only calibration: {e}")

    update_progress("camera_motion", 10)

    # -----------------------------------------------------------------------
    # Stage 2-5: Single-pass processing
    # -----------------------------------------------------------------------
    # Accumulators
    prev_gray = None
    H_accumulated = np.eye(3, dtype=np.float32)  # chains ECC per-frame
    H_anchor = None  # last successful PnLCalib homography (pixel → field)
    H_anchor_frame = -1
    last_good_H = None  # the current best pixel→field homography

    # Per-frame data: { frame_idx: { track_id: (foot_x_px, foot_y_px, conf) } }
    frame_tracks = defaultdict(dict)
    frame_H = {}  # { frame_idx: 3x3 homography matrix }
    frame_confidence = {}  # { frame_idx: bool (True = high confidence H) }

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

    frame_idx = 0
    processed_detection_frames = 0

    def estimate_ecc(prev_g, curr_g):
        """ECC camera motion: returns 3x3 homography."""
        warp = np.eye(3, 3, dtype=np.float32)
        criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6)
        try:
            _, warp = cv2.findTransformECC(
                prev_g.astype(np.float32),
                curr_g.astype(np.float32),
                warp, cv2.MOTION_HOMOGRAPHY, criteria,
            )
        except cv2.error:
            pass  # convergence failure → identity
        return warp

    def calibrate_pnlcalib(frame_bgr):
        """Run PnLCalib. Returns 3x3 pixel→field homography or None."""
        if not pnlcalib_available:
            return None
        try:
            cam = FramebyFrameCalib(iwidth=frame_bgr.shape[1], iheight=frame_bgr.shape[0])
            pnl_inference(cam, frame_bgr, kp_model, line_model,
                          kp_threshold=0.1486, line_threshold=0.3886, pnl_refine=True)
            result = cam.heuristic_voting(refine_lines=True)
            if result is None or "cam_params" not in result:
                return None
            # Derive homography from camera parameters
            cp = result["cam_params"]
            # PnLCalib gives K (intrinsic) and R, t (extrinsic)
            # H_field = K @ [r1 | r2 | t] maps field (z=0) → pixel
            # We invert to get pixel → field
            K = np.array(cp.get("K", np.eye(3)), dtype=np.float32).reshape(3, 3)
            R = np.array(cp.get("rotation", np.eye(3)), dtype=np.float32).reshape(3, 3)
            t = np.array(cp.get("position", [0, 0, 0]), dtype=np.float32).reshape(3, 1)
            H_field2pixel = K @ np.hstack([R[:, :2], t])
            H_pixel2field = np.linalg.inv(H_field2pixel)
            return H_pixel2field.astype(np.float32)
        except Exception as e:
            print(f"[WARN] PnLCalib failed on frame: {e}")
            return None

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
        # Mask out green pixels (grass)
        mask = ~((hsv[:, :, 0] > 25) & (hsv[:, :, 0] < 85) &
                 (hsv[:, :, 1] > 40) & (hsv[:, :, 2] > 40))
        pixels = hsv[mask]
        if len(pixels) < 10:
            return None
        hist = cv2.calcHist([pixels], [0, 1], None, [18, 8], [0, 180, 0, 256])
        return hist.flatten() / (hist.sum() + 1e-8)

    def point_in_field(x_m, y_m):
        """Check if a field-coordinate point is within bounds + margin."""
        return (-FIELD_MARGIN <= x_m <= FIELD_W + FIELD_MARGIN and
                -FIELD_MARGIN <= y_m <= FIELD_H + FIELD_MARGIN)

    def apply_homography(H, px, py):
        """Apply 3x3 homography to a pixel point, return field coords."""
        pt = np.array([px, py, 1.0], dtype=np.float32)
        result = H @ pt
        if abs(result[2]) < 1e-10:
            return None, None
        return float(result[0] / result[2]), float(result[1] / result[2])

    # Process each frame
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        # Downsample for ECC
        gray_small = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray_small = cv2.resize(gray_small, ECC_DOWNSAMPLE)

        # --- ECC camera motion (every frame) ---
        if prev_gray is not None:
            H_frame = estimate_ecc(prev_gray, gray_small)
            H_accumulated = H_frame @ H_accumulated

            # Motion score for halftime detection (1fps sampling)
            if frame_idx % int(fps) == 0:
                score = float(np.mean(cv2.absdiff(gray_small, prev_gray)))
                motion_scores.append((frame_idx / fps, score))

        prev_gray = gray_small

        # --- PnLCalib calibration (every 30th frame) ---
        if frame_idx % CALIBRATION_INTERVAL == 0:
            H_calib = calibrate_pnlcalib(frame)
            if H_calib is not None:
                H_anchor = H_calib
                H_anchor_frame = frame_idx
                H_accumulated = np.eye(3, dtype=np.float32)  # reset accumulation
                last_good_H = H_anchor
                frame_confidence[frame_idx] = True
            else:
                frame_confidence[frame_idx] = False

        # Compute current frame's pixel→field homography
        if H_anchor is not None:
            # H_pixel2field = H_anchor @ inv(H_accumulated)
            # Because H_accumulated maps anchor→current in pixel space
            try:
                current_H = H_anchor @ np.linalg.inv(H_accumulated)
                last_good_H = current_H
                gap = frame_idx - H_anchor_frame
                frame_confidence[frame_idx] = gap < 300  # < 10 seconds
            except np.linalg.LinAlgError:
                current_H = last_good_H
                frame_confidence[frame_idx] = False
        else:
            current_H = last_good_H
            frame_confidence[frame_idx] = False

        if current_H is not None:
            frame_H[frame_idx] = current_H.copy()

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

                    # Filter by bbox size and aspect ratio (players only)
                    if len(detections) > 0:
                        heights = detections.xyxy[:, 3] - detections.xyxy[:, 1]
                        widths = detections.xyxy[:, 2] - detections.xyxy[:, 0]
                        ratios = heights / (widths + 1e-6)
                        size_mask = (heights > 30) & (heights < 500) & (ratios > 1.2) & (ratios < 4.0)
                        detections = detections[size_mask]

                    if len(detections) > 0:
                        # Format for BoT-SORT: [x1, y1, x2, y2, conf, class_id]
                        det_array = np.column_stack([
                            detections.xyxy,
                            detections.confidence,
                            np.zeros(len(detections)),  # class_id = 0 (person)
                        ]).astype(np.float32)

                        tracks_output = tracker.update(det_array, detection_batch[batch_i])

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
            update_progress("detection", min(pct, 70))

        frame_idx += 1

    # Flush remaining detection batch (same two-pass approach)
    if detection_batch:
        # Pass 1: Players
        results = yolo_model(detection_batch, classes=[0], conf=0.25, imgsz=1088, verbose=False)
        for batch_i, result in enumerate(results):
            fidx = detection_batch_indices[batch_i]
            detections = sv.Detections.from_ultralytics(result)
            if len(detections) > 0:
                heights = detections.xyxy[:, 3] - detections.xyxy[:, 1]
                widths = detections.xyxy[:, 2] - detections.xyxy[:, 0]
                ratios = heights / (widths + 1e-6)
                size_mask = (heights > 30) & (heights < 500) & (ratios > 1.2) & (ratios < 4.0)
                detections = detections[size_mask]
            if len(detections) > 0:
                det_array = np.column_stack([
                    detections.xyxy,
                    detections.confidence,
                    np.zeros(len(detections)),
                ]).astype(np.float32)
                tracks_output = tracker.update(det_array, detection_batch[batch_i])
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

    for fidx in sorted(frame_tracks.keys()):
        t_sec = fidx / fps
        H = frame_H.get(fidx)
        is_confident = frame_confidence.get(fidx, False)

        for track_id, (foot_x, foot_y, conf) in frame_tracks[fidx].items():
            if H is not None:
                field_x, field_y = apply_homography(H, foot_x, foot_y)
                if field_x is None:
                    continue
                # Clamp to field bounds
                field_x = max(0, min(FIELD_W, field_x))
                field_y = max(0, min(FIELD_H, field_y))
                # Primary filter: must be within field + margin
                if not point_in_field(field_x, field_y):
                    continue
                effective_conf = conf if is_confident else conf * 0.5
            else:
                # No homography — use normalized pixel position as rough estimate
                field_x = (foot_x / width) * FIELD_W
                field_y = (foot_y / height) * FIELD_H
                effective_conf = conf * 0.3

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
        H = frame_H.get(fidx)

        if H is not None:
            field_x, field_y = apply_homography(H, bx_px, by_px)
            if field_x is None:
                continue
            field_x = max(0, min(FIELD_W, field_x))
            field_y = max(0, min(FIELD_H, field_y))
            if not point_in_field(field_x, field_y):
                continue
        else:
            field_x = (bx_px / width) * FIELD_W
            field_y = (by_px / height) * FIELD_H
            bconf *= 0.3

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
        },
        "tracks": tracks_list,
        "ball": ball_output,
    }
