import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = process.cwd().endsWith('/web') ? process.cwd() : join(process.cwd(), 'web');

describe('session settings responsive styles', () => {
  it('keeps model status/actions responsive on mobile', () => {
    const css = readFileSync(join(WEB_ROOT, 'src/styles.css'), 'utf8');
    expect(css).toMatch(/\.session-settings-model-actions\s*\{[^}]*display:\s*flex/s);
    expect(css).toMatch(/@media \(max-width:\s*640px\)[\s\S]*?\.session-settings-model-actions\s*\{[^}]*flex-direction:\s*column/s);
    expect(css).toMatch(/\.session-settings-success\s*\{[^}]*color:/s);
  });

  it('requires every production settings caller to choose one independent surface', () => {
    const source = readFileSync(join(WEB_ROOT, 'src/components/SessionSettingsDialog.tsx'), 'utf8');
    expect(source).toContain("surface: 'session' | 'supervision'");
    expect(source).not.toContain("'combined'");
    expect(source).not.toMatch(/surface\s*=\s*['"][^'"]+['"]\s*,/);
  });
});
