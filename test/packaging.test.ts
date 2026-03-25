import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';

const ROOT = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

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
    // src/index.ts uses: join(__dirname, '../../package.json')
    const pkgFromEntry = join(entryDir, '../../package.json');
    expect(existsSync(pkgFromEntry), `package.json not reachable from ${pkg.bin.imcodes} via ../../package.json`).toBe(true);
    expect(JSON.parse(readFileSync(pkgFromEntry, 'utf8')).name).toBe('imcodes');
  });

  it('version.ts can resolve package.json', () => {
    // src/util/version.ts uses: join(__dirname, '../../../package.json')
    const versionJs = join(ROOT, pkg.bin.imcodes, '../util/version.js');
    expect(existsSync(versionJs), `version.js not found at expected path`).toBe(true);
    const versionDir = dirname(versionJs);
    const pkgFromVersion = join(versionDir, '../../../package.json');
    expect(existsSync(pkgFromVersion), `package.json not reachable from version.js via ../../../package.json`).toBe(true);
    expect(JSON.parse(readFileSync(pkgFromVersion, 'utf8')).name).toBe('imcodes');
  });

  it('config.ts can resolve default.yaml', () => {
    // src/config.ts uses: join(__dirname, '../..', 'config', 'default.yaml')
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
