import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_LINK_TOKEN } from '../../shared/remote-desktop-access.js';
import { bootstrapRemoteDesktopInvite } from '../src/remote-desktop-invite-bootstrap.js';

const TOKEN = 'A'.repeat(REMOTE_DESKTOP_LINK_TOKEN.ENCODED_LENGTH);

describe('remote desktop invitation startup bootstrap', () => {
  it('scrubs synchronously and keeps the raw token only in the in-memory invite handoff', async () => {
    const order: string[] = [];
    const resultPromise = bootstrapRemoteDesktopInvite({
      fragment: `#invite=v1.${TOKEN}`,
      scrub: () => order.push('scrub'),
    });
    expect(order).toEqual(['scrub']);
    await expect(resultPromise).resolves.toEqual({ status: 'invite', token: TOKEN });
  });

  it('scrubs malformed fragments without returning a token', async () => {
    const scrub = vi.fn();
    await expect(bootstrapRemoteDesktopInvite({ fragment: '#invite=v1.short', scrub })).resolves.toEqual({ status: 'unavailable' });
    expect(scrub).toHaveBeenCalledOnce();
  });

  it('loads the scrubber module before the ordinary application bundle', () => {
    const htmlPath = existsSync(resolve(process.cwd(), 'web/index.html'))
      ? resolve(process.cwd(), 'web/index.html')
      : resolve(process.cwd(), 'index.html');
    const html = readFileSync(htmlPath, 'utf8');
    const scrubber = html.indexOf('/src/remote-desktop-invite-bootstrap-entry.ts');
    const application = html.indexOf('/src/main.tsx');
    expect(scrubber).toBeGreaterThan(0);
    expect(scrubber).toBeLessThan(application);
  });
});
