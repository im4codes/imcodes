import { describe, expect, it } from 'vitest';
import {
  P2P_PROMPT_SECTION_ORDER,
  assembleP2pPromptSections,
  projectP2pPromptForTransport,
  type P2pPromptSection,
} from '../../shared/p2p-workflow-prompt.js';

describe('p2p workflow prompt assembly', () => {
  it('orders sections deterministically and keeps prompt append additive', () => {
    const sections: P2pPromptSection[] = [
      { kind: 'prompt_append', text: 'user extra ${literal}' },
      { kind: 'system_runtime_contract', text: 'runtime' },
      { kind: 'final_runtime_guardrail', text: 'guardrail' },
    ];
    const assembled = assembleP2pPromptSections(sections);
    expect(assembled.ok).toBe(true);
    expect(assembled.sections.map((section) => section.kind)).toEqual([
      'system_runtime_contract',
      'prompt_append',
      'final_runtime_guardrail',
    ]);
    expect(P2P_PROMPT_SECTION_ORDER.at(-1)).toBe('final_runtime_guardrail');
  });

  it('rejects forbidden control characters in prompt append', () => {
    const assembled = assembleP2pPromptSections([{ kind: 'prompt_append', text: 'bad\0text' }]);
    expect(assembled.ok).toBe(false);
    expect(assembled.diagnostics[0]?.code).toBe('invalid_prompt_append');
  });

  it('projects chat sections into real roles', () => {
    const projection = projectP2pPromptForTransport([
      { kind: 'system_runtime_contract', text: 'system' },
      { kind: 'structured_context_references', text: 'context' },
      { kind: 'previous_evidence_summary', text: 'summary' },
      { kind: 'final_runtime_guardrail', text: 'guardrail' },
    ], 'chat');
    expect(projection.kind).toBe('chat');
    if (projection.kind === 'chat') {
      expect(projection.messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'system']);
      expect(projection.messages.at(-1)?.content).toBe('guardrail');
    }
  });

  it('uses collision-safe plaintext fences', () => {
    const projection = projectP2pPromptForTransport([
      { kind: 'system_runtime_contract', text: 'contains <<<P2P_SECTION_0>>>' },
      { kind: 'final_runtime_guardrail', text: 'last' },
    ], 'plaintext');
    expect(projection.kind).toBe('plaintext');
    if (projection.kind === 'plaintext') {
      expect(projection.text).toContain('<<<P2P_SECTION_1>>> system_runtime_contract');
      expect(projection.text).toContain('<<<P2P_SECTION_0>>> final_runtime_guardrail');
    }
  });
});
