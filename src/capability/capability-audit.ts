import { createHash } from 'node:crypto';
import { readInventoryFileConsistent, type AgentSkillPackageInventory } from './agent-skill-package.js';
import type { SkillScanResult } from './skill-scanner.js';
import {
  CAPABILITY_AUDIT_VERDICT,
  type CapabilityMcpDefinition,
  type CapabilityAuditVerdict,
} from '../../shared/capability-management.js';

export const CAPABILITY_AUDIT_POLICY_VERSION = 'imcodes-capability-audit-v1' as const;
export const CAPABILITY_AUDIT_VERDICTS = Object.values(CAPABILITY_AUDIT_VERDICT);

export interface CapabilityAuditFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  code: string;
  path?: string;
  summary: string;
}

export interface CapabilityAuditEnvelope {
  policyVersion: typeof CAPABILITY_AUDIT_POLICY_VERSION;
  artifactDigest: string;
  scannerDigest: string;
  candidate: {
    kind: 'skill';
    name: string;
    description: string;
    fileCount: number;
    totalBytes: number;
    requestedTools: string[];
    scripts: string[];
    executables: string[];
  } | {
    kind: 'mcp';
    name: string;
    transport: CapabilityMcpDefinition['transport'];
    command: string[];
    url?: string;
    credentialRefs: string[];
    toolAllowlist: string[];
  };
  deterministicFindings: Array<{ code: string; severity: string; path: string; message: string }>;
  excerpts: Array<{
    path: string;
    sha256: string;
    kind: 'entry' | 'script' | 'manifest' | 'text';
    quotedUntrustedText: string;
  }>;
}

export function buildMcpCapabilityAuditEnvelope(
  definition: CapabilityMcpDefinition,
  artifactDigest: string,
  scannerDigest: string,
): CapabilityAuditEnvelope {
  const canonicalDefinition = JSON.stringify(definition);
  return {
    policyVersion: CAPABILITY_AUDIT_POLICY_VERSION,
    artifactDigest,
    scannerDigest,
    candidate: {
      kind: 'mcp',
      name: definition.name,
      transport: definition.transport,
      command: definition.command ? [definition.command, ...(definition.args ?? [])] : [],
      ...(definition.url ? { url: definition.url } : {}),
      credentialRefs: [
        ...(definition.credentialRef ? [definition.credentialRef] : []),
        ...Object.values(definition.env ?? {}).map((value) => value.credentialRef),
        ...Object.values(definition.headers ?? {}).map((value) => value.credentialRef),
      ],
      toolAllowlist: [...(definition.toolAllowlist ?? [])],
    },
    deterministicFindings: definition.command ? [{
      code: 'stdio_command', severity: 'warning', path: 'definition.command',
      message: 'The MCP definition declares a local stdio command; admission does not execute it.',
    }] : [],
    excerpts: [{
      path: 'mcp-definition.json', sha256: sha256(canonicalDefinition), kind: 'manifest',
      quotedUntrustedText: boundedText(canonicalDefinition, 12_000),
    }],
  };
}

export interface CapabilityAuditEvidence {
  verdict: CapabilityAuditVerdict;
  artifactDigest: string;
  scannerDigest: string;
  policyVersion: typeof CAPABILITY_AUDIT_POLICY_VERSION;
  runnerIdentity: string;
  model: string;
  findings: CapabilityAuditFinding[];
  auditDigest: string;
}

export function verifyCapabilityAuditEvidence(evidence: CapabilityAuditEvidence): boolean {
  const { auditDigest, ...core } = evidence;
  return evidence.policyVersion === CAPABILITY_AUDIT_POLICY_VERSION
    && CAPABILITY_AUDIT_VERDICTS.includes(evidence.verdict)
    && auditDigest === sha256(JSON.stringify(core));
}

export interface CapabilityAuditRunnerResult {
  verdict: CapabilityAuditVerdict;
  artifactDigest: string;
  scannerDigest: string;
  findings: CapabilityAuditFinding[];
  model: string;
}

