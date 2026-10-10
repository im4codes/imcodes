import { expect, it } from 'vitest';
import { userInfo } from 'node:os';
import { join } from 'node:path';

/**
 * A probe, not a real test. It deliberately points the home back at the real
 * user home so the guard in test/setup/isolated-home.ts has something to catch.
 *
 * It is named *.integration.test.ts so the daemon project's existing exclude
 * (`test/**\/*.integration.test.ts`) keeps it out of the ordinary suite. It is
 * only ever run by the guard test, through a throwaway config, and it never
 * writes anything: it changes two environment variables and asserts.
 */
it('leaks the home back to the real user home', () => {
  const real = userInfo().homedir;
  process.env.HOME = real;
  process.env.IMCODES_HOME = join(real, '.imcodes');
  // The probe body itself must pass; the guard is what has to fail the file.
  expect(process.env.HOME).toBe(real);
});
