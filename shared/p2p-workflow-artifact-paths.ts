import { makeP2pWorkflowDiagnostic, type P2pWorkflowDiagnostic } from './p2p-workflow-diagnostics.js';

export type P2pArtifactPathValidationResult =
  | { ok: true; path: string; diagnostics: P2pWorkflowDiagnostic[] }
  | { ok: false; diagnostics: P2pWorkflowDiagnostic[] };

export function validateP2pArtifactRelativePath(input: unknown, fieldPath = 'artifact.path'): P2pArtifactPathValidationResult {
  if (typeof input !== 'string') {
    return {
      ok: false,
      diagnostics: [makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'compile', { fieldPath, summary: 'Artifact path must be a string.' })],
    };
  }
  if (!isP2pArtifactRelativePath(input)) {
    return {
      ok: false,
      diagnostics: [makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'compile', { fieldPath })],
    };
  }
  return { ok: true, path: input, diagnostics: [] };
}

export function isP2pArtifactRelativePath(path: string): boolean {
  if (path === '' || path.includes('\0')) return false;
  if (path.startsWith('/') || path.startsWith('~') || path.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(path) || path.startsWith('//')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function getP2pArtifactPathDepth(path: string): number {
  return path.split('/').filter(Boolean).length;
}