export interface CapabilityAuditRunner {
  readonly identity: string;
  audit(envelope: CapabilityAuditEnvelope, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export class CapabilityAuditError extends Error {
  constructor(readonly code: 'audit_identity_conflict' | 'audit_unavailable' | 'audit_malformed' | 'audit_digest_mismatch') {
    super(code);
    this.name = 'CapabilityAuditError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function boundedText(value: string, max: number): string {
  const normalized = redactAuditText(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

function redactAuditText(value: string): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED TOKEN]')
    .replace(/((?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*)["']?[^\s"']{8,}["']?/gi, '$1[REDACTED]');
}

export function buildCapabilityAuditEnvelope(
  inventory: AgentSkillPackageInventory,
  scan: SkillScanResult,
): CapabilityAuditEnvelope {
  const scriptPaths = new Set(scan.scriptPaths);
  const manifestPattern = /(^|\/)(?:package\.json|pyproject\.toml|requirements(?:-[^/]*)?\.txt|cargo\.toml|go\.mod|pom\.xml|build\.gradle|makefile)$/i;
  const textPattern = /\.(?:md|txt|json|ya?ml|toml|js|mjs|cjs|ts|tsx|jsx|py|rb|sh|bash|zsh|ps1|cmd|bat)$/i;
  const ranked = inventory.files
    .filter((file) => file.path === 'SKILL.md' || scriptPaths.has(file.path) || manifestPattern.test(file.path) || textPattern.test(file.path))
    .map((file) => ({
      file,
      kind: file.path === 'SKILL.md' ? 'entry' as const
        : scriptPaths.has(file.path) ? 'script' as const
          : manifestPattern.test(file.path) ? 'manifest' as const
            : 'text' as const,
    }))
    .sort((left, right) => {
      const rank = { entry: 0, script: 1, manifest: 2, text: 3 } as const;
      return rank[left.kind] - rank[right.kind]
        || (left.file.path < right.file.path ? -1 : left.file.path > right.file.path ? 1 : 0);
    });
  const excerpts: CapabilityAuditEnvelope['excerpts'] = [];
  let remainingBytes = 64 * 1024;
  for (const { file, kind } of ranked) {
    if (remainingBytes <= 0 || excerpts.length >= 64) break;
    const bytes = readInventoryFileConsistent(inventory, file.path);
    const text = boundedText(bytes.toString('utf8'), Math.min(12_000, remainingBytes));
    if (!text) continue;
    remainingBytes -= Buffer.byteLength(text, 'utf8');
    excerpts.push({ path: file.path, sha256: file.sha256, kind, quotedUntrustedText: text });
  }
  return {
    policyVersion: CAPABILITY_AUDIT_POLICY_VERSION,
    artifactDigest: inventory.treeDigest,
    scannerDigest: scan.scannerDigest,
    candidate: {
      kind: 'skill',
      name: inventory.frontMatter.name,
      description: inventory.frontMatter.description,
      fileCount: inventory.files.length,
      totalBytes: inventory.totalBytes,
      requestedTools: scan.requestedTools.slice(0, 64),
      scripts: scan.scriptPaths.slice(0, 128),
      executables: scan.executablePaths.slice(0, 128),
    },
    deterministicFindings: scan.findings.slice(0, 256).map((entry) => ({ ...entry })),
    excerpts,
  };
}

export function mergeCapabilityAuditFindings(
  scan: SkillScanResult,
  audit: readonly CapabilityAuditFinding[],
): CapabilityAuditFinding[] {
  const merged: CapabilityAuditFinding[] = scan.findings.map((entry) => ({
    code: entry.code,
    severity: entry.severity === 'block' ? 'high' : entry.severity === 'warning' ? 'medium' : 'info',
    path: entry.path,
    summary: entry.message,
  }));
  const seen = new Set(merged.map((entry) => `${entry.code}\0${entry.path ?? ''}\0${entry.summary}`));
  for (const entry of audit) {
    const key = `${entry.code}\0${entry.path ?? ''}\0${entry.summary}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push({ ...entry });
    }
  }
  return merged.slice(0, 256);
}

function parseFinding(value: unknown): CapabilityAuditFinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CapabilityAuditError('audit_malformed');
  const record = value as Record<string, unknown>;
  const allowed = new Set(['severity', 'code', 'path', 'summary']);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new CapabilityAuditError('audit_malformed');
  if (!['critical', 'high', 'medium', 'low', 'info'].includes(String(record.severity))) throw new CapabilityAuditError('audit_malformed');
  if (typeof record.code !== 'string' || !record.code.trim() || record.code.length > 128) throw new CapabilityAuditError('audit_malformed');
  if (typeof record.summary !== 'string' || !record.summary.trim() || record.summary.length > 1000) throw new CapabilityAuditError('audit_malformed');
  if (record.path !== undefined && (typeof record.path !== 'string' || record.path.length > 512)) throw new CapabilityAuditError('audit_malformed');
  return {
    severity: record.severity as CapabilityAuditFinding['severity'],
    code: record.code,
    ...(typeof record.path === 'string' ? { path: record.path } : {}),
    summary: boundedText(record.summary, 1000),
  };
}

export function decodeCapabilityAuditResult(
  value: unknown,
  envelope: CapabilityAuditEnvelope,
  runnerIdentity: string,
): CapabilityAuditEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CapabilityAuditError('audit_malformed');
  const record = value as Record<string, unknown>;
  const allowed = new Set(['verdict', 'artifactDigest', 'scannerDigest', 'findings', 'model']);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new CapabilityAuditError('audit_malformed');
  if (!CAPABILITY_AUDIT_VERDICTS.includes(record.verdict as CapabilityAuditVerdict)) throw new CapabilityAuditError('audit_malformed');
  if (record.artifactDigest !== envelope.artifactDigest || record.scannerDigest !== envelope.scannerDigest) {
    throw new CapabilityAuditError('audit_digest_mismatch');
  }
  if (!Array.isArray(record.findings) || record.findings.length > 128 || typeof record.model !== 'string' || record.model.length > 128) {
    throw new CapabilityAuditError('audit_malformed');
  }
  const findings = record.findings.map(parseFinding);
  const verdict = record.verdict as CapabilityAuditVerdict;
  if (verdict === CAPABILITY_AUDIT_VERDICT.PASS
    && findings.some((entry) => entry.severity === 'critical' || entry.severity === 'high')) {
    throw new CapabilityAuditError('audit_malformed');
  }
  const core = {
    verdict,
    artifactDigest: envelope.artifactDigest,
    scannerDigest: envelope.scannerDigest,
    policyVersion: CAPABILITY_AUDIT_POLICY_VERSION,
    runnerIdentity,
    model: record.model,
    findings,
  };
  return { ...core, auditDigest: sha256(JSON.stringify(core)) };
}

export async function runCapabilityAudit(input: {
  runner: CapabilityAuditRunner;
  conversationIdentity: string;
  envelope: CapabilityAuditEnvelope;
  signal?: AbortSignal;
}): Promise<CapabilityAuditEvidence> {
  if (!input.runner.identity || input.runner.identity === input.conversationIdentity) {
    throw new CapabilityAuditError('audit_identity_conflict');
  }
  let result: unknown;
  try {
    result = await input.runner.audit(input.envelope, { signal: input.signal });
  } catch (error) {
    if (error instanceof CapabilityAuditError) throw error;
    throw new CapabilityAuditError('audit_unavailable');
  }
  return decodeCapabilityAuditResult(result, input.envelope, input.runner.identity);
}

export const CAPABILITY_AUDIT_TESTING = {
  redactAuditText,
};
