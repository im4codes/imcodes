import { describe, expect, it } from 'vitest';
import {
  clampRemoteDesktopViewport,
  panRemoteDesktopViewportAtEdge,
  remoteDesktopMouseModeViewport,
  stickRemoteDesktopPointerToEdges,
  viewportFromRemoteDesktopPinch,
} from '../src/remote-desktop-viewport.js';

const geometry = {
  stageWidth: 400,
  stageHeight: 300,
  contentWidth: 400,
  contentHeight: 300,
};

describe('remote desktop mobile viewport', () => {
  it('bounds zoom and pan without exposing empty space', () => {
    expect(clampRemoteDesktopViewport({ scale: 9, x: 9_999, y: -9_999 }, geometry)).toEqual({
      scale: 4,
      x: 600,
      y: -450,
    });
    expect(clampRemoteDesktopViewport({ scale: 0.2, x: 50, y: 50 }, geometry)).toEqual({
      scale: 1,
      x: 0,
      y: 0,
    });
  });

  it('keeps the source point beneath an off-centre pinch anchor', () => {
    const next = viewportFromRemoteDesktopPinch(
      { scale: 1, x: 0, y: 0 },
      { x: 300, y: 200 },
      { x: 300, y: 200 },
      2,
      geometry,
    );
    expect(next).toEqual({ scale: 2, x: -100, y: -50 });
  });

  it('includes centroid movement as a bounded pan during pinch', () => {
    const next = viewportFromRemoteDesktopPinch(
      { scale: 2, x: -50, y: 0 },
      { x: 200, y: 150 },
      { x: 240, y: 120 },
      2,
      geometry,
    );
    expect(next).toEqual({ scale: 2, x: -10, y: -30 });
  });

  it('automatically chooses a readable phone scale for virtual mouse mode', () => {
    expect(remoteDesktopMouseModeViewport({ width: 1920, height: 1080 }, geometry)).toEqual({
      scale: 3.2,
      x: 0,
      y: 0,
    });
    expect(remoteDesktopMouseModeViewport({ width: 3840, height: 2160 }, geometry).scale).toBe(4);
  });

  it('snaps only the edge band without rescaling interior desktop clicks', () => {
    expect(stickRemoteDesktopPointerToEdges({ x: 0.25, y: 0.75 }))
      .toEqual({ x: 0.25, y: 0.75 });
    expect(stickRemoteDesktopPointerToEdges({ x: 0.018, y: 0.982 }))
      .toEqual({ x: 0, y: 1 });
  });

  it('auto-pans zoomed content opposite a virtual mouse at the view edge', () => {
    const atRight = panRemoteDesktopViewportAtEdge(
      { scale: 2, x: 0, y: 0 },
      { x: 399, y: 150 },
      50,
      geometry,
    );
    expect(atRight.active).toBe(true);
    expect(atRight.viewport.x).toBeLessThan(0);
    expect(atRight.viewport.y).toBe(0);

    const unzoomed = panRemoteDesktopViewportAtEdge(
      { scale: 1, x: 0, y: 0 },
      { x: 399, y: 150 },
      50,
      geometry,
    );
    expect(unzoomed).toEqual({ viewport: { scale: 1, x: 0, y: 0 }, active: false });
  });
});
