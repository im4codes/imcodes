export interface WindowGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WorkspaceBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ClampGeometryOptions {
  minW?: number;
  minH?: number;
  visibleMargin?: number;
}

export interface DomRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type StackOrderEntry = string | { id: string };

const DEFAULT_MIN_W = 1;
const DEFAULT_MIN_H = 1;
const DEFAULT_VISIBLE_MARGIN = 32;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function normalizeWindowGeometry(value: unknown, fallback: WindowGeometry): WindowGeometry {
  const source = value && typeof value === 'object'
    ? value as Partial<Record<keyof WindowGeometry, unknown>>
    : {};
  return {
    x: finiteOr(Number(source.x), fallback.x),
    y: finiteOr(Number(source.y), fallback.y),
    w: finiteOr(Number(source.w), fallback.w),
    h: finiteOr(Number(source.h), fallback.h),
  };
}

export function geometryFromWorkspace(bounds: WorkspaceBounds): WindowGeometry {
  return {
    x: finiteOr(bounds.x, 0),
    y: finiteOr(bounds.y, 0),
    w: Math.max(0, finiteOr(bounds.w, 0)),
    h: Math.max(0, finiteOr(bounds.h, 0)),
  };
}

export function workspaceBoundsFromRect(rect: DomRectLike): WorkspaceBounds {
  return {
    x: finiteOr(rect.left, 0),
    y: finiteOr(rect.top, 0),
    w: Math.max(0, finiteOr(rect.width, 0)),
    h: Math.max(0, finiteOr(rect.height, 0)),
  };
}

export function clampGeometryToWorkspace(
  geometry: WindowGeometry,
  bounds: WorkspaceBounds,
  options: ClampGeometryOptions = {},
): WindowGeometry {
  const workspace = geometryFromWorkspace(bounds);
  const minW = Math.max(1, finiteOr(options.minW ?? DEFAULT_MIN_W, DEFAULT_MIN_W));
  const minH = Math.max(1, finiteOr(options.minH ?? DEFAULT_MIN_H, DEFAULT_MIN_H));
  const visibleMargin = Math.max(0, finiteOr(options.visibleMargin ?? DEFAULT_VISIBLE_MARGIN, DEFAULT_VISIBLE_MARGIN));
  const workspaceRight = workspace.x + workspace.w;
  const workspaceBottom = workspace.y + workspace.h;
  const w = Math.min(Math.max(finiteOr(geometry.w, minW), minW), Math.max(minW, workspace.w));
  const h = Math.min(Math.max(finiteOr(geometry.h, minH), minH), Math.max(minH, workspace.h));
  const minX = workspace.x + visibleMargin - w;
  const maxX = workspaceRight - visibleMargin;
  const minY = workspace.y;
  const maxY = workspaceBottom - visibleMargin;

  return {
    x: Math.min(Math.max(finiteOr(geometry.x, workspace.x), minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(finiteOr(geometry.y, workspace.y), minY), Math.max(minY, maxY)),
    w,
    h,
  };
}

export function shouldPersistGeometry(isMaximized: boolean): boolean {
  return !isMaximized;
}

export function resolveFrontmostMaximized(
  stackOrder: readonly StackOrderEntry[],
  maximizedIds: ReadonlySet<string> | readonly string[] | Iterable<string>,
): string | null {
  const maximized = maximizedIds instanceof Set ? maximizedIds : new Set(maximizedIds);
  for (let i = stackOrder.length - 1; i >= 0; i -= 1) {
    const entry = stackOrder[i];
    const id = typeof entry === 'string' ? entry : entry.id;
    if (maximized.has(id)) return id;
  }
  return null;
}
