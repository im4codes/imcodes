import { createHash } from 'node:crypto';

import {
  P2P_WORKFLOW_ARTIFACT_MAX_DEPTH,
  P2P_WORKFLOW_ARTIFACT_MAX_FILE_BYTES,
  P2P_WORKFLOW_ARTIFACT_MAX_FILES,
  P2P_WORKFLOW_ARTIFACT_MAX_TOTAL_BYTES,
} from './p2p-workflow-constants.js';
import { makeP2pWorkflowDiagnostic, type P2pWorkflowDiagnostic } from './p2p-workflow-diagnostics.js';
import { canonicalize, stableStringify } from './p2p-workflow-policy.js';
import type { P2pJsonValue } from './p2p-workflow-types.js';

export type P2pArtifactPathValidationResult =
  | { ok: true; path: string; diagnostics: P2pWorkflowDiagnostic[] }
  | { ok: false; diagnostics: P2pWorkflowDiagnostic[] };

export interface P2pArtifactFileBaseline {
  path: string;
  sha256: string;
  sizeBytes?: number;
  fileType?: P2pArtifactFileType;
  metadata?: Record<string, unknown>;
}

export type P2pArtifactFileType = 'file' | 'directory' | 'symlink' | 'other';

export interface P2pArtifactBaselineHashInput {
  files: P2pArtifactFileBaseline[];
}

export type P2pArtifactBaselineValidationResult =
  | { ok: true; baseline: P2pArtifactBaselineHashInput; diagnostics: P2pWorkflowDiagnostic[] }
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

export function validateP2pArtifactBaseline(input: unknown): P2pArtifactBaselineValidationResult {
  if (!isRecord(input) || !Array.isArray(input.files)) {
    return invalidArtifactBaseline('artifactBaseline.files');
  }

  const diagnostics: P2pWorkflowDiagnostic[] = [];
  const files: P2pArtifactFileBaseline[] = [];
  let totalBytes = 0;
  const seen = new Set<string>();

  if (input.files.length > P2P_WORKFLOW_ARTIFACT_MAX_FILES) {
    diagnostics.push(makeP2pWorkflowDiagnostic('artifact_baseline_too_large', 'bind', {
      fieldPath: 'artifactBaseline.files',
      summary: `Artifact baseline exceeds file cap (${input.files.length}/${P2P_WORKFLOW_ARTIFACT_MAX_FILES}).`,
    }));
  }

  for (const [index, rawFile] of input.files.entries()) {
    const fieldPath = `artifactBaseline.files[${index}]`;
    if (!isRecord(rawFile)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('artifact_baseline_mismatch', 'execute', { fieldPath }));
      continue;
    }

    const path = rawFile.path;
    const sha256 = rawFile.sha256;
    const sizeBytes = rawFile.sizeBytes;
    const fileType = rawFile.fileType;

    const validPath = typeof path === 'string' && isP2pArtifactRelativePath(path);
    if (!validPath) {
      diagnostics.push(makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'bind', { fieldPath: `${fieldPath}.path` }));
    } else if (getP2pArtifactPathDepth(path) > P2P_WORKFLOW_ARTIFACT_MAX_DEPTH) {
      diagnostics.push(makeP2pWorkflowDiagnostic('unsafe_artifact_path', 'bind', {
        fieldPath: `${fieldPath}.path`,
        summary: `Artifact path exceeds depth cap (${P2P_WORKFLOW_ARTIFACT_MAX_DEPTH}).`,
      }));
    }
    if (validPath && seen.has(path)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('artifact_baseline_mismatch', 'execute', {
        fieldPath: `${fieldPath}.path`,
        summary: 'Duplicate artifact baseline path.',
      }));
    }
    if (validPath) seen.add(path);

    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('artifact_baseline_mismatch', 'execute', { fieldPath: `${fieldPath}.sha256` }));
    }
    if (!Number.isInteger(sizeBytes) || (sizeBytes as number) < 0) {
      diagnostics.push(makeP2pWorkflowDiagnostic('artifact_baseline_mismatch', 'execute', { fieldPath: `${fieldPath}.sizeBytes` }));
    } else {
      if ((sizeBytes as number) > P2P_WORKFLOW_ARTIFACT_MAX_FILE_BYTES) {
        diagnostics.push(makeP2pWorkflowDiagnostic('artifact_baseline_too_large', 'bind', { fieldPath: `${fieldPath}.sizeBytes` }));
      }
      totalBytes += sizeBytes as number;
    }
    if (!isP2pArtifactFileType(fileType)) {
      diagnostics.push(makeP2pWorkflowDiagnostic('artifact_baseline_mismatch', 'execute', { fieldPath: `${fieldPath}.fileType` }));
    }

    if (!validPath) continue;
    files.push({
      path: path as string,
      sha256: typeof sha256 === 'string' ? sha256.toLowerCase() : '',
      sizeBytes: typeof sizeBytes === 'number' ? sizeBytes : undefined,
      fileType: isP2pArtifactFileType(fileType) ? fileType : undefined,
      ...(isRecord(rawFile.metadata) ? { metadata: rawFile.metadata } : {}),
    });
  }

  if (totalBytes > P2P_WORKFLOW_ARTIFACT_MAX_TOTAL_BYTES) {
    diagnostics.push(makeP2pWorkflowDiagnostic('artifact_baseline_too_large', 'bind', {
      fieldPath: 'artifactBaseline.files',
      summary: `Artifact baseline exceeds total byte cap (${totalBytes}/${P2P_WORKFLOW_ARTIFACT_MAX_TOTAL_BYTES}).`,
    }));
  }

  return diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    ? { ok: false, diagnostics }
    : { ok: true, baseline: { files }, diagnostics };
}

export function hashP2pArtifactBaseline(input: P2pArtifactBaselineHashInput): string {
  return `sha256:${sha256Hex(stableStringify(canonicalizeP2pArtifactBaseline(input)))}`;
}

export function areP2pArtifactBaselinesEqual(left: P2pArtifactBaselineHashInput, right: P2pArtifactBaselineHashInput): boolean {
  return hashP2pArtifactBaseline(left) === hashP2pArtifactBaseline(right);
}

export function canonicalizeP2pArtifactBaseline(input: P2pArtifactBaselineHashInput): P2pJsonValue {
  const files = input.files
    .map((file) => ({
      path: file.path,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      fileType: file.fileType,
      metadata: canonicalizeArtifactMetadata(file.metadata),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return canonicalize({ files });
}

function canonicalizeArtifactMetadata(metadata: Record<string, unknown> | undefined): P2pJsonValue {
  if (!metadata) return {};
  const { capturedAt: _capturedAt, ...rest } = metadata;
  return canonicalize(rest);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isP2pArtifactFileType(value: unknown): value is P2pArtifactFileType {
  return value === 'file' || value === 'directory' || value === 'symlink' || value === 'other';
}

function invalidArtifactBaseline(fieldPath: string): P2pArtifactBaselineValidationResult {
  return { ok: false, diagnostics: [makeP2pWorkflowDiagnostic('artifact_baseline_mismatch', 'execute', { fieldPath })] };
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
