import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('memory search authorization source guard', () => {
  it('keeps generic memory search gated from owner-private reads unless user-private sync is enabled', () => {
    const source = readFileSync(new URL('../src/routes/shared-context.ts', import.meta.url), 'utf8');
    const routeStart = source.indexOf("sharedContextRoutes.post('/memory/search'");
    const routeEnd = source.indexOf('type CitationProjectionRow', routeStart);
    expect(routeStart).toBeGreaterThanOrEqual(0);
    expect(routeEnd).toBeGreaterThan(routeStart);
    const route = source.slice(routeStart, routeEnd);

    expect(route).toContain('MEMORY_FEATURES.userPrivateSync');
    expect(route).toContain('includeOwnerPrivate: userPrivateSyncEnabled');
    expect(route).toContain('userPrivateSyncEnabled && scopes.includes');
    expect(route).toContain("p.scope <> 'personal'");
    expect(route).toContain('FROM owner_private_memories');
    expect(route.indexOf('userPrivateSyncEnabled && scopes.includes')).toBeLessThan(route.indexOf('FROM owner_private_memories'));
  });
});
