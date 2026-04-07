"""
Soccer Video Analysis — Modal App

FastAPI web endpoints for job submission + status polling.
GPU function for video processing (mock in v1, real CV pipeline in v2).

Deploy: modal deploy modal_app.py
"""

import modal
import fastapi
from fastapi.responses import JSONResponse
import time
import random

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
        "supervision>=0.26.0",
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
        # Pre-download YOLO weights
        'python -c "from ultralytics import YOLO; YOLO(\'yolo11n.pt\')"',
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
    call = fn.spawn(video_url, field_template)
    call_id = call.object_id

    progress_dict.put(call_id, {
        "status": "processing",
        "stage": "starting",
        "percent": 0,
    })

    return {"call_id": call_id}


@web_app.get("/status/{call_id}")
async def poll_status(call_id: str):
    """Return current progress from modal.Dict. Cheap — no GPU cost."""
    state = progress_dict.get(call_id, default=None)
    if state is None:
        return JSONResponse({"status": "unknown"}, status_code=404)
    return state


@web_app.get("/result/{call_id}")
async def poll_result(call_id: str):
    """Return 202 if still running, 200 with result if done."""
    function_call = modal.FunctionCall.from_id(call_id)
    try:
        result = function_call.get(timeout=0)
        return result
    except TimeoutError:
        return JSONResponse({"status": "processing"}, status_code=202)


@app.function()
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
    """Process a soccer match video and return tracking data.

    Currently returns mock data for end-to-end testing.
    Real 7-stage CV pipeline will replace this in Task 15.

    Args:
        video_url: Public URL of the uploaded video (Vercel Blob)
        field_template: Field size — always "9v9" for now

    Returns:
        ProcessingResult dict matching the TypeScript interface
    """
    call_id = modal.current_function_call_id()
    d = modal.Dict.from_name("job-progress", create_if_missing=True)

    # Simulate processing stages with progress updates
    stages = [
        ("transcoding", 5),
        ("camera_motion", 15),
        ("field_calibration", 30),
        ("detection", 45),
        ("tracking", 70),
        ("classification", 85),
        ("transform", 95),
    ]

    for stage_name, percent in stages:
        d.put(call_id, {
            "status": "processing",
            "stage": stage_name,
            "percent": percent,
        })
        time.sleep(2)  # Simulate work (~14s total)

    # Generate mock player tracking data
    # 18 players (9 home + 9 away), 10fps over 10 minutes
    tracks = []
    for i in range(18):
        team = "home" if i < 9 else "away"
        keyframes = []

        # Start position — spread across the field
        base_x = random.uniform(5, 50)
        base_y = random.uniform(5, 31)

        for t in range(0, 600):  # 600 seconds = 10 minutes, 1 keyframe/sec
            # Random walk around base position
            x = max(0, min(55, base_x + random.gauss(0, 2)))
            y = max(0, min(36, base_y + random.gauss(0, 1.5)))
            base_x = x  # drift
            base_y = y

            keyframes.append({
                "time": float(t),
                "x": round(x, 2),
                "y": round(y, 2),
                "confidence": round(random.uniform(0.7, 1.0), 3),
            })

        tracks.append({
            "player_id": f"track_{i + 1}",
            "team": team,
            "keyframes": keyframes,
        })

    d.put(call_id, {
        "status": "complete",
        "stage": "done",
        "percent": 100,
    })

    return {
        "metadata": {
            "video_id": "mock",
            "fps": 30,
            "detection_fps": 10,
            "duration": 600.0,
            "frame_count": 18000,
            "field_template": field_template,
            "periods": [{"start_time": 0, "end_time": 600}],
            "processing_time_seconds": 14.0,
        },
        "tracks": tracks,
    }
