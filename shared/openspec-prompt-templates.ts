import enLocale from '../web/src/i18n/locales/en.json' with { type: 'json' };

export type OpenSpecPromptTemplateId =
  | 'audit_implementation'
  | 'audit_spec'
  | 'implement';

type OpenSpecPromptLocale = {
  openspec: Record<'audit_implementation_prompt' | 'audit_spec_prompt' | 'implement_prompt', string>;
};

const OPEN_SPEC_PROMPT_TEMPLATE_KEYS = {
  audit_implementation: 'audit_implementation_prompt',
  audit_spec: 'audit_spec_prompt',
  implement: 'implement_prompt',
} as const satisfies Record<OpenSpecPromptTemplateId, keyof OpenSpecPromptLocale['openspec']>;

export function getOpenSpecPromptTemplate(id: OpenSpecPromptTemplateId): string {
  return (enLocale as OpenSpecPromptLocale).openspec[OPEN_SPEC_PROMPT_TEMPLATE_KEYS[id]];
}

export function formatOpenSpecPromptTemplate(id: OpenSpecPromptTemplateId, reference: string): string {
  return getOpenSpecPromptTemplate(id).replace(/\{\{reference\}\}/g, reference);
}
