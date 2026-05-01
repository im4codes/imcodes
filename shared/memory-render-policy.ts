import { MEMORY_DEFAULTS } from './memory-defaults.js';
import { isMemoryRenderKind, type MemoryRenderKind } from './memory-render-kind.js';
import type { MemoryTelemetryBuffer } from './memory-telemetry.js';
import { renderSkillEnvelope } from './skill-envelope.js';

export interface MemoryRenderInput {
  kind: MemoryRenderKind;
  content: string;
  authorizedRawSource?: boolean;
  maxBytes?: number;
}

export type MemoryRenderResult = {
  ok: true;
  text: string;
  kind: MemoryRenderKind;
} | {
  ok: false;
  text: '';
  kind: MemoryRenderKind;
  reason: string;
};

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let output = '';
  let used = 0;
  const encoder = new TextEncoder();
  for (const char of value) {
    const bytes = encoder.encode(char).byteLength;
    if (used + bytes > maxBytes) break;
    output += char;
    used += bytes;
  }
  return output;
}

function cap(value: string, maxBytes: number): string {
  return utf8ByteLength(value) > maxBytes ? truncateUtf8(value, maxBytes) : value;
}

export function renderMemoryContextItem(input: MemoryRenderInput): MemoryRenderResult {
  if (!isMemoryRenderKind(input.kind)) {
    return { ok: false, text: '', kind: input.kind, reason: 'unsupported_render_kind' };
  }
  const maxBytes = Math.max(1, input.maxBytes ?? MEMORY_DEFAULTS.startupTotalTokens);
  try {
    switch (input.kind) {
      case 'pinned':
        return { ok: true, kind: input.kind, text: input.content };
      case 'skill':
        return { ok: true, kind: input.kind, text: renderSkillEnvelope(input.content) };
      case 'citation_preview':
        if (!input.authorizedRawSource) {
          return { ok: false, text: '', kind: input.kind, reason: 'unauthorized_citation_preview' };
        }
        return { ok: true, kind: input.kind, text: cap(input.content, maxBytes) };
      case 'summary':
      case 'preference':
      case 'note':
        return { ok: true, kind: input.kind, text: cap(input.content.trim(), maxBytes) };
    }
  } catch (error) {
    return {
      ok: false,
      text: '',
      kind: input.kind,
      reason: error instanceof Error ? error.message : 'render_failed',
    };
  }
}

export interface RenderMemoryContextItemsOptions {
  telemetry?: Pick<MemoryTelemetryBuffer, 'enqueue'>;
}

export function renderMemoryContextItems(
  inputs: readonly MemoryRenderInput[],
  options: RenderMemoryContextItemsOptions = {},
): string[] {
  const rendered: string[] = [];
  for (const input of inputs) {
    const result = renderMemoryContextItem(input);
    if (result.ok) {
      rendered.push(result.text);
      continue;
    }
    options.telemetry?.enqueue('mem.startup.stage_dropped', {
      outcome: 'dropped',
      reason: 'render_failed',
    });
  }
  return rendered;
}
