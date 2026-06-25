import type { EffectiveActorRole, SharedActorEnvelope } from '@shared/tab-sharing.js';

export type ShareRole = 'viewer' | 'participant';

export type ShareTarget =
  | { kind: 'server'; serverId: string }
  | { kind: 'main'; serverId: string; sessionName: string }
  | { kind: 'subsession'; serverId: string; subSessionId: string; subSessionDisplayName?: string };

export type ShareStatus = 'active' | 'revoked' | 'expired' | 'target-unavailable';

export interface SharedUserSummary {
  id: string;
  displayName: string;
  role: ShareRole;
  status: ShareStatus;
}

export interface SharedStateSummary {
  scopeLabel?: string | null;
  effectiveRole?: ShareRole | null;
  status?: ShareStatus | null;
  users?: SharedUserSummary[];
  outgoing?: boolean;
  activeDispatchId?: string | null;
  unavailableReason?: string | null;
}

export type SharedActorDisplaySummary = Pick<SharedActorEnvelope, 'actorDisplayName' | 'effectiveActorRole'>;

export function parseSharedActorDisplay(value: unknown): SharedActorDisplaySummary | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<SharedActorEnvelope>;
  const actorDisplayName = typeof raw.actorDisplayName === 'string' ? raw.actorDisplayName.trim() : '';
  const effectiveActorRole = typeof raw.effectiveActorRole === 'string'
    ? raw.effectiveActorRole as EffectiveActorRole
    : null;
  if (!actorDisplayName || !effectiveActorRole) return null;
  return { actorDisplayName, effectiveActorRole };
}

export function sharedActorRoleLabelKey(role: EffectiveActorRole): string | null {
  if (role === 'viewer' || role === 'participant') return `share.role.${role}`;
  if (role === 'server-member') return 'share.role.serverMember';
  if (role === 'server-manager') return 'share.role.serverManager';
  if (role === 'system') return 'share.role.system';
  return null;
}

export function formatSharedActorLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  value: unknown,
): string | null {
  const actor = parseSharedActorDisplay(value);
  if (!actor) return null;
  const roleKey = sharedActorRoleLabelKey(actor.effectiveActorRole);
  return t('share.actorLabel', {
    name: actor.actorDisplayName,
    role: roleKey ? t(roleKey) : actor.effectiveActorRole,
  });
}

export interface ShareDialogTarget {
  serverId: string;
  serverLabel?: string | null;
  sessionName: string;
  tabLabel: string;
  subSessionId?: string | null;
  subSessionDisplayName?: string | null;
}

export interface ShareGrantSummary {
  id: string;
  targetUserId: string;
  targetUserDisplayName: string;
  role: ShareRole;
  status: ShareStatus;
  target?: ShareTarget;
  targetRef?: string;
  targetLabel?: string | null;
  expiresAt?: number | string | null;
}

export function shareTargetKey(target: ShareTarget | null | undefined): string | null {
  if (!target) return null;
  if (target.kind === 'server') return `server:${target.serverId}`;
  if (target.kind === 'main') return `main:${target.serverId}:${target.sessionName}`;
  return `subsession:${target.serverId}:${target.subSessionId}`;
}

export function buildCurrentTabShareTarget(target: ShareDialogTarget): ShareTarget {
  if (target.subSessionId?.trim()) {
    return {
      kind: 'subsession',
      serverId: target.serverId,
      subSessionId: target.subSessionId.trim(),
      ...(target.subSessionDisplayName ? { subSessionDisplayName: target.subSessionDisplayName } : {}),
    };
  }
  return { kind: 'main', serverId: target.serverId, sessionName: target.sessionName };
}

export function isParticipantRole(role: ShareRole): boolean {
  return role === 'participant';
}
