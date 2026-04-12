#!/usr/bin/env python3

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path


def write_status_file(status_path, payload: dict) -> None:
    if status_path is None:
        return
    status_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = status_path.with_suffix(status_path.suffix + '.tmp')
    tmp_path.write_text(json.dumps(payload, indent=2) + '\n')
    tmp_path.replace(status_path)


def load_env_file_if_present(repo_root: Path) -> None:
    env_path = repo_root / ".env.local"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


class LocalProgressDict:
    def __init__(self, status_path=None) -> None:
        self._last = None
        self._status_path = status_path

    def put(self, _call_id: str, payload: dict) -> None:
        line = json.dumps(payload, sort_keys=True)
        if line != self._last:
            print(f"[local-progress] {line}", flush=True)
            write_status_file(self._status_path, payload)
            self._last = line


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the soccer pipeline on the local GPU")
    parser.add_argument("video_path", help="Local path to the input video")
    parser.add_argument("--field-template", default="9v9", choices=["9v9", "11v11"])
    parser.add_argument(
        "--mode",
        default="process",
        choices=["process", "calibration"],
        help="Run full process pipeline or calibration-only",
    )
    parser.add_argument("--output", help="Write JSON result to this file")
    parser.add_argument(
        "--status-file",
        help="Write machine-readable status JSON to this file (defaults to <output>.status.json when --output is set)",
    )
    parser.add_argument(
        "--pnlcalib-root",
        default=str(Path("/root/aisoccercoach/.cache/PnLCalib")),
        help="Path to local PnLCalib checkout",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    repo_root = Path("/root/aisoccercoach")
    load_env_file_if_present(repo_root)

    pnl_root = Path(args.pnlcalib_root).resolve()
    os.environ["PNLCALIB_ROOT"] = str(pnl_root)
    if str(pnl_root) not in sys.path:
        sys.path.insert(0, str(pnl_root))
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    import cv2
    import numpy as np
    import requests
    import subprocess
    import supervision as sv
    from boxmot import BotSort
    from sklearn.cluster import KMeans
    from ultralytics import YOLO

    import modal_app

    output_path = Path(args.output) if args.output else None
    status_path = Path(args.status_file) if args.status_file else (
        Path(f"{args.output}.status.json") if args.output else None
    )

    progress = LocalProgressDict(status_path)
    call_id = "local-gpu"
    started = time.time()
    write_status_file(
        status_path,
        {
            "status": "processing",
            "stage": "starting",
            "percent": 0,
            "video_path": args.video_path,
            "mode": args.mode,
            "field_template": args.field_template,
            "started_at": time.time(),
        },
    )

    output = None
    exit_code = 0
    try:
        try:
            if args.mode == "calibration":
                video_info = modal_app._download_and_transcode_video(
                    args.video_path,
                    lambda stage, percent, **extras: progress.put(call_id, {
                        "status": "processing",
                        "stage": stage,
                        "percent": percent,
                        **extras,
                    }),
                    requests,
                    subprocess,
                    os,
                    cv2,
                )
                try:
                    result = modal_app.run_calibration_stage(
                        transcoded_path=video_info["transcoded_path"],
                        field_template=args.field_template,
                        call_id=call_id,
                        update_progress=lambda stage, percent, **extras: progress.put(call_id, {
                            "status": "processing",
                            "stage": stage,
                            "percent": percent,
                            **extras,
                        }),
                        cv2=cv2,
                        np=np,
                    )
                    output = {
                        "metadata": {
                            "fps": round(video_info["fps"], 2),
                            "duration": round(video_info["duration"], 2),
                            "frame_count": video_info["total_frames"],
                            "processing_time_seconds": round(time.time() - started, 1),
                        },
                        "calibration": result.summary,
                    }
                finally:
                    if os.path.exists(video_info["transcoded_path"]):
                        os.remove(video_info["transcoded_path"])
            else:
                output = modal_app._process_video_impl(
                    args.video_path,
                    args.field_template,
                    started,
                    call_id,
                    progress,
                    subprocess,
                    os,
                    __import__("random"),
                    requests,
                    cv2,
                    np,
                    Path,
                    defaultdict,
                    YOLO,
                    BotSort,
                    KMeans,
                    sv,
                )
        except modal_app.CalibrationFailureError as error:
            exit_code = 2
            output = {
                "metadata": {
                    "field_template": args.field_template,
                    "processing_time_seconds": round(time.time() - started, 1),
                },
                "calibration": error.summary,
                "error": str(error),
                "failure_code": error.code,
            }
    except Exception as error:
        exit_code = 1
        output = {
            "metadata": {
                "field_template": args.field_template,
                "processing_time_seconds": round(time.time() - started, 1),
            },
            "error": str(error),
            "failure_code": "LOCAL_RUNNER_EXCEPTION",
        }

    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(output, indent=2) + "\n")
        print(f"[local-output] wrote {output_path}")

    print(json.dumps(output, indent=2)[:20000])
    final_status = {
        "status": "failed" if exit_code else "complete",
        "stage": "done",
        "percent": 100,
        "video_path": args.video_path,
        "mode": args.mode,
        "field_template": args.field_template,
        "exit_code": exit_code,
        "duration_seconds": round(time.time() - started, 1),
        "output_path": None if output_path is None else str(output_path),
        "failure_code": None if output is None else output.get("failure_code") or output.get("calibration", {}).get("failure_code"),
    }
    write_status_file(status_path, final_status)
    print(f"[local-final] {json.dumps(final_status, sort_keys=True)}", flush=True)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
