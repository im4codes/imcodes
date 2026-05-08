import { computeMemoryFingerprint } from './memory-fingerprint.js';
import { MEMORY_FEATURE_FLAGS_BY_NAME } from './feature-flags.js';
import { MEMORY_DEFAULTS } from './memory-defaults.js';
import type { MemoryOrigin } from './memory-origin.js';
import { recordMemorySoftFailure, type MemoryTelemetryBuffer } from './memory-telemetry.js';

export const MD_INGEST_FEATURE_FLAG = MEMORY_FEATURE_FLAGS_BY_NAME.mdIngest;
export const MD_INGEST_ORIGIN = 'md_ingest' as const satisfies MemoryOrigin;
export const MD_INGEST_SUPPORTED_PATHS = [
  'CLAUDE.md',
  'AGENTS.md',
  '.imc/memory.md',
  '.imcodes/memory.md',
] as const;
export type MdIngestSupportedPath = (typeof MD_INGEST_SUPPORTED_PATHS)[number];

export const MD_INGEST_SECTION_CLASSES = ['preference', 'workflow', 'code_pattern', 'note'] as const;
export type MdIngestSectionClass = (typeof MD_INGEST_SECTION_CLASSES)[number];

export interface MdIngestCaps {
  maxBytes: number;
  maxSections: number;
  maxSectionBytes: number;
  parserBudgetMs: number;
  allowSymlinks: boolean;
}

export const DEFAULT_MD_INGEST_CAPS: MdIngestCaps = {
  maxBytes: MEMORY_DEFAULTS.markdownMaxBytes,
  maxSections: MEMORY_DEFAULTS.markdownMaxSections,
  maxSectionBytes: MEMORY_DEFAULTS.markdownMaxSectionBytes,
  parserBudgetMs: MEMORY_DEFAULTS.markdownParserBudgetMs,
  allowSymlinks: false,
};

export type MdIngestSkipReason =
  | 'feature_disabled'
  | 'unsupported_path'
  | 'symlink_disallowed'
  | 'size_capped'
  | 'invalid_encoding'
  | 'unsafe_prompt_instruction'
  | 'section_count_capped'
  | 'section_size_capped'
  | 'parser_budget_exceeded';

export interface MdIngestSection {
  class: MdIngestSectionClass;
  heading: string;
  text: string;
  fingerprint: string;
  origin: typeof MD_INGEST_ORIGIN;
}

export interface MdIngestResult {
  sections: MdIngestSection[];
  skipped: Array<{ reason: MdIngestSkipReason; heading?: string }>;
  partial: boolean;
}

export interface ParseMdIngestOptions {
  path: string;
  content: string | Uint8Array;
  scopeKey: string;
  featureEnabled: boolean;
  isSymlink?: boolean;
  caps?: Partial<MdIngestCaps>;
  telemetry?: Pick<MemoryTelemetryBuffer, 'enqueue'>;
}

const SECTION_CLASS_BY_HEADING: Array<[RegExp, MdIngestSectionClass]> = [
  [/preferences?|prefs?/i, 'preference'],
  [/workflow|process|playbook/i, 'workflow'],
  [/code\s*patterns?|patterns?/i, 'code_pattern'],
  [/notes?|memory/i, 'note'],
];

function capsWithDefaults(caps?: Partial<MdIngestCaps>): MdIngestCaps {
  return { ...DEFAULT_MD_INGEST_CAPS, ...caps };
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function isSupportedMdIngestPath(path: string): path is MdIngestSupportedPath {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return MD_INGEST_SUPPORTED_PATHS.includes(normalized as MdIngestSupportedPath);
}

function decodeUtf8(input: string | Uint8Array): string | null {
  if (typeof input === 'string') return input;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    return null;
  }
}

function classifyHeading(heading: string): MdIngestSectionClass {
  return SECTION_CLASS_BY_HEADING.find(([pattern]) => pattern.test(heading))?.[1] ?? 'note';
}

