import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DAEMON_UPGRADE_FORCE_FIELD, DAEMON_UPGRADE_FORCED_REQUEST_BODY } from '../../shared/daemon-upgrade.js';

/**
 * The confirmation dialog warns that running work is interrupted; confirming it
 * is what "force" means. Every request the dialog sends (one server, or all
 * servers) must carry the forced body, and nothing else in the app may.
 */
describe('confirmed daemon upgrade requests are forced', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/app.tsx'), 'utf8');
  const upgradePosts = source.match(/apiFetch\(`\/api\/server\/\$\{server\.id\}\/upgrade`[^)]*\)/g) ?? [];

  it('sends the forced body from both the single-server and the all-servers confirmation path', () => {
    expect(upgradePosts).toHaveLength(2);
    for (const post of upgradePosts) {
      expect(post).toContain("method: 'POST'");
      expect(post).toContain('DAEMON_UPGRADE_FORCED_REQUEST_BODY');
    }
  });

  it('the body is exactly force:true under the shared field name', () => {
    expect(DAEMON_UPGRADE_FORCED_REQUEST_BODY).toEqual({ [DAEMON_UPGRADE_FORCE_FIELD]: true });
    expect(JSON.stringify(DAEMON_UPGRADE_FORCED_REQUEST_BODY)).toBe('{"force":true}');
  });
});
