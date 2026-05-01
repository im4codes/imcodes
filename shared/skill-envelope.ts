import { MEMORY_DEFAULTS } from './memory-defaults.js';

export const SKILL_ENVELOPE_OPEN = '<<<imcodes-skill v1>>>';
export const SKILL_ENVELOPE_CLOSE = '<<<imcodes-skill-end>>>';
export const SKILL_ENVELOPE_COLLISION_PATTERN = /<<<imcodes-skill/gi;
export const SKILL_MAX_BYTES = MEMORY_DEFAULTS.skillMaxBytes;
export const SKILL_ENVELOPE_COLLISION_POLICY = 'escape' as const;
export const SKILL_SYSTEM_INSTRUCTION_GUARD_PATTERNS = [
  /(?:^|\n)\s*(?:system|developer)\s*:/i,
  /\bignore\s+(?:all\s+)?(?:previous|prior)\s+instructions\b/i,
  /\b(?:act|behave)\s+as\s+(?:the\s+)?(?:system|developer)\b/i,
  /<\/?\s*(?:system|developer)\s*>/i,
] as const;

export type SkillEnvelopeCollisionPolicy = typeof SKILL_ENVELOPE_COLLISION_POLICY | 'reject';

export interface SkillEnvelopeSanitizeResult {
  ok: boolean;
  content: string;
  collision: boolean;
  systemInstructionGuard: boolean;
  truncated: boolean;
  reason?: string;
}

export interface SkillEnvelopeSanitizeOptions {
  collisionPolicy?: SkillEnvelopeCollisionPolicy;
  guardSystemInstructions?: boolean;
  maxBytes?: number;
}

const SKILL_DELIMITER_ESCAPE = '<<<imcodes\u200b-skill';

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let output = '';
  let used = 0;
  const encoder = new TextEncoder();
  for (const char of value) {
    const bytes = encoder.encode(char).byteLength;
    if (used + bytes > maxBytes) break;
    output += char;
    used += bytes;
  }
  return output;
}

export function containsSkillEnvelopeDelimiter(content: string): boolean {
  SKILL_ENVELOPE_COLLISION_PATTERN.lastIndex = 0;
  return SKILL_ENVELOPE_COLLISION_PATTERN.test(content);
}

export function violatesSkillSystemInstructionGuard(content: string): boolean {
  return SKILL_SYSTEM_INSTRUCTION_GUARD_PATTERNS.some((pattern) => pattern.test(content));
}

function normalizeSanitizeOptions(
  options: SkillEnvelopeCollisionPolicy | SkillEnvelopeSanitizeOptions | undefined,
): Required<SkillEnvelopeSanitizeOptions> {
  if (typeof options === 'string') {
    return {
      collisionPolicy: options,
      guardSystemInstructions: true,
      maxBytes: SKILL_MAX_BYTES,
    };
  }
  return {
    collisionPolicy: options?.collisionPolicy ?? SKILL_ENVELOPE_COLLISION_POLICY,
    guardSystemInstructions: options?.guardSystemInstructions ?? true,
    maxBytes: Math.max(1, options?.maxBytes ?? SKILL_MAX_BYTES),
  };
}

export function sanitizeSkillEnvelopeContent(
  content: string,
  options?: SkillEnvelopeCollisionPolicy | SkillEnvelopeSanitizeOptions,
): SkillEnvelopeSanitizeResult {
  const resolved = normalizeSanitizeOptions(options);
  const systemInstructionGuard = resolved.guardSystemInstructions && violatesSkillSystemInstructionGuard(content);
  if (systemInstructionGuard) {
    return {
      ok: false,
      content: '',
      collision: false,
      systemInstructionGuard: true,
      truncated: false,
      reason: 'Skill content attempts to act as system/developer instructions',
    };
  }
  const collision = containsSkillEnvelopeDelimiter(content);
  if (collision && resolved.collisionPolicy === 'reject') {
    return {
      ok: false,
      content: '',
      collision,
      systemInstructionGuard: false,
      truncated: false,
      reason: 'Skill content contains an imcodes skill envelope delimiter',
    };
  }
  const escaped = collision ? content.replace(SKILL_ENVELOPE_COLLISION_PATTERN, SKILL_DELIMITER_ESCAPE) : content;
  const truncated = utf8ByteLength(escaped) > resolved.maxBytes;
  const capped = truncated ? truncateUtf8(escaped, resolved.maxBytes) : escaped;
  return { ok: true, content: capped, collision, systemInstructionGuard: false, truncated };
}

export function renderSkillEnvelope(content: string, options?: SkillEnvelopeCollisionPolicy | SkillEnvelopeSanitizeOptions): string {
  const sanitized = sanitizeSkillEnvelopeContent(content, options);
  if (!sanitized.ok) throw new Error(sanitized.reason ?? 'Skill content rejected');
  return `${SKILL_ENVELOPE_OPEN}\n${sanitized.content}\n${SKILL_ENVELOPE_CLOSE}`;
}
