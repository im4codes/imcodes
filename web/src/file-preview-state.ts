import type {
  FileBrowserPreviewRequest,
  FileBrowserPreviewState,
  FileBrowserPreviewUpdate,
} from './components/file-browser-lazy.js';

export type FilePreviewCache = Record<string, { preferDiff?: boolean; preview: FileBrowserPreviewState }>;

export function filePreviewStatesEqual(a: FileBrowserPreviewState, b: FileBrowserPreviewState): boolean {
  if (a === b) return true;
  if (a.status !== b.status) return false;
  switch (a.status) {
    case 'idle':
      return true;
    case 'loading':
      return b.status === 'loading' && a.path === b.path;
    case 'ok':
      return b.status === 'ok'
        && a.path === b.path
        && a.content === b.content
        && a.diff === b.diff
        && a.diffHtml === b.diffHtml
        && a.downloadId === b.downloadId;
    case 'image':
      return b.status === 'image'
        && a.path === b.path
        && a.dataUrl === b.dataUrl
        && a.downloadId === b.downloadId;
    case 'office':
      return b.status === 'office'
        && a.path === b.path
        && a.data === b.data
        && a.mimeType === b.mimeType
        && a.downloadId === b.downloadId;
    case 'video':
      return b.status === 'video'
        && a.path === b.path
        && a.streamUrl === b.streamUrl
        && a.mimeType === b.mimeType
        && a.downloadId === b.downloadId;
    case 'error':
      return b.status === 'error'
        && a.path === b.path
        && a.error === b.error
        && a.downloadId === b.downloadId;
  }
}

export function updateFilePreviewCache(
  prev: FilePreviewCache,
  update: FileBrowserPreviewUpdate,
): FilePreviewCache {
  const existing = prev[update.path];
  if (
    existing
    && existing.preferDiff === update.preferDiff
    && filePreviewStatesEqual(existing.preview, update.preview)
  ) {
    return prev;
  }
  return {
    ...prev,
    [update.path]: {
      preferDiff: update.preferDiff,
      preview: update.preview,
    },
  };
}

export function applyFilePreviewRequestUpdate(
  prev: FileBrowserPreviewRequest | null,
  update: FileBrowserPreviewUpdate,
): FileBrowserPreviewRequest | null {
  if (!prev) return prev;
  if (prev.path === update.path) {
    const preferDiff = prev.preferDiff ?? update.preferDiff;
    if (prev.preferDiff === preferDiff && filePreviewStatesEqual(prev.preview ?? { status: 'idle' }, update.preview)) {
      return prev;
    }
    return {
      ...prev,
      preferDiff,
      preview: update.preview,
    };
  }

  // Cross-path updates are accepted only for the explicit loading transition
  // produced by a user selecting another file inside the floating preview.
  // Late ok/error/image/etc. updates from the previously active file must not
  // move the app-level preview request back to an old path after the pinned
  // file manager has already selected a new target.
  if (update.preview.status !== 'loading') return prev;

  return {
    ...prev,
    path: update.path,
    preferDiff: update.preferDiff,
    preview: update.preview,
  };
}
