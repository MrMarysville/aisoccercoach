#!/usr/bin/env python3

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from pathlib import Path


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
    def __init__(self) -> None:
        self._last = None

    def put(self, _call_id: str, payload: dict) -> None:
        line = json.dumps(payload, sort_keys=True)
        if line != self._last:
            print(f"[local-progress] {line}", flush=True)
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

    progress = LocalProgressDict()
    call_id = "local-gpu"
    started = time.time()

    output = None
    exit_code = 0
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

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(output, indent=2) + "\n")
        print(f"[local-output] wrote {out_path}")

    print(json.dumps(output, indent=2)[:20000])
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
