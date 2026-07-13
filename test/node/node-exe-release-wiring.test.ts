import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('controlled-node executable release wiring', () => {
  it('gates the production image on all three native artifacts', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('controlled-node-executables:');
    expect(workflow).toContain('controlled-node-${{ matrix.key }}');
    expect(workflow).toContain('pattern: controlled-node-*');
    expect(workflow).toContain('node scripts/node-exe-artifacts.mjs verify-set server/controlled-node-artifacts');
    expect(workflow).toContain('imcodes-node-linux imcodes-node-macos imcodes-node.exe');
    expect(workflow).toContain('dist-node-exe/${{ matrix.artifact }}.manifest.json');
  });

  it('copies the artifacts into the image and configures the serving directory', () => {
    const dockerfile = readFileSync('server/Dockerfile', 'utf8');

    expect(dockerfile).toContain('COPY server/controlled-node-artifacts/ ./controlled-node-executables/');
    expect(dockerfile).toContain('COPY scripts/node-exe-artifacts.mjs ./scripts/node-exe-artifacts.mjs');
    expect(dockerfile).toContain('ENV IMCODES_NODE_EXE_DIR=/app/controlled-node-executables');
  });

  it('publishes immutable image metadata bound to the full build commit', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('id: build_push');
    expect(workflow).toContain('COMMIT_SHA: ${{ github.sha }}');
    expect(workflow).toContain('IMAGE_REPOSITORY: ${{ env.IMAGE }}');
    expect(workflow).toContain('IMAGE_DIGEST: ${{ steps.build_push.outputs.digest }}');
    expect(workflow).toContain('name: release-metadata');
    expect(workflow).toContain('path: release-metadata/release.env');
  });

  it('anchors Node bytes to official checksums and uses the pinned postject package', () => {
    const buildScript = readFileSync('scripts/build-node-exe.mjs', 'utf8');
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { devDependencies?: Record<string, string> };

    expect(buildScript).toContain("const OFFICIAL_NODE_DIST = 'https://nodejs.org/dist'");
    expect(buildScript).toContain('verifyOfficialNodeArtifact');
    expect(buildScript).not.toContain("sh('npx', ['-y', 'postject'");
    expect(packageJson.devDependencies?.postject).toBe('1.0.0-alpha.6');
  });
});
