import profiles from './controlled-node-abi-profiles.json' with { type: 'json' };

export type ControlledNodeAbiProfile = 'modern' | 'linux-glibc217';
export const CONTROLLED_NODE_ABI_MODERN: ControlledNodeAbiProfile = profiles.MODERN.id as ControlledNodeAbiProfile;
export const CONTROLLED_NODE_ABI_GLIBC217: ControlledNodeAbiProfile = profiles.GLIBC217.id as ControlledNodeAbiProfile;
export const CONTROLLED_NODE_ABI_PROFILES = profiles;
export const CONTROLLED_NODE_ABI_PROFILE_FIELD = 'abiProfile' as const;

/** Missing fields belong only to the original modern protocol. Unknowns never normalize to modern. */
export function normalizeControlledNodeAbiProfile(value: unknown): ControlledNodeAbiProfile | null {
  if (value === undefined) return CONTROLLED_NODE_ABI_MODERN;
  if (value === CONTROLLED_NODE_ABI_MODERN) return CONTROLLED_NODE_ABI_MODERN;
  if (value === CONTROLLED_NODE_ABI_GLIBC217) return CONTROLLED_NODE_ABI_GLIBC217;
  return null;
}

export function isControlledNodeAbiTarget(os: string, arch: string, profile: unknown): boolean {
  const normalized = normalizeControlledNodeAbiProfile(profile);
  return normalized !== null
    && (normalized === CONTROLLED_NODE_ABI_MODERN || (os === 'linux' && arch === 'x64'));
}

/** The executable's identity is baked into SEA; a caller-controlled environment cannot change its ABI. */
declare const __IMCODES_NODE_ABI_PROFILE__: unknown;
export const CONTROLLED_NODE_RUNTIME_ABI_PROFILE: ControlledNodeAbiProfile = (() => {
  const raw = typeof __IMCODES_NODE_ABI_PROFILE__ === 'undefined' ? undefined : __IMCODES_NODE_ABI_PROFILE__;
  const normalized = normalizeControlledNodeAbiProfile(raw);
  if (!normalized) throw new Error('invalid_compiled_node_abi_profile');
  return normalized;
})();

/** Authenticated database ticket binding; never accepts a wire-supplied digest as authority. */
export function enrollmentAbiDigest(
  binding: { os: string; arch: string; abiProfile?: unknown; sha256: string; variants?: unknown; allowVariants: boolean },
  requestedProfile: ControlledNodeAbiProfile,
): string | null {
  if (!isControlledNodeAbiTarget(binding.os, binding.arch, requestedProfile)) return null;
  const boundProfile = normalizeControlledNodeAbiProfile(binding.abiProfile);
  if (!boundProfile) return null;
  if (boundProfile === requestedProfile) return binding.sha256;
  if (!binding.allowVariants || !binding.variants || typeof binding.variants !== 'object' || Array.isArray(binding.variants)) return null;
  const digest = (binding.variants as Record<string, unknown>)[requestedProfile];
  return typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest) ? digest : null;
}
