import {
  CAPABILITY_ERROR,
  CAPABILITY_HTTP_PATH,
  CAPABILITY_KIND,
  CAPABILITY_LIMITS,
  CAPABILITY_MANAGE_ACTION,
  CAPABILITY_SCOPE,
  capabilityCancellationPath,
  capabilityManagePath,
  capabilityOperationPath,
  isCapabilityLifecycleState,
  validateCapabilityInstallRequest,
  type CapabilityErrorCode,
  type CapabilityErrorResult,
  type CapabilityInstallRequest,
  type CapabilityListRequest,
  type CapabilityListResult,
  type CapabilityManageRequest,
  type CapabilityManageResult,
  type CapabilityOperation,
  type CapabilityOperationResult,
  type CapabilityService,
  type CapabilityStatusRequest,
  type CapabilityStatusResult,
  type CapabilitySummary,
} from '../../shared/capability-management.js';

export interface ServerCapabilityCredentials {
  serverId: string;
  token: string;
  workerUrl: string;
}

export interface ServerCapabilityServiceOptions {
  serverId: string;
  fetchImpl?: typeof fetch;
  loadCredentials?: () => Promise<ServerCapabilityCredentials | null>;
  requestTimeoutMs?: number;
  activateSkill?: (
    capability: CapabilitySummary,
  ) => Promise<CapabilityStatusResult | CapabilityErrorResult> | CapabilityStatusResult | CapabilityErrorResult;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
type CapabilityManageChoice = NonNullable<CapabilityManageResult['choices']>[number];
interface ServerCapabilityErrorResult extends CapabilityErrorResult {
  choices?: readonly CapabilityManageChoice[];
}

function errorResult(reason: CapabilityErrorCode, error: string = reason, retryable?: boolean): CapabilityErrorResult {
  return { status: 'error', reason, error, ...(retryable !== undefined ? { retryable } : {}) };
}

function errorForStatus(status: number): CapabilityErrorResult {
  if (status === 400) return errorResult(CAPABILITY_ERROR.INVALID_INPUT);
  if (status === 401 || status === 403) return errorResult(CAPABILITY_ERROR.FORBIDDEN);
  if (status === 404) return errorResult(CAPABILITY_ERROR.NOT_FOUND);
  if (status === 409) return errorResult(CAPABILITY_ERROR.CONFLICT, CAPABILITY_ERROR.CONFLICT, true);
  if (status === 429) return errorResult(CAPABILITY_ERROR.RATE_LIMITED, CAPABILITY_ERROR.RATE_LIMITED, true);
  if (status === 503) return errorResult(CAPABILITY_ERROR.RUNTIME_PENDING, CAPABILITY_ERROR.RUNTIME_PENDING, true);
  return errorResult(CAPABILITY_ERROR.INTERNAL_ERROR, CAPABILITY_ERROR.INTERNAL_ERROR, status >= 500);
}

async function defaultLoadCredentials(): Promise<ServerCapabilityCredentials | null> {
  const module = await import('../bind/bind-flow.js');
  return module.loadCredentials();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isErrorResult(value: unknown): value is CapabilityErrorResult {
  return isRecord(value)
    && value.status === 'error'
    && typeof value.reason === 'string'
    && typeof value.error === 'string';
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= max
    ? value
    : undefined;
}

function parseManageChoices(value: unknown): readonly CapabilityManageChoice[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > CAPABILITY_LIMITS.AMBIGUOUS_CHOICES) return undefined;
  const choices: CapabilityManageChoice[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return undefined;
    const id = boundedString(candidate.id, 128);
    const name = boundedString(candidate.name, CAPABILITY_LIMITS.DISPLAY_NAME_CHARS);
    const bindingId = boundedString(candidate.bindingId, 128);
    const scopeId = candidate.scopeId === undefined
      ? undefined
      : boundedString(candidate.scopeId, CAPABILITY_LIMITS.SOURCE_CHARS);
    if (!id || !name || !bindingId
      || !Object.values(CAPABILITY_KIND).includes(candidate.kind as never)
      || !Object.values(CAPABILITY_SCOPE).includes(candidate.scope as never)
      || !isCapabilityLifecycleState(candidate.state)
      || (candidate.scopeId !== undefined && !scopeId)) return undefined;
    choices.push({
      id,
      kind: candidate.kind as CapabilityManageChoice['kind'],
      name,
      scope: candidate.scope as CapabilityManageChoice['scope'],
      state: candidate.state,
      bindingId,
      ...(scopeId ? { scopeId } : {}),
    });
  }
  return choices;
}

function errorForResponse(status: number, body: unknown): ServerCapabilityErrorResult {
  if (isRecord(body)
    && body.status === 'error'
    && typeof body.reason === 'string'
    && Object.values(CAPABILITY_ERROR).includes(body.reason as CapabilityErrorCode)) {
    const reason = body.reason as CapabilityErrorCode;
    const error = boundedString(body.error, CAPABILITY_LIMITS.FINDING_TEXT_BYTES) ?? reason;
    const retryable = typeof body.retryable === 'boolean'
      ? body.retryable
      : errorForStatus(status).retryable;
    const choices = reason === CAPABILITY_ERROR.AMBIGUOUS ? parseManageChoices(body.choices) : undefined;
    return {
      status: 'error', reason, error,
      ...(retryable !== undefined ? { retryable } : {}),
      ...(choices ? { choices } : {}),
    };
  }
  return errorForStatus(status);
}

function ambiguousManageResult(value: CapabilityErrorResult): CapabilityManageResult | undefined {
  const choices = (value as ServerCapabilityErrorResult).choices;
  return value.reason === CAPABILITY_ERROR.AMBIGUOUS && choices
    ? { status: 'ambiguous', choices }
    : undefined;
}

function isBindingScopedAction(action: CapabilityManageRequest['action']): boolean {
  return action === CAPABILITY_MANAGE_ACTION.ENABLE
    || action === CAPABILITY_MANAGE_ACTION.DISABLE
    || action === CAPABILITY_MANAGE_ACTION.UNINSTALL
    || action === CAPABILITY_MANAGE_ACTION.RESTORE;
}

function bindingChoices(capability: CapabilitySummary, scope?: CapabilityManageRequest['scope']): CapabilityManageChoice[] {
  return (capability.bindings ?? [])
    .filter((binding) => !scope || binding.scope === scope)
    .slice(0, CAPABILITY_LIMITS.AMBIGUOUS_CHOICES)
    .map((binding) => ({
      id: capability.id,
      kind: capability.kind,
      name: capability.name,
      scope: binding.scope,
      state: capability.state,
      bindingId: binding.id,
      ...(binding.scopeId ? { scopeId: binding.scopeId } : {}),
    }));
}

function boundedLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return CAPABILITY_LIMITS.LIST_DEFAULT;
  return Math.max(1, Math.min(Math.trunc(limit!), CAPABILITY_LIMITS.LIST_MAX));
}

