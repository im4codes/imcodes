import { isTransportSessionAgentType } from './agent-types.js';

const LEGACY_MODE_KEYS = new Set(['audit', 'review', 'plan', 'brainstorm', 'discuss']);
const COMBO_SEPARATOR = '>';

export type P2pAdvancedPresetKey = 'openspec';
export type P2pRoundPreset =
  | 'discussion'
  | 'openspec_propose'
  | 'proposal_audit'
  | 'implementation'
  | 'implementation_audit'
  | 'custom';
export type P2pRoundExecutionMode = 'single_main' | 'multi_dispatch';
export type P2pRoundPermissionScope = 'analysis_only' | 'artifact_generation' | 'implementation';
export type P2pRoundVerdictPolicy = 'none' | 'smart_gate' | 'forced_rework';
export type P2pContextReducerMode = 'reuse_existing_session' | 'clone_sdk_session';
export type P2pVerdictMarker = 'PASS' | 'REWORK';
export type P2pDispatchStyle = 'initiator_only' | 'worker_hops';
export type P2pSynthesisStyle = 'none' | 'initiator_summary';

export interface P2pContextReducerConfig {
  mode: P2pContextReducerMode;
  sessionName?: string;
  templateSession?: string;
}

export interface P2pAdvancedJumpRule {
  targetRoundId: string;
  marker?: P2pVerdictMarker;
  minTriggers: number;
  maxTriggers: number;
}

export interface P2pAdvancedRound {
  id: string;
  title: string;
  preset: P2pRoundPreset;
  executionMode: P2pRoundExecutionMode;
  permissionScope: P2pRoundPermissionScope;
  timeoutMinutes?: number;
  artifactOutputs?: string[];
  promptAppend?: string;
  verdictPolicy?: P2pRoundVerdictPolicy;
  jumpRule?: P2pAdvancedJumpRule;
}

export interface P2pParticipantSnapshotEntry {
  sessionName: string;
  agentType: string;
  parentSession?: string | null;
}

export interface P2pHelperDiagnostic {
  code:
    | 'P2P_HELPER_PRIMARY_FAILED'
    | 'P2P_HELPER_FALLBACK_FAILED'
    | 'P2P_HELPER_CLEANUP_FAILED'
    | 'P2P_COMPRESSION_SKIPPED_NO_FALLBACK'
    | 'P2P_VERDICT_MISSING';
  attempt: number;
  sourceSession?: string | null;
  templateSession?: string | null;
  fallbackSession?: string | null;
  timestamp: number;
  message?: string;
}

export interface P2pResolvedRound {
  id: string;
  title: string;
  modeKey: string;
  preset: P2pRoundPreset;
  executionMode: P2pRoundExecutionMode;
  permissionScope: P2pRoundPermissionScope;
  timeoutMinutes: number;
  timeoutMs: number;
  promptAppend: string;
  verdictPolicy: P2pRoundVerdictPolicy;
  jumpRule?: P2pAdvancedJumpRule;
  dispatchStyle: P2pDispatchStyle;
  synthesisStyle: P2pSynthesisStyle;
  requiresVerdict: boolean;
  presetPrompt: string;
  summaryPrompt?: string;
  authoritativeVerdictWriter: 'initiator_summary' | 'initiator_only' | null;
  allowRouting: boolean;
  artifactOutputs: string[];
  artifactConvention: 'none' | 'explicit' | 'openspec_convention';
}

export interface ResolveP2pRoundPlanOptions {
  modeOverride?: string;
  roundsOverride?: number;
  hopTimeoutMinutes?: number;
  advancedPresetKey?: string | null;
  advancedRounds?: P2pAdvancedRound[] | null;
  advancedRunTimeoutMinutes?: number | null;
  contextReducer?: P2pContextReducerConfig | null;
  participants?: P2pParticipantSnapshotEntry[] | null;
}

export interface P2pResolvedPlan {
  advanced: boolean;
  rounds: P2pResolvedRound[];
  overallRunTimeoutMinutes?: number;
  contextReducer?: P2pContextReducerConfig;
  helperEligibleSnapshot?: P2pParticipantSnapshotEntry[];
}

const DEFAULT_HOP_TIMEOUT_MINUTES = 8;
const DEFAULT_ADVANCED_RUN_TIMEOUT_MINUTES = 30;

