import {
  P2P_FORBIDDEN_ENVELOPE_FIELD_NAMES,
  P2P_SANITIZE_MAX_ARRAY_ITEMS,
  P2P_SANITIZE_MAX_STRING_BYTES,
} from '../../shared/p2p-workflow-constants.js';
import { redactSensitiveText } from '../../shared/redact-secrets.js';

export type OpenSpecAutoDeliverSanitizedProjection = {
  runId: string;
  changeName: string;
  status?: string;
  stage?: string;
  presetId?: string;
  owningMainSessionName: string;
  launchedFromSessionName?: string;
  targetImplementationSessionName?: string;
  projectionVersion: number;
  terminal?: boolean;
  elapsedMs?: number;
  taskStats?: {
    total: number;
    checked: number;
    unchecked: number;
    uncheckedLabels?: string[];
  };
  materializedLimits?: {
    specAuditRepairRounds?: number;
    implementationAuditRepairRounds?: number;
    maxImplementationPrompts?: number;
    maxElapsedMinutes?: number;
  };
  specAuditRepairRound?: number;
  implementationAuditRepairRound?: number;
  specAuditRound?: {
    current: number;
    total: number;
  };
  implementationAuditRound?: {
    current: number;
    total: number;
  };
  implementationPromptCount?: number;
  activeP2pRunId?: string;
  activeComboId?: string;
  latestVerdict?: string;
  moduleScores?: Array<{
    module: string;
    score: number;
    maxScore: number;
    summary?: string;
  }>;
  latestRepairSummary?: string;
  evidence?: Array<{
    source: string;
    summary: string;
    command?: string;
    exitCode?: number;
    stale?: boolean;
  }>;
  validationEvidenceProvenance?: string[];
  recentFinding?: string;
  terminalReason?: string;
  updatedAt?: string;
  visibility?: 'full' | 'conflict';
  canStop?: boolean;
  canDismiss?: boolean;
};

export type OpenSpecAutoDeliverConflictSummary = {
  runId: string;
  changeName: string;
  owningMainSessionName: string;
  status?: string;
  stage?: string;
  busy: true;
  reason: string;
  conflictReason: string;
  projectionVersion: number;
  visibility: 'conflict';
  canStop: false;
};

type CacheEntry = {
  projection: OpenSpecAutoDeliverSanitizedProjection;
  terminal: boolean;
  aliases: Set<string>;
};

const FORBIDDEN_FIELD_NAMES = new Set<string>(P2P_FORBIDDEN_ENVELOPE_FIELD_NAMES);
const SENSITIVE_FIELD_NAME_PATTERN = /(?:^|[_-])(token|secret|key|password|credential|env|environment|prompt|provider|raw)(?:$|[_-])/i;
const SECRET_KEY_VALUE_PATTERN = /\b(token|secret|api[_-]?key|access[_-]?token|credential)\s*[:=]\s*['"]?[^\s'"]+['"]?/gi;
const ABSOLUTE_PATH_PATTERN = /(?:\/Users\/[^\s'")]+|\/home\/[^\s'")]+|\/tmp\/[^\s'")]+|[A-Za-z]:\\[^\s'")]+)/g;
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const redacted = redactSensitiveText(value.trim()).replace(SECRET_KEY_VALUE_PATTERN, (_match, key: string) => {
    const normalizedKey = String(key).toLowerCase().replace(/[_-]/g, '_');
    return `[REDACTED:${normalizedKey}]`;
  }).replace(ABSOLUTE_PATH_PATTERN, '[REDACTED:path]');
  if (!redacted) return undefined;
  if (Buffer.byteLength(redacted, 'utf8') <= P2P_SANITIZE_MAX_STRING_BYTES) return redacted;
  let output = '';
  for (const char of redacted) {
    const next = output + char;
    if (Buffer.byteLength(next, 'utf8') > P2P_SANITIZE_MAX_STRING_BYTES) break;
    output = next;
  }
  return output;
}

function sanitizeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeNonNegativeInteger(value: unknown): number | undefined {
  const number = sanitizeNumber(value);
  if (number === undefined || number < 0) return undefined;
  return Math.trunc(number);
}

function sanitizeCounterPair(value: unknown): { current: number; total: number } | undefined {
  if (!isRecord(value)) return undefined;
  const current = sanitizeNonNegativeInteger(value.current);
  const total = sanitizeNonNegativeInteger(value.total);
  if (current === undefined || total === undefined) return undefined;
  return { current, total };
}

function sanitizeTaskStats(value: unknown): OpenSpecAutoDeliverSanitizedProjection['taskStats'] | undefined {
  if (!isRecord(value)) return undefined;
  const total = sanitizeNonNegativeInteger(value.total);
  const checked = sanitizeNonNegativeInteger(value.checked);
  const unchecked = sanitizeNonNegativeInteger(value.unchecked);
  if (total === undefined || checked === undefined || unchecked === undefined) return undefined;
  const labels = Array.isArray(value.items)
    ? value.items
        .filter((item): item is Record<string, unknown> => isRecord(item) && item.checked === false)
        .map((item) => sanitizeString(item.label))
        .filter((item): item is string => typeof item === 'string')
        .slice(0, P2P_SANITIZE_MAX_ARRAY_ITEMS)
    : sanitizeStringArray(value.uncheckedLabels);
  return { total, checked, unchecked, ...(labels && labels.length > 0 ? { uncheckedLabels: labels } : {}) };
}

function sanitizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output = value
    .slice(0, P2P_SANITIZE_MAX_ARRAY_ITEMS)
    .map((item) => sanitizeString(item))
    .filter((item): item is string => typeof item === 'string');
  return output.length > 0 ? output : undefined;
}

function sanitizeModuleScores(value: unknown): OpenSpecAutoDeliverSanitizedProjection['moduleScores'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output: NonNullable<OpenSpecAutoDeliverSanitizedProjection['moduleScores']> = [];
  for (const item of value.slice(0, P2P_SANITIZE_MAX_ARRAY_ITEMS)) {
    if (!isRecord(item)) continue;
    const module = sanitizeString(item.module);
    const score = sanitizeNumber(item.score);
    const maxScore = sanitizeNumber(item.maxScore ?? item.max_score);
    if (!module || score === undefined || maxScore === undefined) continue;
    output.push({
      module,
      score,
      maxScore,
      ...(sanitizeString(item.summary) ? { summary: sanitizeString(item.summary) } : {}),
    });
  }
  return output.length > 0 ? output : undefined;
}

