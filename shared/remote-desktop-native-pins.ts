import nativePins from './remote-desktop-native-pins.json' with { type: 'json' };

const GIT_REVISION_RE = /^[a-f0-9]{40}$/;

function requirePinnedRevision(value: unknown, name: string): string {
  if (typeof value !== 'string' || !GIT_REVISION_RE.test(value)) {
    throw new Error(`invalid ${name} revision pin`);
  }
  return value;
}

export const PINNED_LIBWEBRTC_REVISION = requirePinnedRevision(
  nativePins.libwebrtcRevision,
  'libwebrtc',
);
export const PINNED_DEPOT_TOOLS_REVISION = requirePinnedRevision(
  nativePins.depotToolsRevision,
  'depot_tools',
);
