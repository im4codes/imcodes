import { describe, expect, it } from 'vitest';
import en from '../../web/src/i18n/locales/en.json' with { type: 'json' };
import {
  formatOpenSpecPromptTemplate,
  getOpenSpecPromptTemplate,
} from '../../shared/openspec-prompt-templates.js';

describe('OpenSpec prompt templates', () => {
  it('reuses the English OpenSpec quick-action prompt source', () => {
    expect(getOpenSpecPromptTemplate('audit_implementation')).toBe(en.openspec.audit_implementation_prompt);
    expect(getOpenSpecPromptTemplate('audit_spec')).toBe(en.openspec.audit_spec_prompt);
    expect(getOpenSpecPromptTemplate('implement')).toBe(en.openspec.implement_prompt);
  });

  it('formats only the folder reference placeholder', () => {
    expect(formatOpenSpecPromptTemplate('implement', '@openspec/changes/example-change'))
      .toContain('Drive the implementation of @openspec/changes/example-change aggressively.');
    expect(formatOpenSpecPromptTemplate('audit_implementation', '@openspec/changes/example-change'))
      .toContain('under @openspec/changes/example-change in the same task.');
    expect(formatOpenSpecPromptTemplate('audit_spec', '@openspec/changes/example-change'))
      .toContain('for @openspec/changes/example-change.');
  });
});
