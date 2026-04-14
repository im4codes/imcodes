import type {
  CompiledAgentContextArtifact,
  ContextAuthorityDecision,
  ProviderSupportClass,
} from '../../shared/context-types.js';

export interface ContextDiagnosticsInput {
  authority: ContextAuthorityDecision;
  supportClass: ProviderSupportClass;
  artifact: CompiledAgentContextArtifact;
}

export function buildContextDiagnostics(input: ContextDiagnosticsInput): string[] {
  const diagnostics = new Set<string>(input.authority.diagnostics);
  diagnostics.add(`support:${input.supportClass}`);
  diagnostics.add(`authority:${input.authority.authoritySource}`);
  diagnostics.add(`freshness:${input.authority.freshness}`);
  diagnostics.add(`provider-policy:${input.authority.providerPolicyOutcome}`);
  if (input.authority.retryScheduled) diagnostics.add('retry-scheduled');
  if (input.authority.fallbackAllowed) diagnostics.add('fallback-allowed');
  for (const versionId of input.artifact.appliedDocumentVersionIds) {
    diagnostics.add(`document-version:${versionId}`);
  }
  for (const entry of input.artifact.diagnostics) {
    diagnostics.add(entry);
  }
  return [...diagnostics];
}
