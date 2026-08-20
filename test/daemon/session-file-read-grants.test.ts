import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetSessionFileReadGrantsForTests,
  extractAssistantFileReadGrants,
  hasAssistantFileReadGrant,
  recordAssistantFileReadGrants,
} from '../../src/daemon/session-file-read-grants.js';

describe('assistant-published session file read grants', () => {
  beforeEach(() => __resetSessionFileReadGrantsForTests());

  it('extracts only absolute paths delimited as inline code', () => {
    expect(extractAssistantFileReadGrants([
      '下载：`/srv/worktree/public/templates/承诺书.docx`',
      '相对路径 `public/templates/承诺书.pdf` 不授权',
      '普通文本 /etc/passwd 也不授权',
    ].join('\n'))).toEqual(['/srv/worktree/public/templates/承诺书.docx']);
  });

  it('keeps grants exact and session-scoped', async () => {
    recordAssistantFileReadGrants('deck_a_brain', '`/srv/repo/report.pdf`');
    const noHistory = async () => [];

    await expect(hasAssistantFileReadGrant('deck_a_brain', '/srv/repo/report.pdf', noHistory)).resolves.toBe(true);
    await expect(hasAssistantFileReadGrant('deck_a_brain', '/srv/repo/report.pdf.bak', noHistory)).resolves.toBe(false);
    await expect(hasAssistantFileReadGrant('deck_b_brain', '/srv/repo/report.pdf', noHistory)).resolves.toBe(false);
  });

  it('does not restore hidden assistant paths from timeline history', async () => {
    const loader = async () => [{
      eventId: 'hidden-path',
      sessionId: 'deck_a_brain',
      ts: 1,
      seq: 1,
      epoch: 1,
      source: 'daemon',
      confidence: 'high',
      type: 'assistant.text',
      payload: { text: '`/srv/private/hidden.pdf`' },
      hidden: true,
    }] as never;

    await expect(hasAssistantFileReadGrant('deck_a_brain', '/srv/private/hidden.pdf', loader)).resolves.toBe(false);
  });
});
