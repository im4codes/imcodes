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

/**
 * Audit-criteria-only variant of the audit templates. The canonical templates
 * are single-agent "audit AND repair in one turn" prompts — they end with a
 * repair directive ("; then directly update the change artifacts …" /
 * "; then fix the code …" + "Do not stop at …"). Auto Deliver splits that flow
 * into audit → repair → acceptance turns, so audit-only turns (the Team
 * discussion and the final acceptance scoring pass) MUST NOT embed the "edit
 * now" directive — it directly contradicts their "do not repair in this turn"
 * contract and makes models repair when they should only review (or vice
 * versa), which is why multi-round runs failed to converge. This strips the
 * template at the repair clause; repair turns keep the full template.
 */
export function formatOpenSpecAuditStandardTemplate(
  id: 'audit_spec' | 'audit_implementation',
  reference: string,
): string {
  const full = formatOpenSpecPromptTemplate(id, reference);
  const repairClauseIndex = full.indexOf('; then ');
  return repairClauseIndex === -1 ? full : `${full.slice(0, repairClauseIndex)}.`;
}
