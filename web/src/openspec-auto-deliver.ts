import {
  OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET_ID,
  OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID,
  OPENSPEC_AUTO_DELIVER_MSG,
  OPENSPEC_AUTO_DELIVER_PRESET_LIMITS,
  OPENSPEC_AUTO_DELIVER_SPEC_AUDIT_ROUNDS_MAX,
  OPENSPEC_AUTO_DELIVER_SPEC_AUDIT_ROUNDS_MIN,
  OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_AUDIT_ROUNDS_MAX,
  OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_AUDIT_ROUNDS_MIN,
  type OpenSpecAutoDeliverPresetId,
} from '@shared/openspec-auto-deliver-constants.js';
import type {
  OpenSpecAutoDeliverBrowserProjection,
  OpenSpecAutoDeliverLaunchRequest,
  OpenSpecAutoDeliverStatusRequest,
  OpenSpecAutoDeliverStopRequest,
} from '@shared/openspec-auto-deliver-types.js';

export { OPENSPEC_AUTO_DELIVER_MSG };

export type OpenSpecAutoDeliverMessageType = typeof OPENSPEC_AUTO_DELIVER_MSG[keyof typeof OPENSPEC_AUTO_DELIVER_MSG];

export const OPENSPEC_AUTO_DELIVER_PRESETS = [
  { id: 'fast', labelKey: 'openspec.auto.preset.fast', ...OPENSPEC_AUTO_DELIVER_PRESET_LIMITS.fast },
  { id: 'standard', labelKey: 'openspec.auto.preset.standard', ...OPENSPEC_AUTO_DELIVER_PRESET_LIMITS.standard },
  { id: 'strict', labelKey: 'openspec.auto.preset.strict', ...OPENSPEC_AUTO_DELIVER_PRESET_LIMITS.strict },
  { id: 'deep', labelKey: 'openspec.auto.preset.deep', ...OPENSPEC_AUTO_DELIVER_PRESET_LIMITS.deep },
] as const;

export type { OpenSpecAutoDeliverPresetId };
export type {
  OpenSpecAutoDeliverBrowserConflictProjection,
  OpenSpecAutoDeliverBrowserEvidence as OpenSpecAutoDeliverEvidence,
  OpenSpecAutoDeliverBrowserFullProjection,
  OpenSpecAutoDeliverBrowserModuleScore as OpenSpecAutoDeliverModuleScore,
  OpenSpecAutoDeliverBrowserProjection as OpenSpecAutoDeliverProjection,
  OpenSpecAutoDeliverBrowserTaskStats as OpenSpecAutoDeliverTaskStats,
  OpenSpecAutoDeliverListRow,
} from '@shared/openspec-auto-deliver-types.js';

export const OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET: OpenSpecAutoDeliverPresetId = OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET_ID;
export const OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO = OPENSPEC_AUTO_DELIVER_DEFAULT_TEAM_COMBO_ID;
export const OPENSPEC_AUTO_DELIVER_ROUND_BOUNDS = {
  specMin: OPENSPEC_AUTO_DELIVER_SPEC_AUDIT_ROUNDS_MIN,
  specMax: OPENSPEC_AUTO_DELIVER_SPEC_AUDIT_ROUNDS_MAX,
  implementationMin: OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_AUDIT_ROUNDS_MIN,
  implementationMax: OPENSPEC_AUTO_DELIVER_IMPLEMENTATION_AUDIT_ROUNDS_MAX,
} as const;

export interface OpenSpecAutoDeliverLaunchPayload extends OpenSpecAutoDeliverLaunchRequest {
  type: typeof OPENSPEC_AUTO_DELIVER_MSG.LAUNCH;
}

export interface OpenSpecAutoDeliverStopPayload extends OpenSpecAutoDeliverStopRequest {
  type: typeof OPENSPEC_AUTO_DELIVER_MSG.STOP;
}

export interface OpenSpecAutoDeliverStatusRequestPayload extends OpenSpecAutoDeliverStatusRequest {
  type: typeof OPENSPEC_AUTO_DELIVER_MSG.STATUS_REQUEST;
}

export function isOpenSpecAutoDeliverTerminalStatus(status: string | undefined): boolean {
  return status === 'passed' || status === 'needs_human' || status === 'failed' || status === 'stopped';
}

export function isOpenSpecAutoDeliverActiveProjection(projection: OpenSpecAutoDeliverBrowserProjection | null | undefined): boolean {
  return !!projection && !isOpenSpecAutoDeliverTerminalStatus(projection.status);
}

export function materializedPresetLimits(presetId: OpenSpecAutoDeliverPresetId) {
  const preset = OPENSPEC_AUTO_DELIVER_PRESETS.find((entry) => entry.id === presetId)
    ?? OPENSPEC_AUTO_DELIVER_PRESETS.find((entry) => entry.id === OPENSPEC_AUTO_DELIVER_DEFAULT_PRESET)!;
  return {
    specAuditRepairRounds: preset.specAuditRepairRounds,
    implementationAuditRepairRounds: preset.implementationAuditRepairRounds,
  };
}
