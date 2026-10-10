import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

// The page embeds shared functions as their own source text (Function.prototype.toString). A bundler that renames identifiers or
// injects helpers into function bodies (minify, keepNames) would break that text silently, in the browser. The node executable is
// bundled by scripts/build-node-exe.mjs, so this test bundles the page the same way and runs the result.
const root = process.cwd();

describe('the node executable build keeps the embedded page code intact', () => {
  it('the build script bundles without minify or keepNames', () => {
    const script = readFileSync(join(root, 'scripts', 'build-node-exe.mjs'), 'utf8');
    const options = script.slice(script.indexOf('await build({'), script.indexOf('logLevel', script.indexOf('await build({')));
    expect(options).not.toMatch(/minify|keepNames/u);
  });

  it('a page rendered by the BUNDLED module (same esbuild options as the executable) runs: language resolution and strings work in a DOM', async () => {
    const result = await build({
      entryPoints: [join(root, 'src/node/local-panel-page.ts')],
      bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
      loader: { '.json': 'json' },
    });
    const code = result.outputFiles[0]!.text;
    const exported: { exports: { renderLocalPanelPage?: (input: Record<string, string>) => string } } = { exports: {} };
    runInNewContext(code, { module: exported, exports: exported.exports, require, process, console }, { timeout: 5_000 });
    const html = exported.exports.renderLocalPanelPage!({ publicNodeId: '1234567890', manageUrl: 'https://example.test/m', shareUrl: 'https://example.test/s', csrf: 'token' });
    // The embedded function sources are still plain, self-contained declarations.
    expect(html).not.toMatch(/__name\(|__publicField|__defProp/u);
    expect(html).toMatch(/function matchUiLocale\(/u);
    expect(html).toMatch(/function localPanelText\(/u);

    const errors: unknown[] = [];
    const fetchStub = vi.fn(async () => ({ ok: true, json: async () => ({ publicNodeId: '1234567890', paused: false, connections: [] }) }));
    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:43751/', runScripts: 'dangerously',
      beforeParse(window) {
        Object.defineProperty(window, 'fetch', { configurable: true, value: fetchStub });
        Object.defineProperty(window.navigator, 'languages', { configurable: true, value: ['de-DE', 'zh-Hant-HK', 'en'] });
        window.addEventListener('error', (event) => errors.push(event.error ?? event.message));
      },
    });
    try {
      await vi.waitFor(() => expect(dom.window.document.getElementById('statusText')?.textContent).toBe('上線'));
      expect(dom.window.document.documentElement.lang).toBe('zh-TW');
      expect(errors).toEqual([]);
    } finally { dom.window.close(); }
  });
});
