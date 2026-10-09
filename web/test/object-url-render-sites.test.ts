import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Class guard (audit tsk_15744109e1, P0): a `blob:`/object URL belongs to the creating origin, so a document opened or navigated to
 * from one runs on the app origin and the server's download headers (attachment / nosniff / sandbox CSP) no longer apply. Every site that
 * builds an object URL is listed here with why it cannot render a user-supplied file as a document. A NEW site fails this test until it is
 * reviewed and added with its reason -- it cannot slip in unnoticed.
 */
const SRC = resolve(__dirname, '../src');

const REVIEWED_SITES: Record<string, string> = {
  'attachment-open.ts': 'raster allowlist only, re-typed from the bare type (opened); everything else is saved as application/octet-stream',
  'browser-download.ts': 'anchor with `download`: saved, never navigated to; callers pass bytes they are saving',
  'attachment-preview-cache.ts': 'composer preview of the local File, used only as an <img> source (an image load never runs script)',
  'components/HtmlFullscreenPreview.tsx': 'the SANITISED srcDoc of util/html-safe-preview.ts (scripts/iframes/svg/objects removed, CSP script-src none), covered by HtmlSafePreview tests',
  'components/OfficePreview.tsx': 'the app\'s own pdf worker source, not a user file',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('object URL render sites', () => {
  it('every createObjectURL call in web/src is a reviewed site', () => {
    const found = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      if (/URL\.createObjectURL\s*\(/.test(readFileSync(file, 'utf8').replace(/typeof\s+URL\.createObjectURL/g, ''))) {
        found.add(relative(SRC, file).replace(/\\/g, '/'));
      }
    }
    const unreviewed = [...found].filter((file) => !(file in REVIEWED_SITES));
    expect(unreviewed, `new createObjectURL site(s) ${unreviewed.join(', ')}: review that they cannot render a user file as a document, then list them`).toEqual([]);
    const stale = Object.keys(REVIEWED_SITES).filter((file) => !found.has(file));
    expect(stale, 'reviewed site no longer exists; remove it from the list').toEqual([]);
  });

  it('previewAttachment goes through the safe opener and never opens a blob itself', () => {
    const api = readFileSync(join(SRC, 'api.ts'), 'utf8');
    const body = api.slice(api.indexOf('export async function previewAttachment('), api.indexOf('export const CONTROLLED_NODE_DESK_REQUIRED'));
    expect(body).toContain('openFetchedAttachment(');
    expect(body).not.toMatch(/window\.open\(/);
    expect(body).not.toMatch(/createObjectURL/);
  });
});
