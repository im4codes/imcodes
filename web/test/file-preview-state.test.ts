import { describe, expect, it } from 'vitest';
import {
  applyFilePreviewRequestUpdate,
  updateFilePreviewCache,
} from '../src/file-preview-state.js';
import type {
  FilePreviewCache,
  FilePreviewRequestWithViewMode,
  FilePreviewUpdateWithViewMode,
} from '../src/file-preview-state.js';

describe('file preview state coordination', () => {
  it('ignores stale completed updates for a previous file after a newer preview request is active', () => {
    const active: FilePreviewRequestWithViewMode = {
      path: '/repo/bar.ts',
      rootPath: '/repo',
      preferDiff: false,
      preview: { status: 'loading', path: '/repo/bar.ts' },
    };
    const stale: FilePreviewUpdateWithViewMode = {
      path: '/repo/foo.ts',
      preferDiff: true,
      preview: { status: 'ok', path: '/repo/foo.ts', content: 'old foo', diff: '+old foo' },
    };

    expect(applyFilePreviewRequestUpdate(active, stale)).toBe(active);
  });

  it('accepts cross-file loading updates from the floating preview file list', () => {
    const active: FilePreviewRequestWithViewMode = {
      path: '/repo/foo.ts',
      rootPath: '/repo',
      preferDiff: false,
      preview: { status: 'ok', path: '/repo/foo.ts', content: 'foo' },
    };
    const nextLoading: FilePreviewUpdateWithViewMode = {
      path: '/repo/bar.ts',
      preferDiff: false,
      preview: { status: 'loading', path: '/repo/bar.ts' },
    };

    expect(applyFilePreviewRequestUpdate(active, nextLoading)).toEqual({
      path: '/repo/bar.ts',
      rootPath: '/repo',
      preferDiff: false,
      previewViewMode: 'source',
      preview: { status: 'loading', path: '/repo/bar.ts' },
    });
  });

  it('carries preview view mode on cross-file loading updates', () => {
    const active: FilePreviewRequestWithViewMode = {
      path: '/repo/foo.html',
      rootPath: '/repo',
      preferDiff: false,
      previewViewMode: 'source',
      preview: { status: 'ok', path: '/repo/foo.html', content: '<p>foo</p>' },
    };
    const nextLoading: FilePreviewUpdateWithViewMode = {
      path: '/repo/bar.html',
      preferDiff: false,
      previewViewMode: 'html-render',
      preview: { status: 'loading', path: '/repo/bar.html' },
    };

    expect(applyFilePreviewRequestUpdate(active, nextLoading)).toEqual({
      path: '/repo/bar.html',
      rootPath: '/repo',
      preferDiff: false,
      previewViewMode: 'html-render',
      preview: { status: 'loading', path: '/repo/bar.html' },
    });
  });

  it('updates the active request for richer same-file preview content', () => {
    const active: FilePreviewRequestWithViewMode = {
      path: '/repo/foo.ts',
      rootPath: '/repo',
      preferDiff: undefined,
      preview: { status: 'loading', path: '/repo/foo.ts' },
    };
    const done: FilePreviewUpdateWithViewMode = {
      path: '/repo/foo.ts',
      preferDiff: true,
      preview: { status: 'ok', path: '/repo/foo.ts', content: 'new foo', diff: '+new foo' },
    };

    expect(applyFilePreviewRequestUpdate(active, done)).toEqual({
      path: '/repo/foo.ts',
      rootPath: '/repo',
      preferDiff: true,
      previewViewMode: 'source',
      preview: { status: 'ok', path: '/repo/foo.ts', content: 'new foo', diff: '+new foo' },
    });
  });

  it('preserves html render mode when same-file ok updates omit the mode', () => {
    const active: FilePreviewRequestWithViewMode = {
      path: '/repo/page.html',
      rootPath: '/repo',
      preferDiff: false,
      previewViewMode: 'html-render',
      preview: { status: 'loading', path: '/repo/page.html' },
    };

    expect(applyFilePreviewRequestUpdate(active, {
      path: '/repo/page.html',
      preferDiff: false,
      preview: { status: 'ok', path: '/repo/page.html', content: '<h1>done</h1>' },
    })).toEqual({
      path: '/repo/page.html',
      rootPath: '/repo',
      preferDiff: false,
      previewViewMode: 'html-render',
      preview: { status: 'ok', path: '/repo/page.html', content: '<h1>done</h1>' },
    });
  });

  it('preserves html render mode when same-file error updates omit the mode', () => {
    const active: FilePreviewRequestWithViewMode = {
      path: '/repo/missing.html',
      rootPath: '/repo',
      preferDiff: false,
      previewViewMode: 'html-render',
      preview: { status: 'loading', path: '/repo/missing.html' },
    };

    expect(applyFilePreviewRequestUpdate(active, {
      path: '/repo/missing.html',
      preferDiff: false,
      preview: { status: 'error', path: '/repo/missing.html', error: 'not found' },
    })).toEqual({
      path: '/repo/missing.html',
      rootPath: '/repo',
      preferDiff: false,
      previewViewMode: 'html-render',
      preview: { status: 'error', path: '/repo/missing.html', error: 'not found' },
    });
  });

  it('allows explicit same-file mode updates to replace the current request mode', () => {
    const active: FilePreviewRequestWithViewMode = {
      path: '/repo/page.html',
      rootPath: '/repo',
      preferDiff: false,
      previewViewMode: 'html-render',
      preview: { status: 'ok', path: '/repo/page.html', content: '<h1>done</h1>' },
    };

    expect(applyFilePreviewRequestUpdate(active, {
      path: '/repo/page.html',
      preferDiff: false,
      previewViewMode: 'source',
      preview: { status: 'ok', path: '/repo/page.html', content: '<h1>done</h1>' },
    })).toEqual({
      path: '/repo/page.html',
      rootPath: '/repo',
      preferDiff: false,
      previewViewMode: 'source',
      preview: { status: 'ok', path: '/repo/page.html', content: '<h1>done</h1>' },
    });
  });

  it('does not churn the active request for structurally identical loading updates', () => {
    const active: FilePreviewRequestWithViewMode = {
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

  it('treats omitted request view mode as source when a same-file update changes state', () => {
    const active: FilePreviewRequestWithViewMode = {
      path: '/repo/foo.ts',
      rootPath: '/repo',
      preferDiff: false,
      preview: { status: 'loading', path: '/repo/foo.ts' },
    };

    expect(applyFilePreviewRequestUpdate(active, {
      path: '/repo/foo.ts',
      preferDiff: false,
      preview: { status: 'error', path: '/repo/foo.ts', error: 'boom' },
    })).toEqual({
      path: '/repo/foo.ts',
      rootPath: '/repo',
      preferDiff: false,
      previewViewMode: 'source',
      preview: { status: 'error', path: '/repo/foo.ts', error: 'boom' },
    });
  });

  it('does not churn the preview cache for structurally identical preview updates', () => {
    const cache: FilePreviewCache = {
      '/repo/foo.ts': {
        preferDiff: false,
        previewViewMode: 'source',
        preview: { status: 'ok' as const, path: '/repo/foo.ts', content: 'foo' },
      },
    };

    expect(updateFilePreviewCache(cache, {
      path: '/repo/foo.ts',
      preferDiff: false,
      preview: { status: 'ok', path: '/repo/foo.ts', content: 'foo' },
    })).toBe(cache);
  });

  it('stores source mode in the preview cache when updates omit the mode', () => {
    expect(updateFilePreviewCache({}, {
      path: '/repo/foo.ts',
      preferDiff: false,
      preview: { status: 'ok', path: '/repo/foo.ts', content: 'foo' },
    })).toEqual({
      '/repo/foo.ts': {
        preferDiff: false,
        previewViewMode: 'source',
        preview: { status: 'ok', path: '/repo/foo.ts', content: 'foo' },
      },
    });
  });

  it('updates the preview cache when content is identical but view mode changes', () => {
    const cache: FilePreviewCache = {
      '/repo/page.html': {
        preferDiff: false,
        previewViewMode: 'source',
        preview: { status: 'ok', path: '/repo/page.html', content: '<p>same</p>' },
      },
    };

    expect(updateFilePreviewCache(cache, {
      path: '/repo/page.html',
      preferDiff: false,
      previewViewMode: 'html-render',
      preview: { status: 'ok', path: '/repo/page.html', content: '<p>same</p>' },
    })).toEqual({
      '/repo/page.html': {
        preferDiff: false,
        previewViewMode: 'html-render',
        preview: { status: 'ok', path: '/repo/page.html', content: '<p>same</p>' },
      },
    });
  });
});
