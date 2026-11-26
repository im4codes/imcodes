import profiles from '../shared/controlled-node-abi-profiles.json' with { type: 'json' };
import { sha256File } from './node-exe-artifacts.mjs';

export { profiles as CONTROLLED_NODE_ABI_PROFILES };
export const ABI_MODERN = profiles.MODERN.id;
export const ABI_GLIBC217 = profiles.GLIBC217.id;

export function resolveNodeExeAbiProfile(value, platform, arch) {
  const profile = value === undefined ? ABI_MODERN : value;
  if (!Object.values(profiles).some((entry) => entry.id === profile)) throw new Error('unknown controlled-node ABI profile');
  if (profile !== ABI_MODERN && (platform !== 'linux' || arch !== 'x64')) {
    throw new Error('glibc217 controlled-node profile requires Linux x64');
  }
  return profile;
}

/** Community artifacts have a distinct provider and immutable reviewed pin, not an official mirror exception. */
export async function verifyCompatNodeArtifact(path, pin = profiles.GLIBC217) {
  const actual = await sha256File(path);
  if (actual !== pin.nodeArchiveSha256) throw new Error('compatible Node archive checksum mismatch');
  return actual;
}
