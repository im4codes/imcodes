export const MEMORY_RENDER_KINDS = ['summary', 'preference', 'note', 'skill', 'pinned', 'citation_preview'] as const;
export type MemoryRenderKind = (typeof MEMORY_RENDER_KINDS)[number];

const MEMORY_RENDER_KIND_SET: ReadonlySet<string> = new Set(MEMORY_RENDER_KINDS);

export function isMemoryRenderKind(value: unknown): value is MemoryRenderKind {
  return typeof value === 'string' && MEMORY_RENDER_KIND_SET.has(value);
}
