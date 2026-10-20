/**
 * Canonical model-facing contract for local file output.
 *
 * Keep this compact: it is delivered both in the stable transport system
 * context and in supervision preambles. Prompt builders must import this
 * renderer instead of restating any part of the rule.
 */
export const FILE_OUTPUT_CONTRACT_ID = 'file_output_v1' as const;

export const FILE_OUTPUT_CONTRACT = Object.freeze({
  contractId: FILE_OUTPUT_CONTRACT_ID,
  v: 1,
  files: 'produced_or_referenced',
  markdown: '[display name](/absolute/full/path)',
  absoluteTarget: 'required',
  visible: 'name_only',
  rawPath: 'do_not_print_separately',
  angleDestination: '<...> for space/parentheses',
  repoRelative: 'resolve_against_workspace_if_only_known',
} as const);

export function buildFileOutputContract(): string {
  return JSON.stringify(FILE_OUTPUT_CONTRACT);
}
