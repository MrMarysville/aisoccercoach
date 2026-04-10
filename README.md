# AI Soccer Coach - Tactical Board

Upload sideline PTZ video of soccer matches and automatically generate player position data for tactical analysis.

## What It Does

1. **Upload** - Drop a video file (MP4, MOV, AVI) up to 15GB
2. **Auto-Calibrate** - The system runs a hard-gated PTZ calibration pass using PnLCalib + ECC before any replay data is accepted
3. **Process** - YOLO26 AI detects players per frame, filters out sideline fans using field geometry, and only emits tactical positions for frames with valid homography
4. **Replay** - Scrub through the video timeline with an animated tactical board showing player positions in real-time

## Features

- **PTZ Camera Support** - Handles pan/tilt/zoom changes during play
- **No Manual Calibration Needed** - Auto-detects field geometry per-frame and hard-fails when calibration is not trustworthy
- **Fan Filtering** - Ignores spectators using field boundary + grass color checks
- **Team Detection** - Classifies players as home/away/unknown by jersey color
- **9v9 and 11v11 Support** - Works with youth and adult field sizes
- **JSON Export** - Download position data for external analysis
- **Result Caching** - Stores completed processing results in Vercel Blob and reuses them on repeat requests

## Technical Stack

- **Frontend**: Next.js 16, React
- **Backend**: Next.js API routes, Vercel Blob upload + result cache
- **Processing**: Modal.com with A10G GPU
- **AI Model**: YOLO26m (player + ball detection) + PnLCalib/ECC (field calibration)

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
The system uses PnLCalib anchors plus ECC homography propagation to estimate pixel-to-field coordinates on PTZ footage. If calibration coverage or temporal consistency drops below threshold, the job fails instead of emitting approximate coordinates.

### Player Detection
1. YOLO26m detects all "person" class objects
2. Size and aspect ratio filters remove non-human detections
3. Field boundary check - tactical coordinates are emitted only when calibration is valid
4. Coordinate transform - map pixel position to field meters (0-55m x 0-36m for 9v9)

### Processing Speed
- ~1 frame per second on H100 GPU for 1080p video
- 1-hour match ≈ 60 minutes processing time
- Adjustable frame interval for faster/smoother results

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/upload` | POST | Upload video file to Vercel Blob |
| `/api/videos/[id]` | GET | Stream uploaded video |
| `/api/process` | POST | Start processing or return cached result URL when available |
| `/api/process/status/[jobId]` | GET | Poll Modal job progress |
| `/api/process/result/[jobId]` | GET | Fetch final result and cache it in Blob |

## Environment Variables

```env
MODAL_ENDPOINT=https://your-modal-endpoint.modal.run
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...
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
│   │   ├── video/            # Upload and playback
│   │   └── replay/           # Processing state and tactical board
│   └── types/                # TypeScript definitions
├── modal_app.py             # Modal.com video processing
└── tests/                    # Vitest test suite
```

## Testing

```bash
pnpm test        # Run all tests
pnpm lint        # Lint code
pnpm build       # Production build
```

## Limitations

- Requires visible field markings often enough for calibration anchors
- Best results with static/gradual camera movement (not rapid cuts)
- Team classification based on jersey color - may misclassify in low light
- Calibration debug overlays are generated in the Modal worker but are not yet persisted back to the web app

## License

MIT
