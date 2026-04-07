import modal
import cv2
import numpy as np
from typing import List, Dict, Any, Optional, Tuple
import math

app = modal.App("soccer-video-processor")

image = modal.Image.debian_slim().pip_install(
    "ultralytics==8.0.196",
    "opencv-python-headless==4.10.0.84", 
    "numpy==1.26.4",
    "fastapi[standard]"
).pip_install("torch", "torchvision", extra_index_url="https://download.pytorch.org/whl/cu121")

yolo_model = None

def _get_yolo_model():
    global yolo_model
    if yolo_model is None:
        from ultralytics import YOLO
        yolo_model = YOLO("yolo26n.pt")
    return yolo_model


@app.function(image=image, gpu="H100")
def process_video(
    video_bytes: bytes,
    calibration_points: Optional[List[Dict[str, float]]] = None,
    field_template: str = "11v11",
    frame_interval: int = 30,
    auto_calibrate: bool = True
) -> Dict[str, Any]:
    """Process video using vanishing point + field geometry for PTZ cameras."""
    global yolo_model
    
    nparr = np.frombuffer(video_bytes, np.uint8)
    temp_path = "/tmp/temp_video.mp4"
    with open(temp_path, "wb") as f:
        f.write(nparr)
    
    cap = cv2.VideoCapture(temp_path)
    if not cap.isOpened():
        return {"error": "Failed to open video", "success": False}
    
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps if fps > 0 else 0
    
    field_dims = {"9v9": (55, 36), "11v11": (105, 68)}
    field_w, field_h = field_dims.get(field_template, (105, 68))
    
    homography = None
    initial_calibration = None
    
    if auto_calibrate:
        ret, first_frame = cap.read()
        if ret:
            initial_calibration = _detect_field_geometry(first_frame, field_w, field_h)
            if initial_calibration and len(initial_calibration) >= 4:
                homography = _compute_homography_from_points(initial_calibration, field_w, field_h)
                print(f"Auto-calibrated with {len(initial_calibration)} points using field geometry")
    
    if homography is None and calibration_points and len(calibration_points) >= 4:
        homography = _compute_homography(calibration_points, field_template)
    
    if homography is None:
        cap.release()
        return {"error": "Could not compute homography - need at least 4 points", "success": False}
    
    yolo = _get_yolo_model()
    
    players = []
    frame_idx = 0
    processed_count = 0
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        
        if frame_idx % frame_interval == 0:
            frame_homography = homography
            
            if auto_calibrate and frame_idx > 0:
                frame_calibration = _detect_field_geometry(frame, field_w, field_h)
                if frame_calibration and len(frame_calibration) >= 4:
                    try:
                        frame_homography = _compute_homography_from_points(frame_calibration, field_w, field_h)
                    except:
                        frame_homography = homography
            
            player_detections = _detect_players_yolo(frame, yolo, frame_homography)
            for player in player_detections:
                players.append({
                    "frame": frame_idx,
                    "time": frame_idx / fps if fps > 0 else 0,
                    "player_id": f"player_{frame_idx}_{player['id']}",
                    "x_meters": player["x"],
                    "y_meters": player["y"],
                    "team": player["team"],
                    "confidence": player["confidence"]
                })
            processed_count += 1
        
        frame_idx += 1
    
    cap.release()
    
    return {
        "success": True,
        "video_id": "",
        "frame_count": total_frames,
        "fps": fps,
        "duration": duration,
        "width": width,
        "height": height,
        "players": players,
        "field_template": field_template,
        "frames_processed": processed_count,
        "calibration_points": len(initial_calibration) if initial_calibration else 0
    }


@app.function(image=image, gpu="H100")
@modal.fastapi_endpoint(method="POST")
def web_process(request: Dict[str, Any]) -> Dict[str, Any]:
    """HTTP endpoint for video processing."""
    import base64
    
    video_b64 = request.get("video_bytes", "")
    video_bytes = base64.b64decode(video_b64)
    calibration_points = request.get("calibration_points", [])
    field_template = request.get("field_template", "11v11")
    frame_interval = request.get("frame_interval", 30)
    auto_calibrate = request.get("auto_calibrate", True)
    
    return process_video.remote(
        video_bytes,
        calibration_points,
        field_template,
        frame_interval,
        auto_calibrate
    )


