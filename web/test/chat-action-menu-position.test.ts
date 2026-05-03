import { describe, expect, it } from 'vitest';
import {
  CHAT_ACTION_MENU_VIEWPORT_MARGIN,
  positionChatActionMenu,
} from '../src/chat-action-menu-position.js';

const container = { left: 0, top: 0, width: 320, height: 600 };

describe('chat action menu positioning', () => {
  it('keeps a left-edge long-press menu inside the visible chat width', () => {
    const pos = positionChatActionMenu(4, 240, container, { width: 240, height: 40 });

    expect(pos.x).toBe(CHAT_ACTION_MENU_VIEWPORT_MARGIN);
    expect(pos.x + 240).toBeLessThanOrEqual(container.width - CHAT_ACTION_MENU_VIEWPORT_MARGIN);
  });

  it('keeps a right-edge long-press menu inside the visible chat width', () => {
    const pos = positionChatActionMenu(318, 240, container, { width: 240, height: 40 });

    expect(pos.x).toBe(container.width - 240 - CHAT_ACTION_MENU_VIEWPORT_MARGIN);
    expect(pos.x + 240).toBeLessThanOrEqual(container.width - CHAT_ACTION_MENU_VIEWPORT_MARGIN);
  });

  it('tracks the finger when the menu has enough horizontal room', () => {
    const pos = positionChatActionMenu(160, 240, container, { width: 120, height: 40 });

    expect(pos.x).toBe(100);
  });

  it('moves below the touch point when there is no room above it', () => {
    const pos = positionChatActionMenu(160, 12, container, { width: 120, height: 40 });

    expect(pos.y).toBeGreaterThan(12);
  });
});