export class ServerCapabilityService implements CapabilityService {
  private readonly fetchImpl: typeof fetch;
  private readonly loadCredentials: () => Promise<ServerCapabilityCredentials | null>;

  constructor(private readonly options: ServerCapabilityServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.loadCredentials = options.loadCredentials ?? defaultLoadCredentials;
  }

  async list(input: CapabilityListRequest): Promise<CapabilityListResult | CapabilityErrorResult> {
    const limit = boundedLimit(input.limit);
    const params = new URLSearchParams({
      serverId: this.options.serverId,
      limit: String(limit),
    });
    if (input.kind) params.set('kind', input.kind);
    if (input.state) params.set('state', input.state);
    if (input.scope) params.set('scope', input.scope);
    if (input.query) params.set('query', input.query);
    const response = await this.request(`${CAPABILITY_HTTP_PATH.LIST}?${params}`);
    if (isErrorResult(response)) return response;
    if (!Array.isArray(response.items)) return errorResult(CAPABILITY_ERROR.INTERNAL_ERROR);
    // Treat server filtering as an optimization, not an authority boundary. A
    // stale or misconfigured server must not broaden the MCP caller's query.
    const query = input.query?.trim().toLocaleLowerCase('en-US');
    const items = (response.items as CapabilitySummary[])
      .filter((item) => isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string')
      .filter((item) => !input.kind || item.kind === input.kind)
      .filter((item) => !input.state || item.state === input.state)
      .filter((item) => !input.scope || item.scope === input.scope)
      .filter((item) => !query || item.name.toLocaleLowerCase('en-US').includes(query))
      .slice(0, limit);
    return { status: 'ok', items };
  }

  async install(input: CapabilityInstallRequest): Promise<CapabilityOperationResult | CapabilityErrorResult> {
    const issue = validateCapabilityInstallRequest(input);
    if (issue) return errorResult(CAPABILITY_ERROR.INVALID_INPUT, issue);
    const response = await this.request(
      `${CAPABILITY_HTTP_PATH.INSTALL}?${new URLSearchParams({ serverId: this.options.serverId })}`,
      { method: 'POST', body: JSON.stringify(input) },
    );
    if (isErrorResult(response)) return response;
    return isRecord(response.operation)
      ? { status: 'ok', operation: response.operation as unknown as CapabilityOperation }
      : errorResult(CAPABILITY_ERROR.INTERNAL_ERROR);
  }

  async status(input: CapabilityStatusRequest): Promise<CapabilityStatusResult | CapabilityErrorResult> {
    if (Boolean(input.operationId) === Boolean(input.capabilityId)) {
      return errorResult(CAPABILITY_ERROR.INVALID_INPUT, 'Provide exactly one operationId or capabilityId');
    }
    if (input.activate && !input.capabilityId) {
      return errorResult(CAPABILITY_ERROR.INVALID_INPUT, 'activate requires capabilityId');
    }
    const path = input.operationId
      ? capabilityOperationPath(input.operationId)
      : `${CAPABILITY_HTTP_PATH.MANAGE_PREFIX}/${encodeURIComponent(input.capabilityId!)}`;
    const response = await this.request(`${path}?${new URLSearchParams({ serverId: this.options.serverId })}`);
    if (isErrorResult(response)) return response;
    if (isRecord(response.operation)) return { status: 'ok', operation: response.operation as unknown as CapabilityOperation };
    if (isRecord(response.capability)) {
      const capability = response.capability as unknown as CapabilitySummary;
      if (!input.activate) return { status: 'ok', capability };
      if (capability.kind !== CAPABILITY_KIND.SKILL) {
        return errorResult(CAPABILITY_ERROR.INVALID_INPUT, 'Only Skills can be activated');
      }
      return this.options.activateSkill
        ? this.options.activateSkill(capability)
        : errorResult(CAPABILITY_ERROR.RUNTIME_PENDING, 'Skill activation is unavailable in this runtime', false);
    }
    return errorResult(CAPABILITY_ERROR.INTERNAL_ERROR);
  }

  async manage(input: CapabilityManageRequest): Promise<CapabilityManageResult | CapabilityErrorResult> {
    if (input.action === CAPABILITY_MANAGE_ACTION.CANCEL_OPERATION) {
      if (!input.operationId) return errorResult(CAPABILITY_ERROR.INVALID_INPUT, 'operationId is required');
      let expectedRevision = input.expectedRevision;
      if (!expectedRevision) {
        const current = await this.status({ operationId: input.operationId });
        if (current.status !== 'ok' || !current.operation) return current as CapabilityErrorResult;
        expectedRevision = current.operation.revision;
      }
      const response = await this.request(
        `${capabilityCancellationPath(input.operationId)}?${new URLSearchParams({ serverId: this.options.serverId })}`,
        { method: 'POST', body: JSON.stringify({ revision: expectedRevision }) },
      );
      if (isErrorResult(response)) return response;
      return isRecord(response.operation)
        ? { status: 'ok', operation: response.operation as unknown as CapabilityOperation }
        : errorResult(CAPABILITY_ERROR.INTERNAL_ERROR);
    }
    if ((input.action === CAPABILITY_MANAGE_ACTION.UNINSTALL || input.action === CAPABILITY_MANAGE_ACTION.DELETE_CREDENTIALS)
      && !input.userIntent?.trim()) {
      return errorResult(CAPABILITY_ERROR.INVALID_INPUT, 'Explicit user intent is required');
    }
    const resolved = await this.resolveManageTarget(input);
    if ('status' in resolved) return resolved;
    const expectedRevision = input.expectedRevision ?? resolved.revision;
    let bindingId = input.bindingId;
    if (!bindingId && isBindingScopedAction(input.action)) {
      const choices = bindingChoices(resolved, input.scope);
      if (choices.length > 1) return { status: 'ambiguous', choices };
      if (choices.length === 1) bindingId = choices[0]!.bindingId;
    }
    const response = await this.request(
      `${capabilityManagePath(resolved.id)}?${new URLSearchParams({ serverId: this.options.serverId })}`,
      { method: 'POST', body: JSON.stringify({ ...input, capabilityId: resolved.id, expectedRevision, ...(bindingId ? { bindingId } : {}) }) },
    );
    if (isErrorResult(response)) return ambiguousManageResult(response) ?? response;
    return isRecord(response.capability)
      ? { status: 'ok', capability: response.capability as unknown as CapabilitySummary }
      : errorResult(CAPABILITY_ERROR.INTERNAL_ERROR);
  }

  private async resolveManageTarget(input: CapabilityManageRequest): Promise<CapabilitySummary | CapabilityManageResult | CapabilityErrorResult> {
    if (input.capabilityId) {
      const result = await this.status({ capabilityId: input.capabilityId });
      return result.status === 'ok' && result.capability ? result.capability : result as CapabilityErrorResult;
    }
    if (!input.name) return errorResult(CAPABILITY_ERROR.INVALID_INPUT, 'capabilityId or exact name is required');
    const listed = await this.list({ kind: input.kind, scope: input.scope, query: input.name, limit: CAPABILITY_LIMITS.AMBIGUOUS_CHOICES + 1 });
    if (listed.status !== 'ok') return listed;
    const matches = listed.items.filter((item) => item.name === input.name)
      .filter((item) => !input.kind || item.kind === input.kind)
      .filter((item) => !input.scope || item.scope === input.scope);
    if (matches.length === 0) return errorResult(CAPABILITY_ERROR.NOT_FOUND);
    if (matches.length > 1) {
      return {
        status: 'ambiguous',
        choices: matches.slice(0, CAPABILITY_LIMITS.AMBIGUOUS_CHOICES).map((item) => ({
          id: item.id, kind: item.kind, name: item.name, scope: item.scope, state: item.state,
        })),
      };
    }
    return matches[0];
  }

  private async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown> | CapabilityErrorResult> {
    let credentials: ServerCapabilityCredentials | null;
    try {
      credentials = await this.loadCredentials();
    } catch {
      return errorResult(CAPABILITY_ERROR.RUNTIME_PENDING, 'Daemon credentials are unavailable', true);
    }
    if (!credentials || credentials.serverId !== this.options.serverId) {
      return errorResult(CAPABILITY_ERROR.FORBIDDEN, 'Caller server identity does not match daemon credentials');
    }
    const controller = new AbortController();
    const timeoutMs = Math.max(1, Math.min(this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 60_000));
    const timer = setTimeout(() => controller.abort(new Error('Capability server request timed out')), timeoutMs);
    try {
      const response = await this.fetchImpl(`${credentials.workerUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'X-Server-Id': credentials.serverId,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) return errorForResponse(response.status, body);
      return isRecord(body) ? body : errorResult(CAPABILITY_ERROR.INTERNAL_ERROR);
    } catch {
      return errorResult(CAPABILITY_ERROR.RUNTIME_PENDING, 'Capability server is offline', true);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createServerCapabilityService(options: ServerCapabilityServiceOptions): ServerCapabilityService {
  return new ServerCapabilityService(options);
}