def _detect_field_geometry(
    frame: np.ndarray,
    field_w: float,
    field_h: float
) -> List[Dict[str, float]]:
    """Detect field using vanishing points and known field geometry."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blur, 50, 150)
    
    lines = cv2.HoughLines(edges, 1, np.pi / 180, threshold=50, minLineLength=20, maxLineGap=15)
    
    if lines is None or len(lines) < 2:
        return _edge_based_detection(frame, field_w, field_h)
    
    vertical_lines = []
    horizontal_lines = []
    
    for line in lines[:50]:
        rho, theta = line[0]
        deg = np.degrees(theta)
        if 80 < deg < 100:
            vertical_lines.append((rho, theta))
        elif -10 < deg < 10 or 170 < deg < 190:
            horizontal_lines.append((rho, theta))
    
    vanishing_point = None
    if vertical_lines and len(vertical_lines) >= 2:
        vanishing_point = _estimate_vanishing_point(vertical_lines)
    
    frame_h, frame_w = frame.shape[:2]
    points = []
    
    if vanishing_point and 0 < vanishing_point[0] < frame_w and 0 < vanishing_point[1] < frame_h:
        points.append({
            "pixel_x": float(vanishing_point[0]),
            "pixel_y": float(vanishing_point[1]),
            "field_x": field_w / 2,
            "field_y": 0
        })
    
    if vertical_lines:
        sorted_v = sorted(vertical_lines, key=lambda x: x[0])
        for rho, theta in sorted_v[:2]:
            for y in [0, frame_h // 2, frame_h]:
                x = (rho - y * np.cos(theta)) / (np.sin(theta) + 1e-6)
                if 0 <= x < frame_w:
                    points.append({
                        "pixel_x": float(x),
                        "pixel_y": float(y),
                        "field_x": field_w if x > frame_w / 2 else 0,
                        "field_y": (y / frame_h) * field_h
                    })
                    break
    
    if horizontal_lines:
        sorted_h = sorted(horizontal_lines, key=lambda x: x[0])
        for rho, theta in sorted_h[:2]:
            for x in [0, frame_w // 2, frame_w]:
                y = (rho - x * np.sin(theta)) / (np.cos(theta) + 1e-6)
                if 0 <= y < frame_h:
                    points.append({
                        "pixel_x": float(x),
                        "pixel_y": float(y),
                        "field_x": (x / frame_w) * field_w,
                        "field_y": field_h if y > frame_h / 2 else 0
                    })
                    break
    
    unique_points = []
    seen = set()
    for pt in points:
        key = (int(pt["pixel_x"] // 20), int(pt["pixel_y"] // 20))
        if key not in seen:
            seen.add(key)
            unique_points.append(pt)
    
    if len(unique_points) >= 4:
        return unique_points[:8]
    
    return _edge_based_detection(frame, field_w, field_h)


def _estimate_vanishing_point(lines: List[Tuple[float, float]]) -> Optional[Tuple[float, float]]:
    """Estimate vanishing point from parallel lines."""
    if len(lines) < 2:
        return None
    
    points = []
    for rho, theta in lines[:10]:
        normal = np.array([np.cos(theta), np.sin(theta)])
        points.append(normal * rho)
    
    points = np.array(points)
    
    U, S, Vt = np.linalg.svd(points - points.mean(axis=0))
    vanishing = Vt[-1]
    
    if abs(vanishing[2]) < 1e-6:
        return None
    
    return (-vanishing[0] / vanishing[2], -vanishing[1] / vanishing[2])


def _edge_based_detection(
    frame: np.ndarray,
    field_w: float,
    field_h: float
) -> List[Dict[str, float]]:
    """Fallback using edge detection with field geometry constraints."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    
    green_lower = np.array([35, 40, 40])
    green_upper = np.array([85, 255, 200])
    field_mask = cv2.inRange(hsv, green_lower, green_upper)
    
    edges = cv2.Canny(gray, 30, 100)
    field_edges = cv2.bitwise_and(edges, edges, mask=cv2.bitwise_not(field_mask))
    
    corners = cv2.goodFeaturesToTrack(field_edges, maxCorners=15, qualityLevel=0.1, minDistance=30)
    
    frame_h, frame_w = frame.shape[:2]
    
    if corners is not None and len(corners) >= 4:
        corners = corners.reshape(-1, 2)
        
        center = corners.mean(axis=0)
        
        sorted_corners = sorted(corners, key=lambda p: np.arctan2(p[1] - center[1], p[0] - center[0]))
        
        result = []
        for i, pt in enumerate(sorted_corners[:4]):
            angle = np.arctan2(pt[1] - center[1], pt[0] - center[0])
            
            if -np.pi/4 <= angle < np.pi/4:
                field_x, field_y = field_w, field_h / 2
            elif np.pi/4 <= angle < 3*np.pi/4:
                field_x, field_y = field_w / 2, field_h
            elif angle >= 3*np.pi/4 or angle < -3*np.pi/4:
                field_x, field_y = 0, field_h / 2
            else:
                field_x, field_y = field_w / 2, 0
            
            result.append({
                "pixel_x": float(pt[0]),
                "pixel_y": float(pt[1]),
                "field_x": field_x,
                "field_y": field_y
            })
        
        return result
    
    return [
        {"pixel_x": frame_w * 0.2, "pixel_y": frame_h * 0.2, "field_x": 0, "field_y": 0},
        {"pixel_x": frame_w * 0.8, "pixel_y": frame_h * 0.2, "field_x": field_w, "field_y": 0},
        {"pixel_x": frame_w * 0.8, "pixel_y": frame_h * 0.8, "field_x": field_w, "field_y": field_h},
        {"pixel_x": frame_w * 0.2, "pixel_y": frame_h * 0.8, "field_x": 0, "field_y": field_h}
    ]


