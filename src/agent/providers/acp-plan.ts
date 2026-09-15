/** Map ACP plan entries to the checklist input shape consumed by the shared
 *  timeline renderer. ACP PlanEntry uses {content, priority, status}; tolerate
 *  older agents that sent {title}. */
export function acpPlanEntriesToInput(entries: unknown): { plan: Array<{ content: string; status: string }> } | null {
  if (!Array.isArray(entries)) return null;
  const plan: Array<{ content: string; status: string }> = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const rawText = typeof record.content === 'string'
      ? record.content
      : typeof record.title === 'string' ? record.title : '';
    const content = rawText.trim();
    if (!content) continue;
    const status = typeof record.status === 'string' ? record.status : 'pending';
    plan.push({ content, status });
  }
  return plan.length > 0 ? { plan } : null;
}
