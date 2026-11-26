export const TEAM_DISCUSSION_LAYOUT_STORAGE_KEY = 'imcodes.web.team-discussion.layout.v1';

export const TEAM_DISCUSSION_LAYOUT = {
  BOTTOM: 'bottom',
  RIGHT: 'right',
} as const;

export type TeamDiscussionLayout = typeof TEAM_DISCUSSION_LAYOUT[keyof typeof TEAM_DISCUSSION_LAYOUT];

// The existing bottom discussion cards need enough room for the chat header,
// transcript, and composer. At laptop heights up to 720px the narrow side rail
// preserves substantially more vertical chat space.
export const TEAM_DISCUSSION_LOW_HEIGHT_MAX = 720;

interface StoredTeamDiscussionLayout {
  version: 1;
  layout: TeamDiscussionLayout;
}

function isTeamDiscussionLayout(value: unknown): value is TeamDiscussionLayout {
  return value === TEAM_DISCUSSION_LAYOUT.BOTTOM || value === TEAM_DISCUSSION_LAYOUT.RIGHT;
}

/** Returns only an explicit user choice. Missing/corrupt storage stays automatic. */
export function loadTeamDiscussionLayout(
  storage: Pick<Storage, 'getItem'> = localStorage,
): TeamDiscussionLayout | null {
  try {
    const raw = storage.getItem(TEAM_DISCUSSION_LAYOUT_STORAGE_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<StoredTeamDiscussionLayout> | null;
    if (value?.version === 1 && isTeamDiscussionLayout(value.layout)) return value.layout;
  } catch {
    // Local preferences are fail-soft; automatic layout remains available.
  }
  return null;
}

export function saveTeamDiscussionLayout(
  layout: TeamDiscussionLayout,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    const value: StoredTeamDiscussionLayout = { version: 1, layout };
    storage.setItem(TEAM_DISCUSSION_LAYOUT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Browser privacy modes and exhausted quotas must not block the UI.
  }
}

export function defaultTeamDiscussionLayout(
  viewportHeight: number,
  desktopLayoutCapable = true,
): TeamDiscussionLayout {
  return desktopLayoutCapable && viewportHeight <= TEAM_DISCUSSION_LOW_HEIGHT_MAX
    ? TEAM_DISCUSSION_LAYOUT.RIGHT
    : TEAM_DISCUSSION_LAYOUT.BOTTOM;
}