def _compute_homography_from_points(
    points: List[Dict[str, float]],
    field_w: float,
    field_h: float
) -> np.ndarray:
    """Compute homography from field points with RANSAC."""
    if len(points) < 4:
        raise ValueError("At least 4 calibration points required")
    
    src_points = [[pt["pixel_x"], pt["pixel_y"]] for pt in points[:4]]
    dst_points = [[pt["field_x"], pt["field_y"]] for pt in points[:4]]
    
    src_pts = np.array(src_points, dtype=np.float32)
    dst_pts = np.array(dst_points, dtype=np.float32)
    
    h, _ = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 5.0)
    return h


def _compute_homography(
    calibration_points: List[Dict[str, float]],
    field_template: str
) -> np.ndarray:
    if len(calibration_points) < 4:
        raise ValueError("At least 4 calibration points required")
    
    field_dims = {"9v9": (55, 36), "11v11": (105, 68)}
    field_w, field_h = field_dims.get(field_template, (105, 68))
    
    src_points = [[pt["pixel_x"], pt["pixel_y"]] for pt in calibration_points]
    dst_points = [[pt["field_x"], pt["field_y"]] for pt in calibration_points]
    
    src_pts = np.array(src_points, dtype=np.float32)
    dst_pts = np.array(dst_points, dtype=np.float32)
    
    h, _ = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 5.0)
    return h


def _detect_players_yolo(
    frame: np.ndarray,
    yolo_model,
    homography: np.ndarray,
    confidence_threshold: float = 0.3
) -> List[Dict[str, Any]]:
    """Detect players using YOLO26 with field + green color + size filtering."""
    results = yolo_model(frame, classes=[0], conf=confidence_threshold, verbose=False)
    
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    green_lower = np.array([35, 40, 40])
    green_upper = np.array([85, 255, 220])
    field_mask = cv2.inRange(hsv, green_lower, green_upper)
    
    players = []
    frame_h, frame_w = frame.shape[:2]
    field_corners = _get_field_corners(frame_w, frame_h, homography)
    
    for idx, result in enumerate(results):
        boxes = result.boxes
        if boxes is None or len(boxes) == 0:
            continue
        
        for box in boxes:
            x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
            conf = float(box.conf[0].cpu().numpy())
            
            width = x2 - x1
            height = y2 - y1
            
            if width < 15 or height < 30:
                continue
            
            aspect_ratio = height / width if width > 0 else 0
            if aspect_ratio < 0.8 or aspect_ratio > 6.0:
                continue
            
            cx = int((x1 + x2) / 2)
            cy = int((y2 - height * 0.1))
            
            if not _is_point_in_field(cx, cy, field_corners):
                
                if 0 <= cx < frame_w and 0 <= cy < frame_h:
                    foot_y = int(y2)
                    check_offsets = [0, -10, -20]
                    green_count = 0
                    for offset in check_offsets:
                        fy = foot_y + offset
                        if 0 <= fy < frame_h and 0 <= cx < frame_w:
                            if field_mask[fy, cx] > 127:
                                green_count += 1
                    
                    if green_count < 2:
                        continue
                else:
                    continue
            
            field_coords = _apply_homography_point(cx, cy, homography)
            
            if field_coords[0] < -10 or field_coords[0] > field_w + 10:
                continue
            if field_coords[1] < -10 or field_coords[1] > field_h + 10:
                continue
            
            color_at_center = frame[cy, cx] if 0 <= cy < frame_h and 0 <= cx < frame_w else np.array([0, 0, 0])
            team = _determine_team_color(color_at_center)
            
            players.append({
                "id": idx,
                "x": float(field_coords[0]),
                "y": float(field_coords[1]),
                "team": team,
                "confidence": conf
            })
    
    return players


def _get_field_corners(width: int, height: int, homography: np.ndarray) -> List[Tuple[float, float]]:
    corners = [(0, 0), (width, 0), (width, height), (0, height)]
    return [_apply_homography_point(x, y, homography) for x, y in corners]


def _is_point_in_field(x: float, y: float, corners: List[Tuple[float, float]]) -> bool:
    n = len(corners)
    if n == 0:
        return True
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = corners[i]
        xj, yj = corners[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-6) + xi):
            inside = not inside
        j = i
    return inside


def _apply_homography_point(x: float, y: float, homography: np.ndarray) -> Tuple[float, float]:
    pt = np.array([[x], [y], [1]])
    transformed = homography @ pt
    w = transformed[2, 0]
    if abs(w) < 1e-6:
        return (0.0, 0.0)
    return (transformed[0, 0] / w, transformed[1, 0] / w)


def _determine_team_color(bgr_color: np.ndarray) -> str:
    b, g, r = bgr_color
    if r > g + 20 and r > b + 20:
        return "home"
    elif b > g + 20 and b > r + 20:
        return "away"
    return "unknown"


@app.local_entrypoint()
def main():
    print("Modal app deployed with PTZ-aware field geometry detection")
    print("Uses vanishing point estimation + field line detection")