function parseModePipeline(mode: string): string[] {
  if (mode.includes(COMBO_SEPARATOR)) {
    return mode.split(COMBO_SEPARATOR).map((entry) => entry.trim()).filter(Boolean);
  }
  return [mode];
}

function isValidLegacyMode(mode: string): boolean {
  return LEGACY_MODE_KEYS.has(mode);
}

function validateLegacyMode(mode: string): void {
  const pipeline = parseModePipeline(mode);
  if (pipeline.length === 0 || pipeline.some((entry) => !isValidLegacyMode(entry))) {
    throw new Error(`Invalid P2P mode pipeline: ${mode}`);
  }
}

function cloneRound<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createOpenSpecPreset(): P2pAdvancedRound[] {
  return [
    {
      id: 'discussion',
      title: 'Discussion',
      preset: 'discussion',
      executionMode: 'multi_dispatch',
      permissionScope: 'analysis_only',
      timeoutMinutes: 5,
      verdictPolicy: 'none',
    },
    {
      id: 'openspec_propose',
      title: 'OpenSpec Propose',
      preset: 'openspec_propose',
      executionMode: 'single_main',
      permissionScope: 'artifact_generation',
      timeoutMinutes: 8,
      verdictPolicy: 'none',
    },
    {
      id: 'proposal_audit',
      title: 'Proposal Audit',
      preset: 'proposal_audit',
      executionMode: 'single_main',
      permissionScope: 'analysis_only',
      timeoutMinutes: 6,
      verdictPolicy: 'none',
    },
    {
      id: 'implementation',
      title: 'Implementation',
      preset: 'implementation',
      executionMode: 'multi_dispatch',
      permissionScope: 'implementation',
      timeoutMinutes: 8,
      verdictPolicy: 'none',
    },
    {
      id: 'implementation_audit',
      title: 'Implementation Audit',
      preset: 'implementation_audit',
      executionMode: 'single_main',
      permissionScope: 'analysis_only',
      timeoutMinutes: 6,
      verdictPolicy: 'smart_gate',
      jumpRule: {
        targetRoundId: 'implementation',
        marker: 'REWORK',
        minTriggers: 0,
        maxTriggers: 2,
      },
    },
  ];
}

export const BUILT_IN_ADVANCED_PRESETS: Record<P2pAdvancedPresetKey, P2pAdvancedRound[]> = {
  openspec: createOpenSpecPreset(),
};

const PRESET_PROMPTS: Record<P2pRoundPreset, string> = {
  discussion: 'Clarify the request, collect missing constraints, and synthesize the strongest next-step understanding from the evidence in the discussion file and referenced code.',
  openspec_propose: 'Produce an OpenSpec-ready proposal/design/tasks result from the discussion and code context. Write concrete artifacts, acceptance criteria, and implementation scope rather than broad notes.',
  proposal_audit: 'Audit the proposal artifacts for missing scope, missing acceptance criteria, contradictions, and weak assumptions. Strengthen the proposal without changing the requested objective.',
  implementation: 'Execute the implementation work required by the current round. Prefer concrete code and tests over commentary, while staying within the stated scope and artifact targets.',
  implementation_audit: 'Audit the implementation result against the requested scope, artifact outputs, and acceptance criteria. End with an authoritative verdict marker.',
  custom: 'Follow the configured round contract exactly. Stay within the declared permission scope and use the configured outputs and prompt append as the operative instruction.',
};

const SUMMARY_PROMPTS: Partial<Record<P2pRoundPreset, string>> = {
  discussion: 'Synthesize the key points, areas of agreement, and open questions from this round. Then assign concrete follow-up focus for the next round.',
  implementation: 'Synthesize the implementation outputs from the worker evidence. Produce one authoritative implementation summary that references the latest completed attempt.',
  implementation_audit: 'Write one authoritative audit synthesis and end with exactly one verdict marker line: `<!-- P2P_VERDICT: PASS -->` or `<!-- P2P_VERDICT: REWORK -->`.',
};

