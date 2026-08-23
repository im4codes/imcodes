import { apiFetch } from '../api.js';
import type {
  CapabilityConfirmation,
  CapabilityErrorCode,
  CapabilityFinding,
  CapabilityInstallRequest,
  CapabilityManagementAction,
  CapabilityManageRequest,
  CapabilityOperation,
  CapabilitySummary,
} from '@shared/capability-management.js';
import {
  CAPABILITY_CONFIRMATION_DECISION,
  CAPABILITY_ERROR,
  CAPABILITY_HTTP_PATH,
  CAPABILITY_INSTALL_STATE,
  CAPABILITY_LIMITS,
  capabilityCancellationPath,
  capabilityConfirmationPath,
  capabilityManagePath,
  capabilityOperationPath,
  isCapabilityInstallCancellable,
} from '@shared/capability-management.js';

export type CapabilityFindingView = CapabilityFinding;

export interface CapabilitySummaryView extends CapabilitySummary {
  availableActions?: CapabilityManagementAction[];
  availableVersions?: Array<{ id: string; label: string }>;
  hasCredentials?: boolean;
}

export interface CapabilityOperationView extends CapabilityOperation {
  capabilityName?: string;
  progress?: number;
  statusDetail?: string;
  readiness?: CapabilitySummary['readiness'];
  retryable?: boolean;
  canConfirm?: boolean;
  canCancel?: boolean;
  terminal?: boolean;
}

export interface CapabilityListResponse {
  items: CapabilitySummaryView[];
  operations?: CapabilityOperationView[];
  nextCursor?: string;
}

export interface CapabilityInstallInput {
  request: CapabilityInstallRequest;
  serverId?: string;
}

export interface CapabilityManageInput extends Omit<CapabilityManageRequest, 'capabilityId'> {}

export type CapabilityManageChoice = Pick<CapabilitySummary, 'id' | 'kind' | 'name' | 'scope' | 'state'> & {
  bindingId: string;
  scopeId?: string;
};

export class CapabilityManageAmbiguousError extends Error {
  public readonly choices: CapabilityManageChoice[];

  constructor(choices: CapabilityManageChoice[]) {
    super('capability_manage_ambiguous');
    this.name = 'CapabilityManageAmbiguousError';
    this.choices = choices;
  }
}

export class CapabilityRequestError extends Error {
  public readonly status: number;
  public readonly reason: CapabilityErrorCode;
  public readonly retryable: boolean;
  public readonly safeMessage?: string;
  public readonly requestId?: string;

  constructor(input: { status: number; reason: CapabilityErrorCode; retryable?: boolean; safeMessage?: string; requestId?: string }) {
    super(`capability_request_${input.reason}`);
    this.name = 'CapabilityRequestError';
    this.status = input.status;
    this.reason = input.reason;
    this.retryable = input.retryable === true;
    this.safeMessage = input.safeMessage;
    this.requestId = input.requestId;
  }
}

function boundedContentSafeError(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || /[\u0000-\u001F\u007F]/.test(normalized)) return undefined;
  return new TextEncoder().encode(normalized).length <= CAPABILITY_LIMITS.DISPLAY_NAME_CHARS * 4
    ? normalized
    : undefined;
}

export function parseCapabilityRequestError(error: unknown): CapabilityRequestError | null {
  if (!error || typeof error !== 'object') return null;
  const apiError = error as { status?: unknown; body?: unknown };
  if (typeof apiError.status !== 'number' || typeof apiError.body !== 'string') return null;
  if (new TextEncoder().encode(apiError.body).length > CAPABILITY_LIMITS.USER_INTENT_BYTES) return null;
  try {
    const parsed = JSON.parse(apiError.body) as { reason?: unknown; error?: unknown; retryable?: unknown; requestId?: unknown };
    const reason = Object.values(CAPABILITY_ERROR).find((candidate) => candidate === parsed.reason);
    if (!reason) return null;
    return new CapabilityRequestError({
      status: apiError.status,
      reason,
      retryable: parsed.retryable === true,
      safeMessage: boundedContentSafeError(parsed.error),
      requestId: typeof parsed.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(parsed.requestId)
        ? parsed.requestId
        : undefined,
    });
  } catch {
    return null;
  }
}

