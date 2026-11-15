/**
 * Canonical model-facing contracts for file and Cloud Doc outputs.
 *
 * Keep these compact: they are delivered in the stable transport system
 * context and referenced by supervision preambles. Prompt builders must import
 * these renderers instead of restating any part of the rules.
 */
export const FILE_OUTPUT_CONTRACT_ID = 'file_output_v1' as const;
export const CLOUD_DOC_OUTPUT_CONTRACT_ID = 'cloud_doc_output_v1' as const;

export const FILE_OUTPUT_CONTRACT = Object.freeze({
  contractId: FILE_OUTPUT_CONTRACT_ID,
  v: 1,
  scope: 'local_files_only_never_cloud_docs',
  files: 'produced_or_referenced',
  markdown: '[display name](/absolute/full/path)',
  absoluteTarget: 'required',
  visible: 'name_only',
  rawPath: 'do_not_print_separately',
  angleDestination: '<...> for space/parentheses',
  repoRelative: 'resolve_against_workspace_if_only_known',
  cloudDocs: `use_${CLOUD_DOC_OUTPUT_CONTRACT_ID}`,
} as const);

export const CLOUD_DOC_OUTPUT_CONTRACT = Object.freeze({
  contractId: CLOUD_DOC_OUTPUT_CONTRACT_ID,
  v: 1,
  scope: 'cloud_docs_cdoc_ids_every_turn_every_mention',
  token: '[CloudDoc: <name> | id=<docId>]',
  when: 'create|read|list|edit|rename|builder|convert|upload|share|any_mention',
  turns: 'required_in_turn_1_turn_2_and_all_later_replies',
  repeatedMentions: 'full_token_on_every_occurrence_never_drop_id',
  afterRename: 'use_latest_name_and_keep_same_id',
  forbidden: [
    'bare_filename',
    'backtick_filename_only',
    'split_name_then_id_parens',
    'local_markdown_path_link',
  ],
} as const);

export function buildFileOutputContract(): string {
  return JSON.stringify(FILE_OUTPUT_CONTRACT);
}

export function buildCloudDocOutputContract(): string {
  return JSON.stringify(CLOUD_DOC_OUTPUT_CONTRACT);
}
