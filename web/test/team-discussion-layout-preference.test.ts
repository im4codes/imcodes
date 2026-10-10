import { beforeEach, describe, expect, it } from 'vitest';
import {
  defaultTeamDiscussionLayout,
  loadTeamDiscussionLayout,
  saveTeamDiscussionLayout,
  TEAM_DISCUSSION_LAYOUT,
  TEAM_DISCUSSION_LAYOUT_STORAGE_KEY,
  TEAM_DISCUSSION_LOW_HEIGHT_MAX,
} from '../src/team-discussion-layout-preference.js';

describe('Team discussion layout preference', () => {
  beforeEach(() => localStorage.clear());

  it('uses height only while no manual choice exists', () => {
    expect(loadTeamDiscussionLayout()).toBeNull();
    expect(defaultTeamDiscussionLayout(TEAM_DISCUSSION_LOW_HEIGHT_MAX, true))
      .toBe(TEAM_DISCUSSION_LAYOUT.RIGHT);
    expect(defaultTeamDiscussionLayout(TEAM_DISCUSSION_LOW_HEIGHT_MAX + 1, true))
      .toBe(TEAM_DISCUSSION_LAYOUT.BOTTOM);
    expect(defaultTeamDiscussionLayout(500, false)).toBe(TEAM_DISCUSSION_LAYOUT.BOTTOM);

    saveTeamDiscussionLayout(TEAM_DISCUSSION_LAYOUT.BOTTOM);
    expect(loadTeamDiscussionLayout()).toBe(TEAM_DISCUSSION_LAYOUT.BOTTOM);
    expect(JSON.parse(localStorage.getItem(TEAM_DISCUSSION_LAYOUT_STORAGE_KEY)!)).toEqual({
      version: 1,
      layout: TEAM_DISCUSSION_LAYOUT.BOTTOM,
    });
  });

  it.each([
    'not-json',
    JSON.stringify({ version: 2, layout: 'right' }),
    JSON.stringify({ version: 1, layout: 'left' }),
    JSON.stringify({ version: 1 }),
    JSON.stringify(null),
  ])('keeps malformed state automatic: %s', (raw) => {
    localStorage.setItem(TEAM_DISCUSSION_LAYOUT_STORAGE_KEY, raw);
    expect(loadTeamDiscussionLayout()).toBeNull();
  });

  it('fails softly when browser storage is unavailable', () => {
    expect(loadTeamDiscussionLayout({ getItem: () => { throw new DOMException('blocked'); } })).toBeNull();
    expect(() => saveTeamDiscussionLayout(
      TEAM_DISCUSSION_LAYOUT.RIGHT,
      { setItem: () => { throw new DOMException('quota'); } },
    )).not.toThrow();
  });
});
