export const BUILTIN_SKILL_MANIFEST_VERSION = 1 as const;

export interface BuiltinSkillManifestEntry {
  name: string;
  category: string;
  path: string;
  description?: string;
  version?: string;
}

export interface BuiltinSkillManifest {
  version: typeof BUILTIN_SKILL_MANIFEST_VERSION;
  skills: readonly BuiltinSkillManifestEntry[];
}

export const EMPTY_BUILTIN_SKILL_MANIFEST: BuiltinSkillManifest = {
  version: BUILTIN_SKILL_MANIFEST_VERSION,
  skills: [],
};

export function validateBuiltinSkillManifest(value: unknown): BuiltinSkillManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid built-in skill manifest: expected object');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== BUILTIN_SKILL_MANIFEST_VERSION) {
    throw new Error('Invalid built-in skill manifest: unsupported version');
  }
  if (!Array.isArray(record.skills)) {
    throw new Error('Invalid built-in skill manifest: skills must be an array');
  }
  for (const skill of record.skills) {
    if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
      throw new Error('Invalid built-in skill manifest: skill entry must be an object');
    }
    const entry = skill as Record<string, unknown>;
    if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
      throw new Error('Invalid built-in skill manifest: skill name is required');
    }
    if (typeof entry.category !== 'string' || entry.category.trim().length === 0) {
      throw new Error('Invalid built-in skill manifest: skill category is required');
    }
    if (typeof entry.path !== 'string' || entry.path.trim().length === 0) {
      throw new Error('Invalid built-in skill manifest: skill path is required');
    }
  }
  return record as unknown as BuiltinSkillManifest;
}
