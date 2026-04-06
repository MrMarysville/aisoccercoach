# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Project Overview

Soccer video analysis tool: upload sideline video, auto-calibrate field geometry, detect player positions via AI (Modal.com + YOLO26 on H100 GPU), and display an interactive tactical board with frame-by-frame replay. Next.js 16 + React 19, no database, no auth, filesystem-only storage.

## Commands

```bash
pnpm dev              # Start dev server at http://localhost:3000
pnpm build            # Production build (must pass before completing work)
pnpm lint             # ESLint 9 flat config - must run before completing work
pnpm test             # Vitest (jsdom) - run all tests once
pnpm test:watch       # Vitest in watch mode
pnpm test tests/modal-client.test.ts  # Run a single test file
```

**Use `pnpm` only** (no npm/yarn).

## Architecture

### Data Flow

```
Video Upload → /api/upload (disk storage in /uploads/)
     ↓
Calibration UI → pixel-to-meter mapping (5 field reference points)
     ↓
/api/process → Modal.com webhook (YOLO26 + OpenCV) OR mock fallback
     ↓
PlayerPosition[] JSON → TacticalBoard SVG rendering with framer-motion
```

### Main Entry Point

`src/app/page.tsx` - Client component with tab-based navigation (upload → calibrate → replay). All state lives here via useState; no global state library.

### API Routes (`src/app/api/`)

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/upload` | POST | Multipart video upload to disk (15GB max, mp4/mov/avi) |
| `/api/videos/[id]` | GET | Stream uploaded video (supports range requests) |
| `/api/process` | POST | Send video to Modal.com; falls back to mock data if unconfigured |
| `/api/calibration` | GET/POST | Calibration profile management |

### Component Groups

- **`src/components/video/`** - VideoUploader (drag-drop + XHR progress), VideoPlayer (frame scrubbing), CalibrationOverlay (click-to-place field reference points)
- **`src/components/tactical/`** - TacticalBoard (filters players by current frame via useMemo), FieldTemplate (SVG soccer field, 9v9/11v11), PlayerMarker (framer-motion animated circles)

### Key Libraries

- **`src/lib/modal-client.ts`** - Calls Modal.com webhook to process video. `isModalConfigured()` checks for `NEXT_PUBLIC_MODAL_ENDPOINT` env var; without it, `/api/process` returns mock player data.
- **`src/lib/field/`** - Field dimension templates, green-field detection from ImageData, homography (perspective transform) math for pixel-to-meter coordinate mapping.
- **`src/lib/video-processing/`** - Player detection pipeline types and calibration logic.

### Core Types (`src/types/index.ts`)

- `PlayerPosition` - frame, time, player_id, x/y meters, team (home/away/unknown), confidence
- `ProcessedVideoData` - Video metadata + PlayerPosition array + field_template
- `CalibrationPoint` - pixel_x/y to field_x/y meter mapping
- `FIELD_DIMENSIONS` - 9v9 (55x36m) and 11v11 (105x68m)

## Styling

Custom CSS variables and utility classes in `src/styles/theme.css`. **No Tailwind** - the utility classes (`.flex`, `.gap-4`, `.btn`, `.card`, etc.) are hand-written in theme.css and look similar to Tailwind but are not.

- Dark theme via `.theme-dark` class (not `.dark`)
- CSS variables for colors: `--color-primary`, `--color-surface`, `--color-on-surface`, etc.
- Component classes: `.btn` + `.btn-primary`/`.btn-secondary`, `.card`, `.input`, `.container`
- Inline styles are acceptable for dynamic values (positions, gradients)

## Testing

Vitest with jsdom environment. Tests live in `tests/` (not `src/`). Setup file at `tests/setup.ts` adds jest-dom matchers and mocks `window.matchMedia`. Test files use `vi.mock()` and `vi.stubEnv()` for isolation.

## Environment

```bash
NEXT_PUBLIC_MODAL_ENDPOINT=   # Modal.com webhook URL (optional - mock data without it)
```

## TypeScript

Strict mode enabled. Path alias `@/*` maps to `./src/*`. Use `import type` for type-only imports.
