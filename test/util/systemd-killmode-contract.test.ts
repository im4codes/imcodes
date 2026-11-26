import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');

describe('daemon systemd cgroup shutdown contract', () => {
  for (const file of ['src/bind/bind-flow.ts', 'src/setup/setup-flow.ts']) {
    it(`${file} installs KillMode=control-group`, () => {
      const source = readFileSync(resolve(ROOT, file), 'utf8');
      expect(source).toContain('KillMode=control-group');
      expect(source).not.toContain('KillMode=process');
      expect(source).toContain('TimeoutStopSec=45s');
      expect(source).toContain('SendSIGKILL=yes');
    });
  }

  it('restart migration repairs legacy KillMode=process units', () => {
    const source = readFileSync(resolve(ROOT, 'scripts/restart-daemon.sh'), 'utf8');
    expect(source).toContain('KillMode=control-group');
    expect(source).toMatch(/\^KillMode=/);
    expect(source).toContain('TimeoutStopSec=45s');
    expect(source).toContain('SendSIGKILL=yes');
  });
});
