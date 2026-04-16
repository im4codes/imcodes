import type {
  FileChangeBatch,
  FileChangeConfidence,
  FileChangeHunk,
  FileChangeOperation,
  FileChangePatch,
  FileChangeProviderKind,
} from '../../shared/file-change.js';
import { extractUnifiedDiffHunks } from '../../shared/unified-diff.js';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asStringAny(...values: unknown[]): string | undefined {
  for (const value of values) {
    const next = asString(value);
    if (next) return next;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function detectOperation(value: unknown, fallback: FileChangeOperation = 'unknown'): FileChangeOperation {
  const normalized = String(value ?? '').toLowerCase();
  if (!normalized) return fallback;
  if (normalized.includes('create') || normalized === 'new' || normalized === 'add' || normalized === 'added') return 'create';
  if (normalized.includes('delete') || normalized === 'remove' || normalized === 'removed') return 'delete';
  if (normalized.includes('rename') || normalized.includes('move')) return 'rename';
  if (normalized.includes('update') || normalized.includes('edit') || normalized.includes('modify') || normalized === 'write') return 'update';
  return fallback;
}

function sanitizePatch(patch: FileChangePatch | null | undefined): FileChangePatch | null {
  if (!patch?.filePath) return null;
  const confidence: FileChangeConfidence = patch.confidence
    ?? (patch.beforeText || patch.afterText || patch.unifiedDiff ? 'derived' : 'coarse');
  const hunks = patch.hunks && patch.hunks.length > 0
    ? patch.hunks
    : patch.unifiedDiff
      ? extractUnifiedDiffHunks(patch.unifiedDiff)
      : undefined;
  return {
    ...patch,
    filePath: patch.filePath,
    operation: patch.operation ?? 'unknown',
    confidence,
    ...(hunks && hunks.length > 0 ? { hunks } : {}),
  };
}

function normalizeHunks(value: unknown): FileChangeHunk[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hunks = value
    .map((entry) => {
      const record = asRecord(entry);
      if (!record) return null;
      const oldStart = asNumber(record.oldStart ?? record.old_start ?? record.beforeStart ?? record.before_start ?? record.startLine ?? record.start_line);
      const oldLines = asNumber(record.oldLines ?? record.old_lines ?? record.beforeLines ?? record.before_lines ?? record.lineCount ?? record.line_count);
      const newStart = asNumber(record.newStart ?? record.new_start ?? record.afterStart ?? record.after_start ?? record.targetStart ?? record.target_start);
      const newLines = asNumber(record.newLines ?? record.new_lines ?? record.afterLines ?? record.after_lines ?? record.targetLines ?? record.target_lines);
      const header = asString(record.header ?? record.text ?? record.rawHeader ?? record.raw_header);
      if (oldStart === undefined || oldLines === undefined || newStart === undefined || newLines === undefined) return null;
      return { oldStart, oldLines, newStart, newLines, header: header ?? `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@` };
    })
    .filter((entry): entry is FileChangeHunk => !!entry);
  return hunks.length > 0 ? hunks : undefined;
}

function firstDefinedHunks(...values: unknown[]): FileChangeHunk[] | undefined {
  for (const value of values) {
    const hunks = normalizeHunks(value);
    if (hunks) return hunks;
  }
  return undefined;
}

function toBatch(
  provider: FileChangeProviderKind,
  patches: Array<FileChangePatch | null | undefined>,
  opts?: {
    sourceToolCallId?: string;
    sourceEventId?: string;
    raw?: unknown;
    title?: string;
  },
): FileChangeBatch | null {
  const normalized = patches
    .map((patch) => sanitizePatch(patch))
    .filter((patch): patch is FileChangePatch => !!patch);
  if (normalized.length === 0) return null;
  return {
    provider,
    ...(opts?.sourceEventId ? { sourceEventId: opts.sourceEventId } : {}),
    ...(opts?.sourceToolCallId ? { sourceToolCallIds: [opts.sourceToolCallId] } : {}),
    ...(opts?.title ? { title: opts.title } : {}),
    patches: normalized.map((patch) => ({
      ...patch,
      ...(opts?.sourceToolCallId && !patch.toolCallId ? { toolCallId: opts.sourceToolCallId } : {}),
      ...(patch.raw === undefined && opts?.raw !== undefined ? { raw: opts.raw } : {}),
    })),
  };
}

function normalizeGenericToolPatch(
  input: unknown,
  raw: unknown,
  toolCallId?: string,
  toolName?: string,
): FileChangePatch | null {
  const inputRecord = asRecord(input);
  const rawRecord = asRecord(raw);
  const filePath = asStringAny(
    inputRecord?.file_path,
    inputRecord?.filePath,
    inputRecord?.path,
    rawRecord?.file_path,
    rawRecord?.filePath,
    rawRecord?.path,
  );
  if (!filePath) return null;

  const oldPath = asStringAny(
    inputRecord?.old_path,
    inputRecord?.oldPath,
    rawRecord?.old_path,
    rawRecord?.oldPath,
  );
  const beforeText = asStringAny(
    inputRecord?.old_string,
    inputRecord?.oldString,
    inputRecord?.beforeText,
    inputRecord?.before,
    rawRecord?.old_string,
    rawRecord?.oldString,
    rawRecord?.beforeText,
    rawRecord?.before,
  );
  const afterText = asStringAny(
    inputRecord?.new_string,
    inputRecord?.newString,
    inputRecord?.afterText,
    inputRecord?.content,
    inputRecord?.text,
    rawRecord?.new_string,
    rawRecord?.newString,
    rawRecord?.afterText,
    rawRecord?.content,
    rawRecord?.text,
  );
  const unifiedDiff = asStringAny(
    inputRecord?.diff,
    inputRecord?.patch,
    rawRecord?.diff,
    rawRecord?.patch,
  );
  const hunks = firstDefinedHunks(
    inputRecord?.hunks,
    inputRecord?.ranges,
    rawRecord?.hunks,
    rawRecord?.ranges,
    asRecord(rawRecord?.result)?.hunks,
    asRecord(rawRecord?.result)?.ranges,
    asRecord(rawRecord?.toolUseResult)?.hunks,
    asRecord(rawRecord?.toolUseResult)?.ranges,
  );
  const operation = detectOperation(
    inputRecord?.operation ?? inputRecord?.op ?? inputRecord?.type ?? rawRecord?.operation ?? rawRecord?.op ?? rawRecord?.type ?? toolName,
    beforeText && afterText ? 'update' : afterText ? 'update' : 'unknown',
  );
  const confidence: FileChangeConfidence = beforeText && afterText
    ? 'exact'
    : unifiedDiff
      ? 'exact'
      : afterText
        ? 'derived'
        : 'coarse';

  return {
    filePath,
    operation,
    confidence,
    ...(oldPath ? { oldPath } : {}),
    ...(beforeText ? { beforeText } : {}),
    ...(afterText ? { afterText } : {}),
    ...(unifiedDiff ? { unifiedDiff } : {}),
    ...(hunks ? { hunks } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    raw,
  };
}

function normalizeCodexFileChangePatch(change: unknown, toolCallId?: string): FileChangePatch | null {
  const record = asRecord(change);
  if (!record) return null;
  const filePath = asStringAny(
    record.filePath,
    record.path,
    record.newPath,
    record.targetPath,
    record.file,
  );
  if (!filePath) return null;
  const beforeText = asStringAny(record.beforeText, record.before, record.oldText, record.oldContent);
  const afterText = asStringAny(record.afterText, record.after, record.newText, record.newContent, record.content);
  const unifiedDiff = asStringAny(record.unifiedDiff, record.patch, record.diff);
  const hunks = normalizeHunks(record.hunks ?? record.ranges);
  const oldPath = asStringAny(record.oldPath, record.previousPath, record.fromPath);
  const operation = detectOperation(record.operation ?? record.op ?? record.kind ?? record.type,
    oldPath ? 'rename' : beforeText || afterText || unifiedDiff ? 'update' : 'unknown');
  const confidence: FileChangeConfidence = beforeText && afterText
    ? 'exact'
    : unifiedDiff
      ? 'exact'
      : afterText
        ? 'derived'
        : 'coarse';

  return {
    filePath,
    operation,
    confidence,
    ...(oldPath ? { oldPath } : {}),
    ...(beforeText ? { beforeText } : {}),
    ...(afterText ? { afterText } : {}),
    ...(unifiedDiff ? { unifiedDiff } : {}),
    ...(hunks ? { hunks } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    raw: change,
  };
}

export function normalizeClaudeFileChange(params: {
  toolName: string;
  toolCallId?: string;
  input?: unknown;
  toolResult?: unknown;
}): FileChangeBatch | null {
  const input = asRecord(params.input);
  const result = asRecord(params.toolResult);
  const toolUseResult = asRecord(result?.toolUseResult);
  const filePath = asStringAny(input?.file_path, toolUseResult?.filePath);
  if (params.toolName === 'Edit') {
    if (!filePath) return null;
    const beforeText = asString(input?.old_string);
    const afterText = asString(input?.new_string);
    return toBatch('claude-code', [{
      filePath,
      operation: 'update',
      confidence: beforeText && afterText ? 'exact' : 'coarse',
      ...(beforeText ? { beforeText } : {}),
      ...(afterText ? { afterText } : {}),
      raw: { input: params.input, toolResult: params.toolResult },
    }], { sourceToolCallId: params.toolCallId, raw: { input: params.input, toolResult: params.toolResult } });
  }

  if (params.toolName === 'MultiEdit') {
    const edits = Array.isArray(input?.edits) ? input?.edits : [];
    return toBatch('claude-code', edits.map((entry) => {
      const edit = asRecord(entry);
      if (!edit) return null;
      const editPath = asStringAny(edit.file_path, edit.filePath, filePath);
      if (!editPath) return null;
      const beforeText = asString(edit.old_string);
      const afterText = asString(edit.new_string);
      return {
        filePath: editPath,
        operation: 'update',
        confidence: beforeText && afterText ? 'exact' : 'coarse',
        ...(beforeText ? { beforeText } : {}),
        ...(afterText ? { afterText } : {}),
        raw: { input: params.input, edit, toolResult: params.toolResult },
      };
    }), { sourceToolCallId: params.toolCallId, raw: { input: params.input, toolResult: params.toolResult } });
  }

  if (params.toolName === 'Write') {
    if (!filePath) return null;
    return toBatch('claude-code', [{
      filePath,
      operation: detectOperation(toolUseResult?.type, 'update'),
      confidence: asStringAny(input?.content, toolUseResult?.content) ? 'derived' : 'coarse',
      afterText: asStringAny(input?.content, toolUseResult?.content),
      raw: { input: params.input, toolResult: params.toolResult },
    }], { sourceToolCallId: params.toolCallId, raw: { input: params.input, toolResult: params.toolResult } });
  }

  if (params.toolName === 'NotebookEdit') {
    return toBatch('claude-code', [normalizeGenericToolPatch(params.input, { toolResult: params.toolResult }, params.toolCallId, params.toolName)], {
      sourceToolCallId: params.toolCallId,
      raw: { input: params.input, toolResult: params.toolResult },
    });
  }

  return null;
}

export function normalizeOpenCodeFileChange(part: UnknownRecord): FileChangeBatch | null {
  const state = asRecord(part.state) ?? {};
  const input = asRecord(state.input) ?? {};
  const metadata = asRecord(state.metadata) ?? {};
  const fileDiff = asRecord(metadata.filediff) ?? {};
  const filePath = asStringAny(input.filePath, metadata.filePath, fileDiff.filePath);
  if (!filePath || typeof part.tool !== 'string') return null;

  if (part.tool === 'edit') {
    const hunks = firstDefinedHunks(
      metadata.hunks,
      metadata.ranges,
      fileDiff.hunks,
      fileDiff.ranges,
      fileDiff.chunks,
    );
    return toBatch('opencode', [{
      filePath,
      operation: 'update',
      confidence: asStringAny(fileDiff.before, input.oldString) && asStringAny(fileDiff.after, input.newString)
        ? 'exact'
        : asString(metadata.diff)
          ? 'exact'
          : 'coarse',
      beforeText: asStringAny(fileDiff.before, input.oldString),
      afterText: asStringAny(fileDiff.after, input.newString),
      unifiedDiff: asString(metadata.diff),
      ...(hunks ? { hunks } : {}),
      raw: part,
    }], {
      sourceToolCallId: asString(part.id),
      raw: part,
    });
  }

  if (part.tool === 'write') {
    return toBatch('opencode', [{
      filePath,
      operation: metadata.exists === false ? 'create' : 'update',
      confidence: asString(input.content) ? 'derived' : 'coarse',
      afterText: asString(input.content),
      raw: part,
    }], {
      sourceToolCallId: asString(part.id),
      raw: part,
    });
  }

  return null;
}

export function normalizeCodexSdkFileChange(params: {
  toolCallId?: string;
  detail?: unknown;
  raw?: unknown;
}): FileChangeBatch | null {
  const detail = asRecord(params.detail);
  const input = asRecord(detail?.input);
  const changes = Array.isArray(input?.changes)
    ? input?.changes
    : Array.isArray((asRecord(params.raw) ?? {}).changes)
      ? (asRecord(params.raw) ?? {}).changes as unknown[]
      : [];
  return toBatch('codex-sdk', changes.map((change) => normalizeCodexFileChangePatch(change, params.toolCallId)), {
    sourceToolCallId: params.toolCallId,
    raw: params.raw ?? params.detail,
  });
}

export function normalizeQwenFileChange(params: {
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  raw?: unknown;
}): FileChangeBatch | null {
  return toBatch('qwen', [normalizeGenericToolPatch(params.input, params.raw, params.toolCallId, params.toolName)], {
    sourceToolCallId: params.toolCallId,
    raw: params.raw ?? params.input,
  });
}

export function normalizeGeminiFileChange(params: {
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  status?: string;
}): FileChangeBatch | null {
  const normalizedTool = String(params.toolName ?? '').toLowerCase();
  if (normalizedTool === 'run_shell_command') return null;
  const patch = normalizeGenericToolPatch(params.args, { result: params.result }, params.toolCallId, params.toolName);
  if (!patch) return null;
  if (!normalizedTool.includes('edit') && !normalizedTool.includes('write') && !normalizedTool.includes('file')) {
    return null;
  }
  if (normalizedTool.includes('delete')) patch.operation = 'delete';
  else if (normalizedTool.includes('rename')) patch.operation = 'rename';
  else if (normalizedTool.includes('write') && patch.operation === 'unknown') patch.operation = 'update';
  return toBatch('gemini', [patch], {
    sourceToolCallId: params.toolCallId,
    raw: { args: params.args, result: params.result, status: params.status },
  });
}
