import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('desktop maximize Escape regression guard', () => {
  it('does not bind Escape to desktop maximize or restore handlers in App', () => {
    const repoRoot = process.cwd().endsWith('/web') ? join(process.cwd(), '..') : process.cwd();
    const appSource = readFileSync(join(repoRoot, 'web/src/app.tsx'), 'utf8');
    const escapeMentions = Array.from(appSource.matchAll(/Escape/g));

    for (const mention of escapeMentions) {
      const index = mention.index ?? 0;
      const nearby = appSource.slice(index, index + 500);
      expect(nearby).not.toMatch(/setDesktopFileBrowserMaximized|clearSubSessionMaximized|restoreSubSession|maximizeOpenSubSession|desktopFileBrowserMaximized|maximizedSubIds/);
      expect(nearby).not.toMatch(/preventDefault\(\)|stopPropagation\(\)/);
    }
  });
});
