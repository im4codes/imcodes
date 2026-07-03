import type {
  FileBrowserPreviewRequest,
  FileBrowserPreviewState,
  FileBrowserPreviewUpdate,
} from './components/file-browser-lazy.js';
import type { HtmlPreviewViewMode } from '@shared/html-preview.js';

export type FilePreviewRequestWithViewMode = FileBrowserPreviewRequest & {
  previewViewMode?: HtmlPreviewViewMode;
};

export type FilePreviewUpdateWithViewMode = FileBrowserPreviewUpdate & {
  previewViewMode?: HtmlPreviewViewMode;
};

export type FilePreviewCache = Record<string, {
  preferDiff?: boolean;
  previewViewMode?: HtmlPreviewViewMode;
  preview: FileBrowserPreviewState;
}>;

export function normalizePreviewViewMode(mode: HtmlPreviewViewMode | undefined): HtmlPreviewViewMode {
  return mode ?? 'source';
}

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
    case 'audio':
      return b.status === 'audio'
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
  update: FilePreviewUpdateWithViewMode,
): FilePreviewCache {
  const existing = prev[update.path];
  const previewViewMode = normalizePreviewViewMode(update.previewViewMode);
  if (
    existing
    && existing.preferDiff === update.preferDiff
    && normalizePreviewViewMode(existing.previewViewMode) === previewViewMode
    && filePreviewStatesEqual(existing.preview, update.preview)
  ) {
    return prev;
  }
  return {
    ...prev,
    [update.path]: {
      preferDiff: update.preferDiff,
      previewViewMode,
      preview: update.preview,
    },
  };
}

export function applyFilePreviewRequestUpdate(
  prev: FilePreviewRequestWithViewMode | null,
  update: FilePreviewUpdateWithViewMode,
): FilePreviewRequestWithViewMode | null {
  if (!prev) return prev;
  if (prev.path === update.path) {
    const preferDiff = prev.preferDiff ?? update.preferDiff;
    const previewViewMode = normalizePreviewViewMode(update.previewViewMode ?? prev.previewViewMode);
    if (
      prev.preferDiff === preferDiff
      && normalizePreviewViewMode(prev.previewViewMode) === previewViewMode
      && filePreviewStatesEqual(prev.preview ?? { status: 'idle' }, update.preview)
    ) {
      return prev;
    }
    return {
      ...prev,
      preferDiff,
      previewViewMode,
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
    previewViewMode: normalizePreviewViewMode(update.previewViewMode),
    preview: update.preview,
  };
}
