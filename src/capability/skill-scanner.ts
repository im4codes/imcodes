import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { readInventoryFileConsistent, type AgentSkillPackageInventory } from './agent-skill-package.js';

export const SKILL_SCANNER_POLICY_VERSION = 'imcodes-skill-scan-v1' as const;
export const SKILL_SCAN_FINDING_SEVERITIES = ['info', 'warning', 'block'] as const;

export type SkillScanFindingSeverity = (typeof SKILL_SCAN_FINDING_SEVERITIES)[number];

export interface SkillScanFinding {
  code: string;
  severity: SkillScanFindingSeverity;
  path: string;
  message: string;
}

export interface SkillScanResult {
  policyVersion: typeof SKILL_SCANNER_POLICY_VERSION;
  artifactDigest: string;
  scannerDigest: string;
  outcome: 'pass' | 'blocked';
  findings: SkillScanFinding[];
  requestedTools: string[];
  scriptPaths: string[];
  executablePaths: string[];
}

const TEXT_FILE_PATTERN = /\.(?:md|txt|json|ya?ml|toml|js|mjs|cjs|ts|tsx|jsx|py|rb|sh|bash|zsh|ps1|cmd|bat|env)$/i;
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.py', '.rb', '.sh', '.bash', '.zsh', '.ps1', '.cmd', '.bat']);
const SECRET_PATTERNS: ReadonlyArray<{ code: string; pattern: RegExp }> = [
  { code: 'private_key_material', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i },
  { code: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { code: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: 'secret_assignment', pattern: /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[A-Za-z0-9_+/=-]{16,}/i },
];
const BIDI_OR_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/;
const EXTERNAL_REFERENCE_PATTERN = /\bhttps?:\/\/[^\s)>"']+/i;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function finding(code: string, severity: SkillScanFindingSeverity, path: string, message: string): SkillScanFinding {
  return { code, severity, path, message };
}

function scanPackageJson(path: string, text: string, findings: SkillScanFinding[]): void {
  if (!path.endsWith('package.json')) return;
  try {
    const parsed = JSON.parse(text) as { scripts?: Record<string, unknown> };
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
      if (typeof parsed.scripts?.[hook] === 'string') {
        findings.push(finding('package_install_hook', 'warning', path, `Package manifest declares ${hook}`));
      }
    }
  } catch {
    findings.push(finding('invalid_package_manifest', 'warning', path, 'Package manifest is not valid JSON'));
  }
}

export function scanAgentSkillPackage(inventory: AgentSkillPackageInventory): SkillScanResult {
  const findings: SkillScanFinding[] = [];
  const scripts = new Set<string>();
  const executables = new Set<string>();
  for (const file of inventory.files) {
    const extension = extname(file.path).toLowerCase();
    if (['.zip', '.tar', '.tgz', '.gz', '.7z', '.rar'].includes(extension)) {
      findings.push(finding('nested_archive_present', 'block', file.path, 'Nested archives are not admitted'));
    }
    if (SCRIPT_EXTENSIONS.has(extension)) scripts.add(file.path);
    if (file.executable) executables.add(file.path);
    const buffer = readInventoryFileConsistent(inventory, file.path);
    const text = buffer.toString('utf8');
    for (const secret of SECRET_PATTERNS) {
      if (secret.pattern.test(text)) {
        findings.push(finding(secret.code, 'block', file.path, 'Potential secret material detected'));
      }
    }
    const isText = TEXT_FILE_PATTERN.test(file.path) || file.path.endsWith('/.env') || file.path === '.env' || !text.includes('\uFFFD');
    if (file.executable && !isText) {
      findings.push(finding('opaque_executable', 'block', file.path, 'Unknown binary executable content is not admitted'));
    }
    if (!isText) continue;
    if (BIDI_OR_CONTROL_PATTERN.test(text)) {
      findings.push(finding('unsafe_control_text', 'block', file.path, 'Bidirectional or control text detected'));
    }
    if (EXTERNAL_REFERENCE_PATTERN.test(text)) {
      findings.push(finding('external_reference', 'info', file.path, 'External reference is present'));
    }
    if (/^#!\s*\//m.test(text)) scripts.add(file.path);
    scanPackageJson(file.path, text, findings);
  }
  for (const path of [...scripts].sort()) {
    findings.push(finding('script_present', 'warning', path, 'Script content is installed but was not executed'));
  }
  for (const path of [...executables].sort()) {
    findings.push(finding('executable_present', 'warning', path, 'Executable bit is present but was not executed'));
  }
  for (const tool of inventory.frontMatter.allowedTools ?? []) {
    findings.push(finding('requested_tool', 'info', 'SKILL.md', `Requested tool: ${tool}`));
  }
  findings.sort((a, b) => `${a.severity}:${a.code}:${a.path}`.localeCompare(`${b.severity}:${b.code}:${b.path}`));
  const scannerDigest = sha256(JSON.stringify({
    policyVersion: SKILL_SCANNER_POLICY_VERSION,
    artifactDigest: inventory.treeDigest,
    findings,
    requestedTools: inventory.frontMatter.allowedTools ?? [],
  }));
  return {
    policyVersion: SKILL_SCANNER_POLICY_VERSION,
    artifactDigest: inventory.treeDigest,
    scannerDigest,
    outcome: findings.some((entry) => entry.severity === 'block') ? 'blocked' : 'pass',
    findings,
    requestedTools: [...(inventory.frontMatter.allowedTools ?? [])],
    scriptPaths: [...scripts].sort(),
    executablePaths: [...executables].sort(),
  };
}
