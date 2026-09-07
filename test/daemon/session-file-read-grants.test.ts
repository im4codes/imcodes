import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetSessionFileReadGrantsForTests,
  extractAssistantFileReadGrants,
  hasAssistantFileReadGrant,
  recordAssistantFileReadGrants,
} from '../../src/daemon/session-file-read-grants.js';

describe('assistant-published session file read grants', () => {
  beforeEach(() => __resetSessionFileReadGrantsForTests());

  it('extracts inline-code paths and standalone absolute paths shown as file actions', () => {
    expect(extractAssistantFileReadGrants([
      '下载：`/srv/worktree/public/templates/承诺书.docx`',
      '/home/ai/share/客车制动防滑设备故障信息归集系统V1.0_09070655.zip',
      '相对路径 `public/templates/承诺书.pdf` 不授权',
      '正文中偶然提及 /etc/passwd 不授权',
    ].join('\n'))).toEqual([
      '/srv/worktree/public/templates/承诺书.docx',
      '/home/ai/share/客车制动防滑设备故障信息归集系统V1.0_09070655.zip',
    ]);
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
