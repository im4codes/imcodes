import { describe, expect, it } from 'vitest';
import {
  REMOTE_DESKTOP_CHAT_CITATION_PATTERN,
  REMOTE_DESKTOP_CITATION_PREFIX,
  formatRemoteDesktopCitation,
  parseRemoteDesktopCitationTag,
  sanitizeRemoteDesktopCitationId,
  sanitizeRemoteDesktopCitationName,
  splitTextByRemoteDesktopCitations,
} from '../../shared/remote-desktop-reference.js';

describe('remote-desktop-reference', () => {
  it('sanitizes machine names with brackets, pipes, newlines, and control chars while preserving quotes', () => {
    expect(sanitizeRemoteDesktopCitationName('  "Build" [Lab]\n| Box\u200B\r\n  ')).toBe('"Build" Lab Box');
    expect(sanitizeRemoteDesktopCitationName('[|]\n\t')).toBe('Remote Desktop');
    expect(sanitizeRemoteDesktopCitationName('')).toBe('Remote Desktop');
    expect(sanitizeRemoteDesktopCitationId(' 1234567890]\n| ')).toBe('1234567890');
  });

  it('formats and parses canonical [RemoteDesktop: <name> | id=<id>] tokens', () => {
    const token = formatRemoteDesktopCitation('Mac [Studio] | QA\n', '1234567890');
    expect(token).toBe('[RemoteDesktop: Mac Studio QA | id=1234567890]');
    expect(formatRemoteDesktopCitation('NoId [Box]', '   ')).toBe('NoId Box');

    expect(parseRemoteDesktopCitationTag(token)).toEqual({
      name: 'Mac Studio QA',
      targetId: '1234567890',
    });
    expect(parseRemoteDesktopCitationTag('[RemoteDesktop: Broken | id=]')).toBeNull();
    expect(parseRemoteDesktopCitationTag('[RemoteDesktop: Nested ] | id=abc]')).toBeNull();
    expect(parseRemoteDesktopCitationTag('plain text')).toBeNull();
    expect(REMOTE_DESKTOP_CHAT_CITATION_PATTERN).toBe('[RemoteDesktop: <name> | id=<id>]');
    expect(REMOTE_DESKTOP_CITATION_PREFIX).toBe('[RemoteDesktop:');
  });

  it('splits mixed text into text and remote-desktop segments cleanly', () => {
    const text = 'Check [RemoteDesktop: Dev Mac | id=5123456789] and [RemoteDesktop: Unfinished or [RemoteDesktop: Win Box | id=srv_win_1] now.';
    expect(splitTextByRemoteDesktopCitations(text)).toEqual([
      { type: 'text', value: 'Check ', start: 0, end: 6 },
      {
        type: 'remote_desktop',
        value: '[RemoteDesktop: Dev Mac | id=5123456789]',
        start: 6,
        end: 46,
        label: 'Dev Mac',
        targetId: '5123456789',
      },
      { type: 'text', value: ' and [RemoteDesktop: Unfinished or ', start: 46, end: 81 },
      {
        type: 'remote_desktop',
        value: '[RemoteDesktop: Win Box | id=srv_win_1]',
        start: 81,
        end: 120,
        label: 'Win Box',
        targetId: 'srv_win_1',
      },
      { type: 'text', value: ' now.', start: 120, end: 125 },
    ]);
  });

  it('scans adversarial incomplete [RemoteDesktop: payloads in linear O(n) time without backtracking', () => {
    const adversarial = `${'[RemoteDesktop: '.repeat(50_000)}[RemoteDesktop: Final | id=9876543210]`;
    const startedAt = performance.now();
    const segments = splitTextByRemoteDesktopCitations(adversarial);
    const elapsedMs = performance.now() - startedAt;

    expect(segments.filter((s) => s.type === 'remote_desktop')).toEqual([
      {
        type: 'remote_desktop',
        value: '[RemoteDesktop: Final | id=9876543210]',
        start: 800_000,
        end: 800_038,
        label: 'Final',
        targetId: '9876543210',
      },
    ]);
    expect(elapsedMs).toBeLessThan(200);
  });
});