function containsUnsafePromptInstruction(text: string): boolean {
  return /ignore\s+(all\s+)?(previous|prior)\s+(system|developer)?\s*instructions|developer\s+message|system\s+prompt/i.test(text);
}

export function parseMdIngestDocument(options: ParseMdIngestOptions): MdIngestResult {
  const caps = capsWithDefaults(options.caps);
  const startedAt = Date.now();
  const skipped: MdIngestResult['skipped'] = [];
  const budgetExceeded = (): boolean => caps.parserBudgetMs < 0 || Date.now() - startedAt > caps.parserBudgetMs;
  const skipAll = (reason: MdIngestSkipReason): MdIngestResult => {
    recordMemorySoftFailure(options.telemetry, 'md_ingest', reason, { outcome: reason === 'feature_disabled' ? 'disabled' : 'rejected' });
    return { sections: [], skipped: [{ reason }], partial: false };
  };
  if (!options.featureEnabled) return skipAll('feature_disabled');
  if (!isSupportedMdIngestPath(options.path)) return skipAll('unsupported_path');
  if (options.isSymlink && !caps.allowSymlinks) return skipAll('symlink_disallowed');

  const content = decodeUtf8(options.content);
  if (content === null) return skipAll('invalid_encoding');
  if (utf8Bytes(content) > caps.maxBytes) return skipAll('size_capped');

  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const rawSections: Array<{ heading: string; text: string }> = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of lines) {
    if (budgetExceeded()) {
      skipped.push({ reason: 'parser_budget_exceeded', heading: current?.heading });
      recordMemorySoftFailure(options.telemetry, 'md_ingest', 'parser_budget_exceeded', { outcome: 'dropped' });
      break;
    }
    const headingMatch = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      if (current) rawSections.push({ heading: current.heading, text: current.lines.join('\n').trim() });
      current = { heading: headingMatch[2] ?? 'Notes', lines: [] };
      continue;
    }
    if (!current) current = { heading: 'Notes', lines: [] };
    current.lines.push(line);
  }
  if (current) rawSections.push({ heading: current.heading, text: current.lines.join('\n').trim() });

  const sections: MdIngestSection[] = [];
  for (const section of rawSections) {
    if (budgetExceeded()) {
      skipped.push({ reason: 'parser_budget_exceeded', heading: section.heading });
      recordMemorySoftFailure(options.telemetry, 'md_ingest', 'parser_budget_exceeded', { outcome: 'dropped' });
      break;
    }
    if (!section.text) continue;
    if (sections.length >= caps.maxSections) {
      skipped.push({ reason: 'section_count_capped', heading: section.heading });
      recordMemorySoftFailure(options.telemetry, 'md_ingest', 'section_count_capped', { outcome: 'dropped' });
      break;
    }
    if (utf8Bytes(section.text) > caps.maxSectionBytes) {
      skipped.push({ reason: 'section_size_capped', heading: section.heading });
      recordMemorySoftFailure(options.telemetry, 'md_ingest', 'section_size_capped', { outcome: 'dropped' });
      continue;
    }
    if (containsUnsafePromptInstruction(section.text)) {
      skipped.push({ reason: 'unsafe_prompt_instruction', heading: section.heading });
      recordMemorySoftFailure(options.telemetry, 'md_ingest', 'unsafe_prompt_instruction', { outcome: 'rejected' });
      continue;
    }
    const klass = classifyHeading(section.heading);
    sections.push({
      class: klass,
      heading: section.heading,
      text: section.text,
      fingerprint: computeMemoryFingerprint({
        kind: klass === 'preference' ? 'preference' : 'note',
        content: section.text,
        scopeKey: options.scopeKey,
      }),
      origin: MD_INGEST_ORIGIN,
    });
  }

  return { sections, skipped, partial: skipped.length > 0 && sections.length > 0 };
}
