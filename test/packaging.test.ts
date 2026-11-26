import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { pathToFileURL } from 'url';

const ROOT = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
// These tests validate that package.json paths match the actual build output.
// CI runs `npm run build` before tests to ensure dist/ exists.
describe('npm package integrity', () => {
  it('bin entry point exists after build', () => {
    const binPath = join(ROOT, pkg.bin.imcodes);
    expect(existsSync(binPath), `bin "${pkg.bin.imcodes}" not found — did tsconfig outDir structure change?`).toBe(true);
  });

  it('main entry point exists after build', () => {
    const mainPath = join(ROOT, pkg.main);
    expect(existsSync(mainPath), `main "${pkg.main}" not found — did tsconfig outDir structure change?`).toBe(true);
  });

  it('entry point can resolve package.json (src/index.ts)', () => {
    const entryDir = dirname(join(ROOT, pkg.bin.imcodes));
    const pkgFromEntry = join(entryDir, '../../package.json');
    expect(existsSync(pkgFromEntry), `package.json not reachable from ${pkg.bin.imcodes} via ../../package.json`).toBe(true);
    expect(JSON.parse(readFileSync(pkgFromEntry, 'utf8')).name).toBe('imcodes');
  });

  it('version.ts can resolve package.json', () => {
    const versionJs = join(ROOT, pkg.bin.imcodes, '../util/version.js');
    expect(existsSync(versionJs), `version.js not found at expected path`).toBe(true);
    const versionDir = dirname(versionJs);
    const pkgFromVersion = join(versionDir, '../../../package.json');
    expect(existsSync(pkgFromVersion), `package.json not reachable from version.js via ../../../package.json`).toBe(true);
    expect(JSON.parse(readFileSync(pkgFromVersion, 'utf8')).name).toBe('imcodes');
  });

  it('reports the package version when launched outside the package directory', () => {
    const versionJs = join(ROOT, pkg.bin.imcodes, '../util/version.js');
    const unrelatedCwd = mkdtempSync(join(tmpdir(), 'imcodes-version-cwd-'));
    try {
      const moduleUrl = pathToFileURL(versionJs).href;
      const child = spawnSync(
        process.execPath,
        ['--input-type=module', '--eval', `import(${JSON.stringify(moduleUrl)}).then(({ DAEMON_VERSION }) => console.log(DAEMON_VERSION))`],
        { cwd: unrelatedCwd, encoding: 'utf8' },
      );
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout.trim()).toBe(pkg.version);
    } finally {
      rmSync(unrelatedCwd, { recursive: true, force: true });
    }
  });

  it('config.ts can resolve default.yaml', () => {
    const configJs = join(ROOT, pkg.bin.imcodes, '../config.js');
    expect(existsSync(configJs), `config.js not found at expected path`).toBe(true);
    const configDir = dirname(configJs);
    const yamlPath = join(configDir, '../..', 'config', 'default.yaml');
    expect(existsSync(yamlPath), `default.yaml not reachable from config.js via ../../config/default.yaml`).toBe(true);
  });

  it('all files in package.json "files" exist', () => {
    for (const pattern of pkg.files) {
      const p = join(ROOT, pattern.replace(/\/$/, ''));
      expect(existsSync(p), `"files" entry "${pattern}" not found`).toBe(true);
    }
  });
});
