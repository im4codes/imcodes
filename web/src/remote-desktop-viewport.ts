export const REMOTE_DESKTOP_MIN_ZOOM = 1;
export const REMOTE_DESKTOP_MAX_ZOOM = 4;
export const REMOTE_DESKTOP_POINTER_EDGE_STICKY_RATIO = 0.018;

export interface RemoteDesktopViewport {
  scale: number;
  x: number;
  y: number;
}

export interface RemoteDesktopViewportGeometry {
  stageWidth: number;
  stageHeight: number;
  contentWidth: number;
  contentHeight: number;
}

export interface RemoteDesktopEdgePanResult {
  viewport: RemoteDesktopViewport;
  active: boolean;
}

/**
 * Snap only the narrow edge band to an exact display edge. The interior must
 * remain an identity mapping: rescaling it makes every desktop click drift.
 */
export function stickRemoteDesktopPointerToEdges(point: { x: number; y: number }): {
  x: number;
  y: number;
} {
  const edge = REMOTE_DESKTOP_POINTER_EDGE_STICKY_RATIO;
  const stick = (value: number) => {
    if (value <= edge) return 0;
    if (value >= 1 - edge) return 1;
    return value;
  };
  return { x: stick(point.x), y: stick(point.y) };
}

export const INITIAL_REMOTE_DESKTOP_VIEWPORT: RemoteDesktopViewport = {
  scale: REMOTE_DESKTOP_MIN_ZOOM,
  x: 0,
  y: 0,
};

function finitePositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function clampRemoteDesktopViewport(
  viewport: RemoteDesktopViewport,
  geometry: RemoteDesktopViewportGeometry,
): RemoteDesktopViewport {
  const scale = Math.max(
    REMOTE_DESKTOP_MIN_ZOOM,
    Math.min(REMOTE_DESKTOP_MAX_ZOOM, Number.isFinite(viewport.scale) ? viewport.scale : 1),
  );
  const stageWidth = finitePositive(geometry.stageWidth);
  const stageHeight = finitePositive(geometry.stageHeight);
  const contentWidth = finitePositive(geometry.contentWidth);
  const contentHeight = finitePositive(geometry.contentHeight);
  const maxX = Math.max(0, (contentWidth * scale - stageWidth) / 2);
  const maxY = Math.max(0, (contentHeight * scale - stageHeight) / 2);
  const boundedX = Math.max(-maxX, Math.min(maxX, Number.isFinite(viewport.x) ? viewport.x : 0));
  const boundedY = Math.max(-maxY, Math.min(maxY, Number.isFinite(viewport.y) ? viewport.y : 0));
  return {
    scale,
    x: Object.is(boundedX, -0) ? 0 : boundedX,
    y: Object.is(boundedY, -0) ? 0 : boundedY,
  };
}

/** Keep the same source pixel under a moving pinch centroid while zooming. */
export function viewportFromRemoteDesktopPinch(
  initial: RemoteDesktopViewport,
  initialCenter: { x: number; y: number },
  currentCenter: { x: number; y: number },
  nextScale: number,
  geometry: RemoteDesktopViewportGeometry,
): RemoteDesktopViewport {
  const stageCenterX = finitePositive(geometry.stageWidth) / 2;
  const stageCenterY = finitePositive(geometry.stageHeight) / 2;
  const safeInitialScale = Math.max(REMOTE_DESKTOP_MIN_ZOOM, initial.scale);
  const sourceOffsetX = (initialCenter.x - stageCenterX - initial.x) / safeInitialScale;
  const sourceOffsetY = (initialCenter.y - stageCenterY - initial.y) / safeInitialScale;
  return clampRemoteDesktopViewport({
    scale: nextScale,
    x: currentCenter.x - stageCenterX - sourceOffsetX * nextScale,
    y: currentCenter.y - stageCenterY - sourceOffsetY * nextScale,
  }, geometry);
}

/** Chooses a readable phone scale while keeping user zoom bounded. */
export function remoteDesktopMouseModeViewport(
  source: { width: number; height: number },
  geometry: RemoteDesktopViewportGeometry,
): RemoteDesktopViewport {
  const stageWidth = finitePositive(geometry.stageWidth);
  const stageHeight = finitePositive(geometry.stageHeight);
  const sourceWidth = finitePositive(source.width);
  const sourceHeight = finitePositive(source.height);
  const readableScale = Math.max(
    2,
    sourceWidth / (stageWidth * 1.5),
    sourceHeight / (stageHeight * 1.5),
  );
  return clampRemoteDesktopViewport({ scale: readableScale, x: 0, y: 0 }, geometry);
}

/** Auto-pans zoomed content when a virtual mouse is held near a view edge. */
export function panRemoteDesktopViewportAtEdge(
  viewport: RemoteDesktopViewport,
  pointer: { x: number; y: number },
  elapsedMs: number,
  geometry: RemoteDesktopViewportGeometry,
): RemoteDesktopEdgePanResult {
  const stageWidth = finitePositive(geometry.stageWidth);
  const stageHeight = finitePositive(geometry.stageHeight);
  const threshold = Math.max(18, Math.min(42, Math.min(stageWidth, stageHeight) / 5));
  const elapsed = Math.max(0, Math.min(50, Number.isFinite(elapsedMs) ? elapsedMs : 0));
  const pixels = 480 * elapsed / 1_000;
  const velocity = (value: number, extent: number): number => {
    if (value < threshold) return 1 - Math.max(0, value) / threshold;
    if (value > extent - threshold) return -(1 - Math.max(0, extent - value) / threshold);
    return 0;
  };
  const dx = velocity(pointer.x, stageWidth) * pixels;
  const dy = velocity(pointer.y, stageHeight) * pixels;
  if (dx === 0 && dy === 0) return { viewport, active: false };
  const next = clampRemoteDesktopViewport({
    ...viewport,
    x: viewport.x + dx,
    y: viewport.y + dy,
  }, geometry);
  return {
    viewport: next,
    active: next.x !== viewport.x || next.y !== viewport.y,
  };
}
