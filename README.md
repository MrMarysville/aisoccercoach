# AI Soccer Coach - Tactical Board

Upload sideline PTZ video of soccer matches and automatically generate player position data for tactical analysis.

## What It Does

1. **Upload** - Drop a video file (MP4, MOV, AVI) up to 15GB
2. **Auto-Calibrate** - The system automatically detects field lines and computes camera perspective using vanishing point estimation
3. **Process** - YOLO26 AI detects players per frame, filters out sideline fans using field boundary + green grass detection
4. **Replay** - Scrub through the video timeline with an animated tactical board showing player positions in real-time

## Features

- **PTZ Camera Support** - Handles pan/tilt/zoom changes during play
- **No Manual Calibration Needed** - Auto-detects field geometry per-frame
- **Fan Filtering** - Ignores spectators using field boundary + grass color checks
- **Team Detection** - Classifies players as home/away/unknown by jersey color
- **9v9 and 11v11 Support** - Works with youth and adult field sizes
- **JSON Export** - Download position data for external analysis

## Technical Stack

- **Frontend**: Next.js 16, React, Framer Motion
- **Backend**: Next.js API routes, streaming file upload
- **Processing**: Modal.com with H100 GPU
- **AI Model**: YOLO26n (person detection) + OpenCV (field detection)

## Quick Start

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev
```

Open http://localhost:3000 in your browser.

## How It Works

### Field Calibration
The system uses vanishing point estimation from detected field lines to compute homography (perspective transform). For zoomed shots where full field isn't visible, it falls back to green grass color detection at the player's feet to determine if they're on the field.

### Player Detection
1. YOLO26n detects all "person" class objects
2. Size and aspect ratio filters remove non-human detections
3. Field boundary check - if field visible, use homography mapping
4. Green grass fallback - if field not visible, check feet position for grass color
5. Coordinate transform - map pixel position to field meters (0-55m x 0-36m for 9v9)

### Processing Speed
- ~1 frame per second on H100 GPU for 1080p video
- 1-hour match ≈ 60 minutes processing time
- Adjustable frame interval for faster/smoother results

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/upload` | POST | Upload video file (streams to disk, supports 15GB) |
| `/api/videos/[id]` | GET | Stream uploaded video |
| `/api/process` | POST | Process video, returns player positions JSON |
| `/api/calibration` | GET/POST | Save/load calibration profiles |

## Environment Variables

```env
NEXT_PUBLIC_MODAL_ENDPOINT=https://your-modal-endpoint.modal.run
```

## File Structure

```
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── upload/       # Video upload
│   │   │   ├── process/     # Trigger Modal processing
│   │   │   └── videos/      # Video streaming
│   │   └── page.tsx         # Main UI
│   ├── components/
│   │   ├── video/            # Upload, player, calibration
│   │   └── tactical/        # Field, player markers
│   └── types/                # TypeScript definitions
├── modal_app.py             # Modal.com video processing
├── uploads/                  # Uploaded videos (created at runtime)
└── tests/                    # Vitest test suite
```

## Testing

```bash
pnpm test        # Run all tests
pnpm lint        # Lint code
pnpm build       # Production build
```

## Limitations

- Requires visible field or grass in frame for calibration
- Best results with static/gradual camera movement (not rapid cuts)
- Team classification based on jersey color - may misclassify in low light

## License

MIT