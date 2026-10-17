/**
 * The one place that decides how many sub-session windows a many-windows run
 * seeds and therefore may wait for.
 *
 * The fake daemon serves `sessions - 1` sub sessions and the spec seeds those
 * same ids into localStorage. A run may ask for FEWER windows through
 * IMC_PERF_SUB_WINDOWS (compose defaults it to 19), never for more: waiting for
 * a window nothing opens is a harness stall that looks like an app freeze
 * (tsk_cd_web_route_settled_stall).
 */
export const PERF_SEEDED_HIDDEN_MAX = 10;

export function seededSubIds(sessions) {
  return Array.from({ length: Math.max(0, sessions - 1) }, (_, index) => `perfsub${index.toString(36)}`);
}

/** Which seeded ids start visible / minimized (the last <=10 are minimized when seeding minimized). */
export function seedVisibility(sessions, seedMinimized) {
  const ids = seededSubIds(sessions);
  const hidden = seedMinimized ? ids.slice(Math.max(0, ids.length - PERF_SEEDED_HIDDEN_MAX)) : [];
  const visible = seedMinimized ? ids.slice(0, Math.max(0, ids.length - hidden.length)) : ids;
  return { visible, hidden };
}

/** Sub-window counts a run measures: `total` sub sessions in play, `target` windows that must mount. */
export function planSubWindows({ sessions, subWindowsEnv, seedMinimized }) {
  const seeded = Math.max(0, sessions - 1);
  const asked = subWindowsEnv === undefined || subWindowsEnv === '' ? seeded : Number(subWindowsEnv);
  const total = Math.min(seeded, Number.isFinite(asked) ? Math.max(0, asked) : seeded);
  const target = Math.max(0, seedMinimized ? total - Math.min(PERF_SEEDED_HIDDEN_MAX, total) : total);
  const { visible } = seedVisibility(sessions, seedMinimized);
  if (target > visible.length) {
    // Unreachable by construction; kept as a loud, specific failure instead of a 90 s wait.
    throw new Error(`many-windows harness config: waits for ${target} sub-windows but only ${visible.length} are seeded (IMC_PERF_SESSIONS=${sessions}, IMC_PERF_SUB_WINDOWS=${subWindowsEnv ?? 'unset'})`);
  }
  return { seeded, total, target, visible, hiddenSeeded: seedVisibility(sessions, seedMinimized).hidden };
}
