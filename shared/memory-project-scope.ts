export const MEMORY_PROJECT_SCOPE_REASON = {
  UNAVAILABLE: 'project_scope_unavailable',
  MISMATCH: 'project_scope_mismatch',
} as const;

export type MemoryProjectScopeReason =
  (typeof MEMORY_PROJECT_SCOPE_REASON)[keyof typeof MEMORY_PROJECT_SCOPE_REASON];

export function cleanMemoryProjectId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function sameMemoryProjectId(a: unknown, b: unknown): boolean {
  const left = cleanMemoryProjectId(a);
  const right = cleanMemoryProjectId(b);
  return !!left && !!right && left === right;
}
