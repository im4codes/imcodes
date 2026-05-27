import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('startup splash screen contract', () => {
  const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
  const appSource = readFileSync(resolve(__dirname, '../src/app.tsx'), 'utf8');

  it('keeps the logo centered while the codes text reveals', () => {
    expect(indexHtml).toContain('--splash-avatar-size');
    expect(indexHtml).toContain('--splash-avatar-size: clamp(96px, 18vw, 156px)');
    expect(indexHtml).toContain('class="splash-avatar" src="/imcodes-robot-avatar.png"');
    expect(indexHtml).toMatch(/\.splash-avatar\s*\{[^}]*width:\s*var\(--splash-avatar-size\)/);
    expect(indexHtml).toContain('--splash-logo-width');
    expect(indexHtml).toMatch(/\.splash-logo\s*\{[^}]*width:\s*var\(--splash-logo-width\)/);
    expect(indexHtml).toMatch(/\.splash-top\s*\{[^}]*justify-content:\s*center/);
    expect(indexHtml).toMatch(/\.splash-codes\s*\{[^}]*width:\s*3\.08em/);
    expect(indexHtml).toMatch(/\.splash-codes\s*\{[^}]*clip-path:\s*inset\(0 100% 0 0\)/);
    expect(indexHtml).toContain('@keyframes revealCodes');
    expect(indexHtml).not.toContain('@keyframes typeOut');
  });

  it('runs the splash animation quickly enough for app startup', () => {
    expect(indexHtml).toMatch(/animation:\s*avatarBoot 0\.34s/);
    expect(indexHtml).toMatch(/animation:\s*glitchIn 0\.45s/);
    expect(indexHtml).toMatch(/animation:\s*revealCodes 0\.32s/);
    expect(indexHtml).toMatch(/animation:\s*fadeUp 0\.34s/);
    expect(indexHtml).toMatch(/animation:\s*beamSweep 0\.9s/);
    expect(indexHtml).toMatch(/animation:\s*scanDown 1\.7s/);
    expect(appSource).toContain('const minMs = 1100');
    expect(appSource).toContain('}, 320);');
  });
});
