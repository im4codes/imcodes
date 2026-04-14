import type { RuntimeAuthoredContextBinding } from '../../shared/context-types.js';

export interface AuthoredContextSelectionInput {
  bindings: RuntimeAuthoredContextBinding[];
  repository?: string;
  language?: string;
  filePath?: string;
  maxRequiredChars?: number;
  maxAdvisoryChars?: number;
}

export interface AuthoredContextSelection {
  required: string[];
  advisory: string[];
  appliedDocumentVersionIds: string[];
  diagnostics: string[];
}

const SCOPE_RANK: Record<RuntimeAuthoredContextBinding['scope'], number> = {
  project_shared: 3,
  workspace_shared: 2,
  org_shared: 1,
};

function normalizePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\\/g, '/');
}

function matchesPattern(pathPattern: string | undefined, filePath: string | undefined): boolean {
  if (!pathPattern) return true;
  if (!filePath) return false;
  const normalizedPattern = normalizePath(pathPattern)!;
  const normalizedFilePath = normalizePath(filePath)!;
  if (normalizedPattern.endsWith('/**')) {
    return normalizedFilePath.startsWith(normalizedPattern.slice(0, -3));
  }
  if (normalizedPattern.includes('*')) {
    const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(normalizedFilePath);
  }
  return normalizedFilePath === normalizedPattern;
}

function applicabilityRank(binding: RuntimeAuthoredContextBinding, input: AuthoredContextSelectionInput): number {
  if (binding.repository && binding.repository !== input.repository) return -1;
  if (binding.language && binding.language !== input.language) return -1;
  if (binding.pathPattern && !matchesPattern(binding.pathPattern, input.filePath)) return -1;
  if (binding.repository && binding.repository === input.repository) return 3;
  if (binding.language && binding.language === input.language) return 2;
  if (binding.pathPattern && matchesPattern(binding.pathPattern, input.filePath)) return 1;
  if (!binding.repository && !binding.language && !binding.pathPattern) return 0;
  return -1;
}

function sortBindings(input: AuthoredContextSelectionInput): RuntimeAuthoredContextBinding[] {
  return [...input.bindings]
    .filter((binding) => binding.active !== false && !binding.superseded)
    .map((binding) => ({ binding, rank: applicabilityRank(binding, input) }))
    .filter((entry) => entry.rank >= 0)
    .sort((left, right) => {
      if (left.binding.mode !== right.binding.mode) {
        return left.binding.mode === 'required' ? -1 : 1;
      }
      const scopeDelta = SCOPE_RANK[right.binding.scope] - SCOPE_RANK[left.binding.scope];
      if (scopeDelta !== 0) return scopeDelta;
      if (right.rank !== left.rank) return right.rank - left.rank;
      return left.binding.documentVersionId.localeCompare(right.binding.documentVersionId);
    })
    .map((entry) => entry.binding);
}

export function selectRuntimeAuthoredContext(input: AuthoredContextSelectionInput): AuthoredContextSelection {
  const sorted = sortBindings(input);
  const required: string[] = [];
  const advisory: string[] = [];
  const appliedDocumentVersionIds: string[] = [];
  const diagnostics: string[] = [];
  let requiredChars = 0;
  let advisoryChars = 0;
  const maxRequiredChars = input.maxRequiredChars ?? 1200;
  const maxAdvisoryChars = input.maxAdvisoryChars ?? 1200;

  for (const binding of sorted) {
    const text = binding.content.trim();
    if (!text) continue;
    if (binding.mode === 'required') {
      if (requiredChars + text.length > maxRequiredChars) {
        diagnostics.push(`authored-required-omitted:${binding.documentVersionId}`);
        continue;
      }
      required.push(text);
      requiredChars += text.length;
      appliedDocumentVersionIds.push(binding.documentVersionId);
      diagnostics.push(`authored-required:${binding.documentVersionId}`);
      continue;
    }
    if (advisoryChars + text.length > maxAdvisoryChars) {
      diagnostics.push(`authored-advisory-pruned:${binding.documentVersionId}`);
      continue;
    }
    advisory.push(text);
    advisoryChars += text.length;
    appliedDocumentVersionIds.push(binding.documentVersionId);
    diagnostics.push(`authored-advisory:${binding.documentVersionId}`);
  }

  return {
    required,
    advisory,
    appliedDocumentVersionIds,
    diagnostics,
  };
}