function sanitizeEvidence(value: unknown): OpenSpecAutoDeliverSanitizedProjection['evidence'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output: NonNullable<OpenSpecAutoDeliverSanitizedProjection['evidence']> = [];
  for (const item of value.slice(0, P2P_SANITIZE_MAX_ARRAY_ITEMS)) {
    if (!isRecord(item)) continue;
    const source = sanitizeString(item.source);
    const summary = sanitizeString(item.summary);
    if (!source || !summary) continue;
    const command = sanitizeString(item.command);
    const exitCode = sanitizeNumber(item.exitCode);
    output.push({
      source,
      summary,
      ...(command ? { command } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(item.stale === true ? { stale: true } : {}),
    });
  }
  return output.length > 0 ? output : undefined;
}

function sanitizeMaterializedLimits(value: unknown): OpenSpecAutoDeliverSanitizedProjection['materializedLimits'] | undefined {
  if (!isRecord(value)) return undefined;
  const limits: NonNullable<OpenSpecAutoDeliverSanitizedProjection['materializedLimits']> = {};
  for (const field of ['specAuditRepairRounds', 'implementationAuditRepairRounds', 'maxImplementationPrompts', 'maxElapsedMinutes'] as const) {
    const sanitized = sanitizeNonNegativeInteger(value[field]);
    if (sanitized !== undefined) limits[field] = sanitized;
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function hasForbiddenField(value: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (entry: unknown, depth: number): boolean => {
    if (depth > 6 || !isRecord(entry) || seen.has(entry)) return false;
    seen.add(entry);
    for (const key of Object.keys(entry)) {
      if (FORBIDDEN_FIELD_NAMES.has(key) || SENSITIVE_FIELD_NAME_PATTERN.test(key)) return true;
      if (visit(entry[key], depth + 1)) return true;
    }
    return false;
  };
  return visit(value, 0);
}

function aliasSetForProjection(projection: OpenSpecAutoDeliverSanitizedProjection): Set<string> {
  const aliases = new Set<string>([projection.owningMainSessionName]);
  if (projection.launchedFromSessionName) aliases.add(projection.launchedFromSessionName);
  if (projection.targetImplementationSessionName) aliases.add(projection.targetImplementationSessionName);
  return aliases;
}

export function sanitizeOpenSpecAutoDeliverProjection(
  raw: unknown,
): OpenSpecAutoDeliverSanitizedProjection | null {
  if (!isRecord(raw)) return null;
  if (hasForbiddenField(raw)) {
    // Any private-looking envelope marks the raw projection as untrusted. We
    // still build a projection from allowlisted fields, but nested private data
    // never receives a recursive clone path.
  }

  const runId = sanitizeString(raw.runId);
  const changeName = sanitizeString(raw.changeName);
  const owningMainSessionName = sanitizeString(raw.owningMainSessionName);
  const projectionVersion = sanitizeNonNegativeInteger(raw.projectionVersion);
  if (!runId || !changeName || !owningMainSessionName || projectionVersion === undefined) return null;

  const terminal = raw.terminal === true || ['passed', 'needs_human', 'failed', 'stopped'].includes(String(raw.status ?? ''));
  const projection: OpenSpecAutoDeliverSanitizedProjection = {
    runId,
    changeName,
    owningMainSessionName,
    projectionVersion,
    visibility: 'full',
    canStop: !terminal,
    canDismiss: true,
  };

  const stringFields = [
    'status',
    'stage',
    'presetId',
    'launchedFromSessionName',
    'targetImplementationSessionName',
    'activeP2pRunId',
    'activeComboId',
    'latestVerdict',
    'latestRepairSummary',
    'terminalReason',
    'updatedAt',
  ] as const;
  for (const field of stringFields) {
    const value = sanitizeString(raw[field]);
    if (value !== undefined) projection[field] = value;
  }

  if (raw.terminal === true) projection.terminal = true;

  const elapsedMs = sanitizeNonNegativeInteger(raw.elapsedMs);
  if (elapsedMs !== undefined) projection.elapsedMs = elapsedMs;

  const implementationPromptCount = sanitizeNonNegativeInteger(raw.implementationPromptCount);
  if (implementationPromptCount !== undefined) projection.implementationPromptCount = implementationPromptCount;

  const taskStats = sanitizeTaskStats(raw.taskStats);
  if (taskStats) projection.taskStats = taskStats;

  const materializedLimits = sanitizeMaterializedLimits(raw.materializedLimits);
  if (materializedLimits) projection.materializedLimits = materializedLimits;

  const specAuditRepairRound = sanitizeNonNegativeInteger(raw.specAuditRepairRound);
  if (specAuditRepairRound !== undefined) projection.specAuditRepairRound = specAuditRepairRound;

  const implementationAuditRepairRound = sanitizeNonNegativeInteger(raw.implementationAuditRepairRound);
  if (implementationAuditRepairRound !== undefined) projection.implementationAuditRepairRound = implementationAuditRepairRound;

  const specAuditRound = sanitizeCounterPair(raw.specAuditRound)
    ?? (specAuditRepairRound !== undefined || materializedLimits?.specAuditRepairRounds !== undefined
      ? { current: specAuditRepairRound ?? 0, total: materializedLimits?.specAuditRepairRounds ?? 0 }
      : undefined);
  if (specAuditRound) projection.specAuditRound = specAuditRound;

  const implementationAuditRound = sanitizeCounterPair(raw.implementationAuditRound)
    ?? (implementationAuditRepairRound !== undefined || materializedLimits?.implementationAuditRepairRounds !== undefined
      ? { current: implementationAuditRepairRound ?? 0, total: materializedLimits?.implementationAuditRepairRounds ?? 0 }
      : undefined);
  if (implementationAuditRound) projection.implementationAuditRound = implementationAuditRound;

  const moduleScores = sanitizeModuleScores(raw.moduleScores);
  if (moduleScores) projection.moduleScores = moduleScores;

  const validationEvidenceProvenance = sanitizeStringArray(raw.validationEvidenceProvenance);
  if (validationEvidenceProvenance) projection.validationEvidenceProvenance = validationEvidenceProvenance;

  const evidence = sanitizeEvidence(raw.evidence);
  if (evidence) projection.evidence = evidence;

  const recentFinding = sanitizeString(raw.recentFinding ?? raw.lastMessage);
  if (recentFinding) projection.recentFinding = recentFinding;

  return projection;
}

export class OpenSpecAutoDeliverProjectionCache {
  private byOwningMainSession = new Map<string, CacheEntry>();
  private ownerByAlias = new Map<string, string>();

  remember(raw: unknown): OpenSpecAutoDeliverSanitizedProjection | null {
    const projection = sanitizeOpenSpecAutoDeliverProjection(raw);
    if (!projection) return null;

    const existing = this.byOwningMainSession.get(projection.owningMainSessionName);
    if (
      existing
      && existing.projection.runId === projection.runId
      && existing.projection.projectionVersion > projection.projectionVersion
    ) {
      return existing.projection;
    }

    this.forgetAliases(projection.owningMainSessionName);
    const aliases = aliasSetForProjection(projection);
    for (const alias of aliases) this.ownerByAlias.set(alias, projection.owningMainSessionName);
    this.byOwningMainSession.set(projection.owningMainSessionName, {
      projection,
      terminal: projection.terminal === true,
      aliases,
    });
    return projection;
  }

  getFullProjectionForSession(sessionName: string): OpenSpecAutoDeliverSanitizedProjection | null {
    const owner = this.ownerByAlias.get(sessionName);
    if (!owner) return null;
    return this.byOwningMainSession.get(owner)?.projection ?? null;
  }

  getConflictSummaryForOwningMainSession(owningMainSessionName: string): OpenSpecAutoDeliverConflictSummary | null {
    const projection = this.byOwningMainSession.get(owningMainSessionName)?.projection;
    if (!projection) return null;
    return {
      runId: projection.runId,
      changeName: projection.changeName,
      owningMainSessionName: projection.owningMainSessionName,
      status: projection.status,
      stage: projection.stage,
      busy: true,
      reason: 'auto_deliver_active',
      conflictReason: 'auto_deliver_active',
      projectionVersion: projection.projectionVersion,
      visibility: 'conflict',
      canStop: false,
    };
  }

  clearActive(): void {
    for (const [owningMainSessionName, entry] of [...this.byOwningMainSession]) {
      if (entry.terminal) continue;
      this.forgetAliases(owningMainSessionName);
      this.byOwningMainSession.delete(owningMainSessionName);
    }
  }

  clear(): void {
    this.byOwningMainSession.clear();
    this.ownerByAlias.clear();
  }

  private forgetAliases(owningMainSessionName: string): void {
    const existing = this.byOwningMainSession.get(owningMainSessionName);
    if (!existing) return;
    for (const alias of existing.aliases) this.ownerByAlias.delete(alias);
  }
}
