import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSessionFileReadGrantsForTests,
  extractAssistantFileReadGrants,
  hasAssistantFileReadGrant,
  recordAssistantFileReadGrants,
  FILE_READ_GRANT_STREAM_SCAN_INTERVAL_MS,
} from '../../src/daemon/session-file-read-grants.js';

describe('assistant-published session file read grants', () => {
  beforeEach(() => __resetSessionFileReadGrantsForTests());

  it('extracts old-format inline, standalone and relative paths shown as file actions', () => {
    expect(extractAssistantFileReadGrants([
      '下载：`/srv/worktree/public/templates/承诺书.docx`',
      '/home/ai/share/客车制动防滑设备故障信息归集系统V1.0_09070655.zip',
      '相对路径 `public/templates/承诺书.pdf` 可由 daemon 在授权根中解析',
      '正文中偶然提及 /etc/passwd 不授权',
    ].join('\n'))).toEqual([
      '/srv/worktree/public/templates/承诺书.docx',
      '/home/ai/share/客车制动防滑设备故障信息归集系统V1.0_09070655.zip',
      'public/templates/承诺书.pdf',
    ]);
  });

  it('extracts exact file_output_v1 Markdown destinations with Linux CJK, hidden directories, encoding, and Unicode forms', () => {
    const nfc = '/home/ai/交付包/企享云外贸财税申报管理系统_代码.pdf';
    const nfdName = '留住彼此'.normalize('NFD');
    const nfd = `/home/ai/.work/${nfdName}_代码.pdf`;
    const encoded = '/home/ai/交付包/含%20空格_%E4%BB%A3%E7%A0%81.pdf';
    const homePath = '~/.imcodes/uploads/语音识别统计分析管控APP_代码.pdf';

    expect(extractAssistantFileReadGrants([
      `[企享云外贸财税申报管理系统_代码.pdf](${nfc})`,
      `[NFD](<${nfd}>)`,
      `[编码](${encoded})`,
      `[隐藏目录](${homePath})`,
    ].join('\n'))).toEqual([
      nfc,
      nfd,
      '/home/ai/交付包/含 空格_代码.pdf',
      '~/.imcodes/uploads/语音识别统计分析管控APP_代码.pdf',
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

  it('does not turn a remote-link display label or rejected UNC destination into a local grant', () => {
    expect(extractAssistantFileReadGrants([
      '[report.pdf](https://example.com/report.pdf)',
      String.raw`[share.pdf](\\server\share\share.pdf)`,
      '普通域名 example.com',
    ].join('\n'))).toEqual([]);
  });

  describe('streamed deltas are scanned at most once per interval (per-event cost), the final text always', () => {
    const noHistory = async () => [];
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_800_000_000_000); });
    afterEach(() => vi.useRealTimers());

    it('scans the first delta, skips deltas inside the window, scans again after it', async () => {
      recordAssistantFileReadGrants('deck_s_brain', '`/srv/a/first.pdf`', { streaming: true });
      vi.setSystemTime(1_800_000_000_100);
      recordAssistantFileReadGrants('deck_s_brain', '`/srv/a/first.pdf` `/srv/a/skipped.pdf`', { streaming: true });
      await expect(hasAssistantFileReadGrant('deck_s_brain', '/srv/a/first.pdf', noHistory)).resolves.toBe(true);
      await expect(hasAssistantFileReadGrant('deck_s_brain', '/srv/a/skipped.pdf', noHistory)).resolves.toBe(false);
      vi.setSystemTime(1_800_000_000_000 + FILE_READ_GRANT_STREAM_SCAN_INTERVAL_MS);
      recordAssistantFileReadGrants('deck_s_brain', '`/srv/a/later.pdf`', { streaming: true });
      await expect(hasAssistantFileReadGrant('deck_s_brain', '/srv/a/later.pdf', noHistory)).resolves.toBe(true);
    });

    it('never skips the final (non-streaming) text, so a path skipped mid-stream is still granted', async () => {
      recordAssistantFileReadGrants('deck_f_brain', '`/srv/b/one.pdf`', { streaming: true });
      recordAssistantFileReadGrants('deck_f_brain', '`/srv/b/one.pdf` `/srv/b/two.pdf`', { streaming: true });
      await expect(hasAssistantFileReadGrant('deck_f_brain', '/srv/b/two.pdf', noHistory)).resolves.toBe(false);
      recordAssistantFileReadGrants('deck_f_brain', '`/srv/b/one.pdf` `/srv/b/two.pdf`', { streaming: false });
      await expect(hasAssistantFileReadGrant('deck_f_brain', '/srv/b/two.pdf', noHistory)).resolves.toBe(true);
    });

    it('throttles per session, not globally', async () => {
      recordAssistantFileReadGrants('deck_x_brain', '`/srv/c/x.pdf`', { streaming: true });
      recordAssistantFileReadGrants('deck_y_brain', '`/srv/c/y.pdf`', { streaming: true });
      await expect(hasAssistantFileReadGrant('deck_y_brain', '/srv/c/y.pdf', noHistory)).resolves.toBe(true);
    });

    it('a backwards clock never throttles', async () => {
      recordAssistantFileReadGrants('deck_c_brain', '`/srv/d/a.pdf`', { streaming: true });
      vi.setSystemTime(1_800_000_000_000 - 5_000);
      recordAssistantFileReadGrants('deck_c_brain', '`/srv/d/b.pdf`', { streaming: true });
      await expect(hasAssistantFileReadGrant('deck_c_brain', '/srv/d/b.pdf', noHistory)).resolves.toBe(true);
    });
  });
});
