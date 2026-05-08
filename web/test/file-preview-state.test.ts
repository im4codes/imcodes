import { describe, expect, it } from 'vitest';
import {
  applyFilePreviewRequestUpdate,
  updateFilePreviewCache,
} from '../src/file-preview-state.js';
import type { FileBrowserPreviewRequest, FileBrowserPreviewUpdate } from '../src/components/file-browser-lazy.js';

describe('file preview state coordination', () => {
  it('ignores stale completed updates for a previous file after a newer preview request is active', () => {
    const active: FileBrowserPreviewRequest = {
      path: '/repo/bar.ts',
      rootPath: '/repo',
      preferDiff: false,
      preview: { status: 'loading', path: '/repo/bar.ts' },
    };
    const stale: FileBrowserPreviewUpdate = {
      path: '/repo/foo.ts',
      preferDiff: true,
      preview: { status: 'ok', path: '/repo/foo.ts', content: 'old foo', diff: '+old foo' },
    };

    expect(applyFilePreviewRequestUpdate(active, stale)).toBe(active);
  });

  it('accepts cross-file loading updates from the floating preview file list', () => {
    const active: FileBrowserPreviewRequest = {
      path: '/repo/foo.ts',
      rootPath: '/repo',
      preferDiff: false,
      preview: { status: 'ok', path: '/repo/foo.ts', content: 'foo' },
    };
    const nextLoading: FileBrowserPreviewUpdate = {
      path: '/repo/bar.ts',
      preferDiff: false,
      preview: { status: 'loading', path: '/repo/bar.ts' },
    };

    expect(applyFilePreviewRequestUpdate(active, nextLoading)).toEqual({
      path: '/repo/bar.ts',
      rootPath: '/repo',
      preferDiff: false,
      preview: { status: 'loading', path: '/repo/bar.ts' },
    });
  });

  it('updates the active request for richer same-file preview content', () => {
    const active: FileBrowserPreviewRequest = {
      path: '/repo/foo.ts',
      rootPath: '/repo',
      preferDiff: undefined,
      preview: { status: 'loading', path: '/repo/foo.ts' },
    };
    const done: FileBrowserPreviewUpdate = {
      path: '/repo/foo.ts',
      preferDiff: true,
      preview: { status: 'ok', path: '/repo/foo.ts', content: 'new foo', diff: '+new foo' },
    };

    expect(applyFilePreviewRequestUpdate(active, done)).toEqual({
      path: '/repo/foo.ts',
      rootPath: '/repo',
      preferDiff: true,
      preview: { status: 'ok', path: '/repo/foo.ts', content: 'new foo', diff: '+new foo' },
    });
  });

  it('does not churn the active request for structurally identical loading updates', () => {
    const active: FileBrowserPreviewRequest = {
      path: '/repo/foo.ts',
      rootPath: '/repo',
      preferDiff: false,
      preview: { status: 'loading', path: '/repo/foo.ts' },
    };

    expect(applyFilePreviewRequestUpdate(active, {
      path: '/repo/foo.ts',
      preferDiff: false,
      preview: { status: 'loading', path: '/repo/foo.ts' },
    })).toBe(active);
  });

  it('does not churn the preview cache for structurally identical preview updates', () => {
    const cache = {
      '/repo/foo.ts': {
        preferDiff: false,
        preview: { status: 'ok' as const, path: '/repo/foo.ts', content: 'foo' },
      },
    };

    expect(updateFilePreviewCache(cache, {
      path: '/repo/foo.ts',
      preferDiff: false,
      preview: { status: 'ok', path: '/repo/foo.ts', content: 'foo' },
    })).toBe(cache);
  });
});