function buildLegacyResolvedRound(mode: string, roundIndex: number, totalRounds: number, hopTimeoutMinutes?: number): P2pResolvedRound {
  const pipeline = parseModePipeline(mode);
  const modeKey = pipeline[Math.min(roundIndex - 1, pipeline.length - 1)] ?? mode;
  return {
    id: `legacy_${roundIndex}`,
    title: `Round ${roundIndex}`,
    modeKey,
    preset: 'custom',
    executionMode: 'multi_dispatch',
    permissionScope: 'analysis_only',
    timeoutMinutes: hopTimeoutMinutes ?? DEFAULT_HOP_TIMEOUT_MINUTES,
    timeoutMs: (hopTimeoutMinutes ?? DEFAULT_HOP_TIMEOUT_MINUTES) * 60_000,
    promptAppend: '',
    verdictPolicy: 'none',
    dispatchStyle: 'worker_hops',
    synthesisStyle: 'initiator_summary',
    requiresVerdict: false,
    presetPrompt: '',
    summaryPrompt: totalRounds === roundIndex ? undefined : 'Synthesize the key points, areas of agreement, and open questions from this round. Then assign concrete follow-up focus for the next round.',
    authoritativeVerdictWriter: null,
    allowRouting: false,
    artifactOutputs: [],
    artifactConvention: 'none',
  };
}

function defaultArtifactConvention(round: P2pAdvancedRound): 'none' | 'explicit' | 'openspec_convention' {
  if (round.preset === 'openspec_propose' && (!round.artifactOutputs || round.artifactOutputs.length === 0)) {
    return 'openspec_convention';
  }
  if (round.permissionScope === 'artifact_generation') return 'explicit';
  return 'none';
}

function normalizeAdvancedRound(round: P2pAdvancedRound): P2pResolvedRound {
  const verdictPolicy = round.verdictPolicy ?? 'none';
  const artifactConvention = defaultArtifactConvention(round);
  const artifactOutputs = artifactConvention === 'openspec_convention'
    ? ['openspec/changes']
    : [...(round.artifactOutputs ?? [])];
  const synthesisStyle: P2pSynthesisStyle = round.executionMode === 'multi_dispatch' ? 'initiator_summary' : 'none';
  const requiresVerdict = verdictPolicy !== 'none';
  const authoritativeVerdictWriter = requiresVerdict
    ? (round.executionMode === 'multi_dispatch' ? 'initiator_summary' : 'initiator_only')
    : null;
  const allowRouting = round.preset !== 'proposal_audit' && requiresVerdict && !!round.jumpRule;
  return {
    id: round.id,
    title: round.title,
    modeKey: round.preset === 'custom' ? 'custom' : round.preset,
    preset: round.preset,
    executionMode: round.executionMode,
    permissionScope: round.permissionScope,
    timeoutMinutes: round.timeoutMinutes ?? DEFAULT_HOP_TIMEOUT_MINUTES,
    timeoutMs: (round.timeoutMinutes ?? DEFAULT_HOP_TIMEOUT_MINUTES) * 60_000,
    promptAppend: round.promptAppend?.trim() ?? '',
    verdictPolicy,
    jumpRule: round.jumpRule ? cloneRound(round.jumpRule) : undefined,
    dispatchStyle: round.executionMode === 'single_main' ? 'initiator_only' : 'worker_hops',
    synthesisStyle,
    requiresVerdict,
    presetPrompt: PRESET_PROMPTS[round.preset],
    summaryPrompt: synthesisStyle === 'initiator_summary' ? SUMMARY_PROMPTS[round.preset] : undefined,
    authoritativeVerdictWriter,
    allowRouting,
    artifactOutputs,
    artifactConvention,
  };
}

function validateAdvancedRoundIds(rounds: P2pAdvancedRound[]): void {
  const seen = new Set<string>();
  for (const round of rounds) {
    if (!round.id.trim()) throw new Error('Advanced P2P round ids must be non-empty');
    if (seen.has(round.id)) throw new Error(`Duplicate advanced P2P round id: ${round.id}`);
    seen.add(round.id);
  }
}

