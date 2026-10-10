/**
 * The Windows panel window host (WebView2 exe) ships as its own sidecar: built, Authenticode-signed with the release certificate and
 * described by a manifest by ONE composite action in both release workflows (before the node executable build, in the same job that
 * imported the signing certificate), uploaded as dist-node-exe/aidesk-local-ui/**, gated in the server image (manifest verify + the three
 * files the server serves), and refreshed on installed nodes by the node itself -- never part of the transactional self-upgrade set.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readSource } from '../helpers/read-source.js';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = (path: string): string => readSource(resolve(root, path));

describe('native aiDesk window release wiring', () => {
  const action = read('.github/actions/build-aidesk-ui/action.yml');

  it('both release workflows run the one composite action right before the node executable build, after the Windows signing identity is imported, and upload its output', () => {
    for (const path of ['.github/workflows/build-node-exe.yml', '.github/workflows/ci.yml']) {
      const workflow = read(path);
      const stepAt = workflow.indexOf('uses: ./.github/actions/build-aidesk-ui');
      const buildAt = workflow.indexOf('run: npm run build:node-exe');
      expect(stepAt, path).toBeGreaterThan(-1);
      expect(stepAt, path).toBeLessThan(buildAt);
      expect(workflow.match(/uses: \.\/\.github\/actions\/build-aidesk-ui/gu), path).toHaveLength(1);
      expect(workflow, path).toContain('dist-node-exe/aidesk-local-ui/**');
      expect(workflow, path).toContain('windows-signing-cert-thumbprint: ${{ env.IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT }}');
      expect(workflow.indexOf('IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT='), path).toBeGreaterThan(-1);
      expect(workflow.indexOf('IMCODES_WINDOWS_SIGNING_CERT_THUMBPRINT='), path).toBeLessThan(stepAt);
    }
  });

  it('the server image is gated on the sidecar: manifest verify and exactly the three files the asset route serves', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('node scripts/aidesk-ui-artifact.mjs verify');
    expect(ci).toContain('server/controlled-node-artifacts/aidesk-local-ui/win32-x64 win32 x64');
    for (const file of ['aidesk-local-ui.exe', 'aidesk-local-ui.manifest.json', 'THIRD-PARTY-NOTICES.txt']) expect(ci).toContain(file);
  });

  it('a node that does not know the sidecar is unaffected: the transactional upgrade script and the worker verifiers never mention it', () => {
    for (const path of ['src/node/self-upgrade.ts', 'src/node/posix-upgrade-script.ts', 'scripts/remote-desktop-worker-artifacts.mjs', 'server/src/ws/windows-controlled-node-upgrade-rescue.ts']) {
      const text = read(path);
      // self-upgrade.ts only hosts the generic download helper; no upgrade script builder may stage, swap or even name the sidecar directory
      expect(text, path).not.toMatch(/aidesk-local-ui\/win32|aideskLocalUiArtifactRelativeDirectory|\.aidesk-local-ui-refresh|AIDESK_LOCAL_UI_SIDECAR_TARGET/u);
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

  it('builds the WebView2 host with the shared build script BEFORE signing it, and carries no FLTK / jsoncpp sources or ad-hoc downloads', () => {
    const buildAt = action.indexOf('native\\aidesk-panel-host-windows\\build.ps1');
    expect(buildAt).toBeGreaterThan(-1);
    expect(buildAt).toBeLessThan(action.indexOf('-Mode Sign'));
    expect(action).not.toMatch(/fltk|jsoncpp|fetch-aidesk-ui-deps|build-ui\.(sh|ps1)/iu);
    expect(action).not.toMatch(/curl|wget|Invoke-WebRequest/iu);
  });
});
