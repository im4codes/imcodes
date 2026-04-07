export function normalizeOpenClawDisplayName(displayName: string | undefined): string | undefined {
  if (!displayName) return displayName;
  if (displayName.startsWith('discord:')) {
    const hashIndex = displayName.indexOf('#');
    if (hashIndex >= 0) return displayName.slice(hashIndex);
  }
  return displayName;
}

export function preferredOpenClawLabel(
  existingLabel: string | undefined,
  remoteDisplayName: string | undefined,
  providerKey: string,
): string {
  const normalizedDisplayName = normalizeOpenClawDisplayName(remoteDisplayName);
  if (!existingLabel) return normalizedDisplayName || providerKey;
  if (existingLabel === providerKey) return normalizedDisplayName || existingLabel;
  if (existingLabel.startsWith('discord:')) return normalizedDisplayName || existingLabel;
  return existingLabel;
}
