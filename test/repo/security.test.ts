import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const repoDir = resolve(__dirname, '../../src/repo');

describe('provider security audit', () => {
  const providers = [
    { name: 'GitHubProvider', file: 'github-provider.ts' },
    { name: 'GitLabProvider', file: 'gitlab-provider.ts' },
  ];

  for (const { name, file } of providers) {
    describe(name, () => {
      const source = readFileSync(resolve(repoDir, file), 'utf-8');

      it('uses execFile (safe variant) not exec', () => {
        expect(source).toContain('execFile');
      });

      it('does not use bare exec() (without File suffix)', () => {
        // Match exec( but not execFile(
        // We look for import or usage of child_process exec without File
        const lines = source.split('\n');
        for (const line of lines) {
          // Skip lines that reference execFile or execFileAsync
          if (/execFile/.test(line)) continue;
          // Flag any bare exec( usage — e.g. exec('command')
          expect(line).not.toMatch(/\bexec\s*\(/);
        }
      });

      it('does not contain bash -c calls', () => {
        expect(source).not.toContain('bash -c');
      });

      it('does not use template literals in execFile command arguments', () => {
        // Ensure no pattern like execFile(`...`) or execFileAsync(`...`)
        // which could allow injection via template interpolation in the command name
        expect(source).not.toMatch(/execFile(Async)?\s*\(`/);
      });
    });
  }
});
