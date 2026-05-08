import type { AuthoredContextScope } from '../../../shared/memory-scope.js';

export interface RuntimeAuthoredContextBindingLike {
  bindingId: string;
  mode: 'required' | 'advisory';
  scope: AuthoredContextScope;
  content: string;
}

export interface RuntimeAuthoredContextBudgetDiagnostic {
  bindingId: string;
  mode: 'required' | 'advisory';
  reason: 'advisory_trimmed' | 'required_over_budget';
  bytes: number;
}

export type RuntimeAuthoredContextBudgetResult<T extends RuntimeAuthoredContextBindingLike> =
  | { ok: true; bindings: T[]; diagnostics: RuntimeAuthoredContextBudgetDiagnostic[] }
  | { ok: false; error: 'required_context_over_budget'; bindings: T[]; diagnostics: RuntimeAuthoredContextBudgetDiagnostic[] };

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Apply runtime authored-context budget after project/workspace/org ordering.
 * Required bindings are preserved or dispatch fails; advisory bindings may be
 * omitted only with explicit diagnostics.
 */
export function applyRuntimeAuthoredContextBudget<T extends RuntimeAuthoredContextBindingLike>(
  bindings: readonly T[],
  maxBytes: number | null | undefined,
): RuntimeAuthoredContextBudgetResult<T> {
  if (!Number.isFinite(maxBytes) || maxBytes === undefined || maxBytes === null || maxBytes <= 0) {
    return { ok: true, bindings: [...bindings], diagnostics: [] };
  }
  const diagnostics: RuntimeAuthoredContextBudgetDiagnostic[] = [];
  const selected: T[] = [];
  let used = 0;
  for (const binding of bindings) {
    const bytes = utf8Bytes(binding.content);
    if (binding.mode === 'required') {
      if (used + bytes > maxBytes) {
        diagnostics.push({ bindingId: binding.bindingId, mode: binding.mode, reason: 'required_over_budget', bytes });
        return { ok: false, error: 'required_context_over_budget', bindings: selected, diagnostics };
      }
      selected.push(binding);
      used += bytes;
      continue;
    }
    if (used + bytes > maxBytes) {
      diagnostics.push({ bindingId: binding.bindingId, mode: binding.mode, reason: 'advisory_trimmed', bytes });
      continue;
    }
    selected.push(binding);
    used += bytes;
  }
  return { ok: true, bindings: selected, diagnostics };
}
