export interface TestSessionGuardInput {
  name?: string | null;
  projectName?: string | null;
  projectDir?: string | null;
  parentSession?: string | null;
  cwd?: string | null;
}

const SESSION_NAME_PATTERNS: RegExp[] = [
  /^e2e_/i,
  /^deck_e2e/i,
  /^deck_bootmain[a-z0-9-]+_(brain|w\d+)$/i,
  /^deck_modeawaree2e[a-z0-9-]+_(brain|w\d+)$/i,
  /^deck_qwene2e_[a-z0-9]+_brain$/i,
  /^deck_reconntest[a-z0-9-]+_w\d+$/i,
  /^deck_restorecheck[a-z0-9-]+_(brain|w\d+)$/i,
  /^deck_shutdown[a-z0-9-]+_(brain|w\d+|probe)$/i,
  /^deck_sub_(?:cxsdk_e2e|cxsdk_effort|ccsdk_minimax_sub)$/i,
];

const PROJECT_NAME_PATTERNS: RegExp[] = [
  /^bootmain[a-z0-9-]+$/i,
  /^modeawaree2e[a-z0-9-]+$/i,
  /^qwene2e$/i,
  /^reconntest[a-z0-9-]+$/i,
  /^restorecheck[a-z0-9-]+$/i,
  /^shutdown[a-z0-9-]+$/i,
  /^e2e[-_]/i,
];

const PROJECT_DIR_PATTERNS: RegExp[] = [
  /[/\\]tmp[/\\].*e2e/i,
  /[/\\]tmp[/\\].*modeaware/i,
  /[/\\]tmp[/\\].*bootmain/i,
];

function normalize(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function matchesAny(value: string | undefined, patterns: readonly RegExp[]): boolean {
  if (!value) return false;
  return patterns.some((pattern) => pattern.test(value));
}

export function isKnownTestSessionName(value: string | null | undefined): boolean {
  return matchesAny(normalize(value), SESSION_NAME_PATTERNS);
}

export function isKnownTestProjectName(value: string | null | undefined): boolean {
  return matchesAny(normalize(value), PROJECT_NAME_PATTERNS);
}

export function isKnownTestProjectDir(value: string | null | undefined): boolean {
  return matchesAny(normalize(value), PROJECT_DIR_PATTERNS);
}

export function isKnownTestSessionLike(input: TestSessionGuardInput): boolean {
  return (
    isKnownTestSessionName(input.name)
    || isKnownTestProjectName(input.projectName)
    || isKnownTestProjectDir(input.projectDir)
    || isKnownTestSessionName(input.parentSession)
    || isKnownTestProjectDir(input.cwd)
  );
}
