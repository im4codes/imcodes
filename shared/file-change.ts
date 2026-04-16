export const TIMELINE_EVENT_FILE_CHANGE = 'file.change' as const;

export const FILE_CHANGE_PROVIDER_KINDS = [
  'claude-code',
  'opencode',
  'codex-sdk',
  'qwen',
  'gemini',
] as const;

export type FileChangeProviderKind = (typeof FILE_CHANGE_PROVIDER_KINDS)[number];

export const FILE_CHANGE_OPERATIONS = [
  'create',
  'update',
  'delete',
  'rename',
  'unknown',
] as const;

export type FileChangeOperation = (typeof FILE_CHANGE_OPERATIONS)[number];

export const FILE_CHANGE_CONFIDENCE_LEVELS = [
  'exact',
  'derived',
  'coarse',
] as const;

export type FileChangeConfidence = (typeof FILE_CHANGE_CONFIDENCE_LEVELS)[number];

export interface FileChangeHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
}

export interface FileChangePatch {
  filePath: string;
  operation: FileChangeOperation;
  confidence: FileChangeConfidence;
  oldPath?: string;
  beforeText?: string;
  afterText?: string;
  unifiedDiff?: string;
  hunks?: FileChangeHunk[];
  toolCallId?: string;
  raw?: unknown;
}

export interface FileChangeBatch {
  provider: FileChangeProviderKind;
  sourceEventId?: string;
  sourceToolCallIds?: string[];
  title?: string;
  patches: FileChangePatch[];
}

export interface FileChangeTimelinePayload {
  batch: FileChangeBatch;
}
