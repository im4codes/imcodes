/**
 * The panel window host packaging skeleton is DEFERRED: the panel page is the one UI, shown in the app window and in the browser fallback.
 * The FLTK window and its pinned sources are gone; the signing + manifest skeleton (and node-side verified discovery) is kept for the
 * Windows WebView2 host. It is NOT wired into either release workflow and nothing is added to the artifact set; the checks below
 * keep it internally consistent (signing order) and pin that nothing wires it by accident.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('native aiDesk window release wiring', () => {
  const action = read('.github/actions/build-aidesk-ui/action.yml');

  it('is not wired into either release workflow and adds nothing to the artifact set (deferred; the panel page is the only UI)', () => {
    for (const path of ['.github/workflows/build-node-exe.yml', '.github/workflows/ci.yml']) {
      const workflow = read(path);
      expect(workflow, path).not.toContain('build-aidesk-ui');
      expect(workflow, path).not.toContain('aidesk-local-ui/**');
    }
  });

  it('signs and verifies the Windows executable BEFORE the manifest records its hash; the manifest names the release signer', () => {
    const signAt = action.indexOf('-Mode Sign');
    const verifyAt = action.indexOf('-Mode Verify');
    const writeAt = action.indexOf('aidesk-ui-artifact.mjs write $art win32 x64');
    expect(signAt).toBeGreaterThan(-1);
    expect(signAt).toBeLessThan(verifyAt);
    expect(verifyAt).toBeLessThan(writeAt);
    expect(action).toContain('$env:AIDESK_SIGNER_SHA256');
    expect(action).toContain("throw 'The Windows release-signing certificate must be imported");
  });

  it('builds nothing itself and carries no FLTK / jsoncpp sources or fetch step (the window host is the app\'s own WebView)', () => {
    expect(action).not.toMatch(/fltk|jsoncpp|fetch-aidesk-ui-deps|build-ui\.(sh|ps1)/iu);
    expect(action).not.toMatch(/curl|wget|Invoke-WebRequest/iu);
  });
});
