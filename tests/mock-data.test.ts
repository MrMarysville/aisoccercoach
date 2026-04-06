import { describe, it, expect } from 'vitest';
import { generateMockData } from '@/lib/video-processing/mock-data';

describe('generateMockData', () => {
  const data = generateMockData({
    video_id: 'test-123',
    field_template: '9v9',
    camera_type: 'fixed',
    duration_seconds: 5,
    fps: 10,
  });

  it('generates correct metadata', () => {
    expect(data.video_id).toBe('test-123');
    expect(data.field_template).toBe('9v9');
    expect(data.camera_type).toBe('fixed');
    expect(data.fps).toBe(10);
    expect(data.frame_count).toBe(50); // 5s * 10fps
  });

  it('generates 18 players per frame (9v9)', () => {
    const frame0Players = data.players.filter((p) => p.frame === 0);
    expect(frame0Players).toHaveLength(18);
  });

  it('has correct team distribution', () => {
    const frame0Players = data.players.filter((p) => p.frame === 0);
    const home = frame0Players.filter((p) => p.team === 'home');
    const away = frame0Players.filter((p) => p.team === 'away');
    expect(home).toHaveLength(9);
    expect(away).toHaveLength(9);
  });

  it('keeps players within field bounds', () => {
    for (const p of data.players) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(55);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(36);
    }
  });

  it('has confidence between 0 and 1', () => {
    for (const p of data.players) {
      expect(p.confidence).toBeGreaterThanOrEqual(0);
      expect(p.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('generates for all frames', () => {
    const frames = new Set(data.players.map((p) => p.frame));
    expect(frames.size).toBe(50);
  });

  it('works with ptz camera type', () => {
    const ptzData = generateMockData({
      video_id: 'ptz-test',
      field_template: '9v9',
      camera_type: 'ptz',
      duration_seconds: 2,
      fps: 10,
    });
    expect(ptzData.camera_type).toBe('ptz');
    expect(ptzData.players.length).toBeGreaterThan(0);
  });
});
