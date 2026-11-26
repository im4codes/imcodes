import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('published server image auto-upgrade gate', () => {
  it('does not bake the emergency opt-out into the production Docker image', () => {
    const dockerfile = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'Dockerfile'),
      'utf8',
    );
    expect(dockerfile).not.toMatch(/^\s*ENV\s+IMCODES_DISABLE_AUTO_UPGRADE\s*=/m);
  });
});
