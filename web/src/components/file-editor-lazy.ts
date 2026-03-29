/**
 * Lazy wrappers for FileEditor components.
 * Extracted into a separate file so tests can mock this module
 * without triggering Vitest's SSR module graph to evaluate
 * FileEditor.tsx (which imports 17 CodeMirror/Lezer packages).
 */
import { lazy } from 'preact/compat';
import type { FileEditorProps } from './FileEditor.js';

export const FileEditor = lazy(() =>
  import('./FileEditor.js').then(m => ({ default: m.FileEditor }))
);

export const FileEditorContent = lazy(() =>
  import('./FileEditor.js').then(m => ({ default: m.FileEditorContent }))
);

export type { FileEditorProps };