function validateContextReducer(
  reducer: P2pContextReducerConfig | null | undefined,
  participants: P2pParticipantSnapshotEntry[] | null | undefined,
): P2pContextReducerConfig | undefined {
  if (!reducer) return undefined;
  const snapshot = participants ?? [];
  const lookup = new Map(snapshot.map((entry) => [entry.sessionName, entry]));
  if (reducer.mode === 'reuse_existing_session') {
    if (!reducer.sessionName) throw new Error('contextReducer.sessionName is required for reuse_existing_session');
    const target = lookup.get(reducer.sessionName);
    if (!target || !isTransportSessionAgentType(target.agentType)) {
      throw new Error(`Reducer session is not an eligible SDK-backed participant: ${reducer.sessionName}`);
    }
  } else {
    if (!reducer.templateSession) throw new Error('contextReducer.templateSession is required for clone_sdk_session');
    const template = lookup.get(reducer.templateSession);
    if (!template || !isTransportSessionAgentType(template.agentType)) {
      throw new Error(`Reducer template is not an eligible SDK-backed participant: ${reducer.templateSession}`);
    }
  }
  return cloneRound(reducer);
}

function validateAdvancedRounds(rounds: P2pAdvancedRound[]): void {
  validateAdvancedRoundIds(rounds);
  const ids = new Set(rounds.map((round) => round.id));
  for (const round of rounds) {
    const verdictPolicy = round.verdictPolicy ?? 'none';
    const artifactConvention = defaultArtifactConvention(round);
    if (round.permissionScope === 'artifact_generation' && artifactConvention === 'explicit' && (!round.artifactOutputs || round.artifactOutputs.length === 0)) {
      throw new Error(`Artifact-generation round "${round.id}" must declare artifact outputs`);
    }
    if (verdictPolicy === 'forced_rework') {
      if (!round.jumpRule) throw new Error(`forced_rework round "${round.id}" requires a jumpRule`);
      if (round.jumpRule.minTriggers < 0) throw new Error(`forced_rework round "${round.id}" has invalid minTriggers`);
      if (round.jumpRule.maxTriggers < round.jumpRule.minTriggers) throw new Error(`forced_rework round "${round.id}" has invalid maxTriggers`);
    }
    if (round.jumpRule) {
      if (!ids.has(round.jumpRule.targetRoundId)) throw new Error(`Round "${round.id}" jumps to unknown target "${round.jumpRule.targetRoundId}"`);
      const currentIndex = rounds.findIndex((entry) => entry.id === round.id);
      const targetIndex = rounds.findIndex((entry) => entry.id === round.jumpRule?.targetRoundId);
      if (targetIndex >= currentIndex) throw new Error(`Round "${round.id}" must jump backward to an earlier round`);
      if (round.preset === 'proposal_audit') throw new Error('proposal_audit cannot drive routing in v1');
    }
  }
}

export function resolveP2pRoundPlan(options: ResolveP2pRoundPlanOptions): P2pResolvedPlan {
  const {
    modeOverride,
    roundsOverride,
    hopTimeoutMinutes,
    advancedPresetKey,
    advancedRounds,
    advancedRunTimeoutMinutes,
    contextReducer,
    participants,
  } = options;

  const advancedRequested = !!advancedPresetKey || !!advancedRounds?.length;
  if (!advancedRequested) {
    const mode = modeOverride ?? 'discuss';
    validateLegacyMode(mode);
    const comboRounds = parseModePipeline(mode).length;
    const totalRounds = Math.max(1, roundsOverride ?? comboRounds);
    return {
      advanced: false,
      rounds: Array.from({ length: totalRounds }, (_, index) => buildLegacyResolvedRound(mode, index + 1, totalRounds, hopTimeoutMinutes)),
    };
  }

  if (advancedPresetKey && advancedPresetKey !== 'openspec') {
    throw new Error(`Unknown advanced P2P preset: ${advancedPresetKey}`);
  }

  const presetRounds = advancedPresetKey === 'openspec'
    ? cloneRound(BUILT_IN_ADVANCED_PRESETS.openspec)
    : [];
  const rawRounds = advancedRounds?.length ? cloneRound(advancedRounds) : presetRounds;
  if (rawRounds.length === 0) throw new Error('Advanced P2P requires at least one round');
  validateAdvancedRounds(rawRounds);
  const validatedReducer = validateContextReducer(contextReducer, participants);
  const helperEligibleSnapshot = (participants ?? []).filter((entry) => isTransportSessionAgentType(entry.agentType));

  return {
    advanced: true,
    rounds: rawRounds.map((round) => normalizeAdvancedRound(round)),
    overallRunTimeoutMinutes: advancedRunTimeoutMinutes ?? DEFAULT_ADVANCED_RUN_TIMEOUT_MINUTES,
    contextReducer: validatedReducer,
    helperEligibleSnapshot,
  };
}