export function parseCapabilityManageChoices(error: unknown): CapabilityManageChoice[] | null {
  if (!error || typeof error !== 'object') return null;
  const apiError = error as { status?: unknown; body?: unknown };
  if (apiError.status !== 409 || typeof apiError.body !== 'string') return null;
  try {
    const parsed = JSON.parse(apiError.body) as { choices?: unknown };
    if (!Array.isArray(parsed.choices)) return null;
    const choices: CapabilityManageChoice[] = [];
    for (const choice of parsed.choices) {
      if (!choice || typeof choice !== 'object') continue;
      const candidate = choice as Partial<CapabilityManageChoice>;
      if (typeof candidate.id !== 'string'
        || typeof candidate.bindingId !== 'string'
        || typeof candidate.name !== 'string'
        || typeof candidate.kind !== 'string'
        || typeof candidate.scope !== 'string'
        || typeof candidate.state !== 'string') continue;
      choices.push(candidate as CapabilityManageChoice);
    }
    return choices.length ? choices : null;
  } catch {
    return null;
  }
}

export function normalizeCapabilityManageError(error: unknown): unknown {
  const choices = parseCapabilityManageChoices(error);
  return choices ? new CapabilityManageAmbiguousError(choices) : normalizeCapabilityRequestError(error);
}

export function normalizeCapabilityRequestError(error: unknown): unknown {
  return parseCapabilityRequestError(error) ?? error;
}

function withServerId(path: string, serverId?: string | null): string {
  if (!serverId?.trim()) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}serverId=${encodeURIComponent(serverId.trim())}`;
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function listCapabilities(serverId?: string | null): Promise<CapabilityListResponse> {
  return apiFetch<CapabilityListResponse>(withServerId(CAPABILITY_HTTP_PATH.LIST, serverId));
}

export async function installCapability(input: CapabilityInstallInput): Promise<CapabilityOperationView> {
  const { serverId, request } = input;
  const response = await apiFetch<{ operation: CapabilityOperationView }>(
    withServerId(CAPABILITY_HTTP_PATH.INSTALL, serverId),
    jsonRequest(request),
  ).catch((error: unknown) => { throw normalizeCapabilityRequestError(error); });
  return response.operation;
}

export async function getCapabilityOperation(operationId: string, serverId?: string | null): Promise<CapabilityOperationView> {
  const response = await apiFetch<{ operation: CapabilityOperationView }>(
    withServerId(capabilityOperationPath(operationId), serverId),
  );
  return response.operation;
}

export async function cancelCapabilityOperation(
  operation: Pick<CapabilityOperationView, 'id' | 'revision' | 'state'>,
  serverId?: string | null,
): Promise<CapabilityOperationView> {
  if (!isCapabilityInstallCancellable(operation.state)) {
    throw new CapabilityRequestError({ status: 409, reason: CAPABILITY_ERROR.CONFLICT });
  }
  const response = await apiFetch<{ operation: CapabilityOperationView }>(
    withServerId(capabilityCancellationPath(operation.id), serverId),
    jsonRequest({ revision: operation.revision }),
  ).catch((error: unknown) => { throw normalizeCapabilityRequestError(error); });
  return response.operation;
}

export async function decideCapabilityOperation(
  operation: CapabilityOperationView,
  decision: CapabilityConfirmation['decision'],
  serverId?: string | null,
): Promise<CapabilityOperationView> {
  const installing = decision === CAPABILITY_CONFIRMATION_DECISION.INSTALL;
  if (installing && (!operation.artifactDigest || !operation.auditDigest)) {
    throw new Error('confirmation_evidence_missing');
  }
  const confirmation = installing ? {
    operationId: operation.id,
    revision: operation.revision,
    artifactDigest: operation.artifactDigest!,
    auditDigest: operation.auditDigest!,
    scope: operation.scope,
    providers: operation.providers,
    machines: operation.machines,
    decision,
  } satisfies CapabilityConfirmation : {
    operationId: operation.id,
    revision: operation.revision,
    decision,
  };
  const response = await apiFetch<{ operation: CapabilityOperationView }>(
    withServerId(capabilityConfirmationPath(operation.id), serverId),
    jsonRequest(confirmation),
  ).catch((error: unknown) => { throw normalizeCapabilityRequestError(error); });
  if (installing && response.operation.state !== CAPABILITY_INSTALL_STATE.INSTALLING
    && response.operation.state !== CAPABILITY_INSTALL_STATE.SYNCING
    && response.operation.state !== CAPABILITY_INSTALL_STATE.INSTALLED) {
    throw new CapabilityRequestError({ status: 409, reason: CAPABILITY_ERROR.CONFLICT });
  }
  return response.operation;
}

export async function manageCapability(
  capabilityId: string,
  input: CapabilityManageInput,
  serverId?: string | null,
): Promise<CapabilitySummaryView> {
  return apiFetch<{ capability: CapabilitySummaryView }>(
    withServerId(capabilityManagePath(capabilityId), serverId),
    jsonRequest({ ...input, capabilityId }),
  ).then((response) => response.capability, (error: unknown) => {
    throw normalizeCapabilityManageError(error);
  });
}
