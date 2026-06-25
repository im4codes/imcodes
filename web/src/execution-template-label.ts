import { resolveEffectiveSessionModel, type SessionModelMetadata } from '@shared/session-model.js';

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function pushUnique(parts: string[], value: string | null | undefined): void {
  const trimmed = nonEmpty(value);
  if (!trimmed) return;
  if (parts.some((part) => part.toLowerCase() === trimmed.toLowerCase())) return;
  parts.push(trimmed);
}

export function buildExecutionTemplateLabel(input: SessionModelMetadata & {
  shortName: string;
  agentType?: string | null;
  ccPreset?: string | null;
}): string {
  const parts: string[] = [];
  pushUnique(parts, input.shortName);
  pushUnique(parts, input.agentType);
  pushUnique(parts, input.ccPreset);
  pushUnique(parts, resolveEffectiveSessionModel(input));
  return parts.join(' · ');
}
