import { P2P_WORKFLOW_MAX_PROMPT_APPEND_BYTES } from './p2p-workflow-constants.js';
import { makeP2pWorkflowDiagnostic, type P2pWorkflowDiagnostic } from './p2p-workflow-diagnostics.js';

export const P2P_PROMPT_SECTION_ORDER = [
  'system_runtime_contract',
  'preset_scaffold',
  'node_contract',
  'structured_context_references',
  'previous_evidence_summary',
  'prompt_append',
  'final_runtime_guardrail',
] as const;

export type P2pPromptSectionKind = (typeof P2P_PROMPT_SECTION_ORDER)[number];
export type P2pPromptTransportKind = 'plaintext' | 'chat';

export interface P2pPromptSection {
  kind: P2pPromptSectionKind;
  text: string;
}

export interface P2pChatPromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type P2pPromptProjection =
  | { kind: 'plaintext'; text: string }
  | { kind: 'chat'; messages: P2pChatPromptMessage[] };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertPromptAppendSafe(text: string): P2pWorkflowDiagnostic[] {
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  if (byteLength(text) > P2P_WORKFLOW_MAX_PROMPT_APPEND_BYTES) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_prompt_append', 'compile', { summary: 'promptAppend exceeds byte limit.' }));
  }
  if (/[\0\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
    diagnostics.push(makeP2pWorkflowDiagnostic('invalid_prompt_append', 'compile', { summary: 'promptAppend contains forbidden control characters.' }));
  }
  return diagnostics;
}

export function assembleP2pPromptSections(sections: P2pPromptSection[]): {
  ok: boolean;
  sections: P2pPromptSection[];
  diagnostics: P2pWorkflowDiagnostic[];
} {
  const diagnostics: P2pWorkflowDiagnostic[] = [];
  for (const section of sections) {
    if (section.kind === 'prompt_append') diagnostics.push(...assertPromptAppendSafe(section.text));
  }
  const ordered = [...sections].sort((left, right) =>
    P2P_PROMPT_SECTION_ORDER.indexOf(left.kind) - P2P_PROMPT_SECTION_ORDER.indexOf(right.kind));
  return { ok: diagnostics.length === 0, sections: ordered, diagnostics };
}

export function projectP2pPromptForTransport(
  sections: P2pPromptSection[],
  transportKind: P2pPromptTransportKind,
): P2pPromptProjection {
  const assembled = assembleP2pPromptSections(sections);
  if (!assembled.ok) {
    throw new Error(assembled.diagnostics.map((diagnostic) => diagnostic.code).join(','));
  }
  if (transportKind === 'chat') {
    return {
      kind: 'chat',
      messages: assembled.sections.map((section) => ({
        role: roleForSection(section.kind),
        content: section.text,
      })),
    };
  }
  return {
    kind: 'plaintext',
    text: assembled.sections.map((section) => {
      const fence = chooseFence(section.text);
      return `${fence} ${section.kind}\n${section.text}\n${fence}`;
    }).join('\n\n'),
  };
}

function roleForSection(kind: P2pPromptSectionKind): P2pChatPromptMessage['role'] {
  if (kind === 'previous_evidence_summary') return 'assistant';
  if (kind === 'prompt_append' || kind === 'structured_context_references') return 'user';
  return 'system';
}

function chooseFence(text: string): string {
  for (let index = 0; index < 100; index += 1) {
    const fence = `<<<P2P_SECTION_${index}>>>`;
    if (!text.includes(fence)) return fence;
  }
  throw new Error('Unable to choose collision-safe prompt fence');
}
