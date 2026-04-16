import { lazy, Suspense } from 'preact/compat';
import type { JSX } from 'preact';
import type { FileBrowserProps } from './FileBrowser.js';

const LazyFileBrowser = lazy(() =>
  import('./FileBrowser.js').then((m) => ({ default: m.FileBrowser })),
);

export function FileBrowser(props: FileBrowserProps): JSX.Element {
  return (
    <Suspense fallback={<div class="fb-preview-loading"><div class="fb-loading-spinner" /></div>}>
      <LazyFileBrowser {...props} />
    </Suspense>
  );
}

export type {
  FileBrowserMode,
  FileBrowserPreviewRequest,
  FileBrowserPreviewState,
  FileBrowserPreviewUpdate,
  FileBrowserProps,
} from './FileBrowser.js';
