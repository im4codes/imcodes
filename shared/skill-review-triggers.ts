export const SKILL_REVIEW_TRIGGERS = [
  'tool_iteration_count',
  'manual_review',
] as const;

export type SkillReviewTrigger = (typeof SKILL_REVIEW_TRIGGERS)[number];

const SKILL_REVIEW_TRIGGER_SET: ReadonlySet<string> = new Set(SKILL_REVIEW_TRIGGERS);

export function isSkillReviewTrigger(value: unknown): value is SkillReviewTrigger {
  return typeof value === 'string' && SKILL_REVIEW_TRIGGER_SET.has(value);
}
