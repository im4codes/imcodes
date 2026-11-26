/**
 * Windows SID / effective-rights credential-file ACL checker.
 *
 * The controlled node stores its `nodeToken` in a credential file inside
 * `%ProgramData%\imcodes-node\` (see `installer.windowsCredentialDir`). The
 * install-time `icacls` invocation sets SYSTEM + Administrators only, but a
 * post-install ACL drift (manual chmod, malware, broken recovery) would
 * leave the SYSTEM-scoped nodeToken readable by an interactive user.
 *
 * `assertCredentialDirSecured` parses the current effective ACL via
 * `Get-Acl` and verifies, by SID (not by string), that:
 *   - `S-1-5-18` (NT Authority\SYSTEM) has FullControl (GenericAll = 0x100 + WriteDACL = 0x4 + WriteOwner = 0x8)
 *   - `S-1-5-32-544` (BUILTIN\Administrators) has FullControl
 *   - the DACL is protected (inheritance disabled)
 *   - no other principal has an allow ACE, including read-only/list/traverse
 *     access (the directory contains reusable SYSTEM/root credentials)
 *
 * The check is locale-independent (the parser pulls canonical SID strings
 * via `[Security.Principal.SecurityIdentifier].Value`, not localized names).
 *
 * Tool absence, malformed output and unknown ACE shapes all throw. The caller
 * loads secrets only after this check, so Windows stays fail closed.
 */
import { execFileSync } from 'node:child_process';

export interface AclPrincipalRight {
  /** Canonical SID (e.g. `S-1-5-18`). */
  sid: string;
  /** True when this is an allow ACE; false when deny. */
  isAllow: boolean;
  /** True when this ACE inherits to child files/directories. */
  inherited: boolean;
  /** `0` if absent, else a 32-bit bitwise OR of FileSystemRights values. */
  rights: number;
}

export interface AclReport {
  path: string;
  owner: string | null;
  /** `true` means inheritance is disabled on the effective DACL. */
  protectedDacl: boolean;
  principals: AclPrincipalRight[];
  /** Raw Get-Acl output, retained for audit and debugging. */
  raw: string;
}

export interface AclCheckResult {
  ok: boolean;
  reason: string;
  /** The structural report when ok=false (or when explicitly requested). */
  report?: AclReport;
}

/** Numeric FileSystemRights values we recognize (subset, not exhaustive). */
export const FS_RIGHTS = {
  ReadData: 0x1,
  WriteData: 0x2,
  AppendData: 0x4,
  ReadExtendedAttributes: 0x8,
  WriteExtendedAttributes: 0x10,
  ExecuteFile: 0x20,
  ReadAttributes: 0x80,
  WriteAttributes: 0x100,
  Delete: 0x10000,
  ReadPermissions: 0x20000,
  ChangePermissions: 0x40000,
  TakeOwnership: 0x80000,
  Synchronize: 0x100000,
  FullControl: 0x1f01ff,
} as const;

/** Numeric rights we require SYSTEM and Administrators to hold. */
export const REQUIRED_FULL_CONTROL = FS_RIGHTS.FullControl;

/** The two SIDs the credential directory MUST have FullControl on. */
export const REQUIRED_SIDS: readonly string[] = ['S-1-5-18', 'S-1-5-32-544'];

/** Run an arbitrary PowerShell snippet and return stdout. Throws on non-zero exit. */
function runPowerShell(script: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Parse the Get-Acl SDDL/SDDL-formatted string into structured principals.
 * The PowerShell snippet emits a stable JSON shape we can consume without
 * locale-dependent string matching.
 */
const ACL_QUERY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$p = $null # substituted with a single-quoted literal by readCredentialDirAcl
$a = Get-Acl -LiteralPath $p -ErrorAction Stop
function Get-Rights {
  param([System.Security.AccessControl.AuthorizationRuleCollection]$rules)
  $out = New-Object System.Collections.Generic.List[Object]
  foreach ($r in $rules) {
    $rights = 0
    $t = $r.AccessControlType.ToString()
    $isAllow = ($t -eq 'Allow')
    $inherit = $r.IsInherited
    $type = $r.GetType().Name
    if ($type -eq 'FileSystemAccessRule') { $rights = [int]$r.FileSystemRights }
    elseif ($type -eq 'GenericAccessRule') {
      # Translate generic rights into the file-system rights bitmask we already
      # care about (FullControl = GenericAll + WriteDACL + WriteOwner).
      $flags = [int]$r.FileSystemRights
      if (($flags -band 0x10000000) -ne 0) { $rights = $rights -bor 0x1f01ff }
    }
    else { throw "unsupported ACL rule type: $type" }
    $out.Add(@{
      sid = [Security.Principal.SecurityIdentifier]::new($r.IdentityReference.Value).Value
      isAllow = $isAllow
      inherited = $inherit
      rights = $rights
    })
  }
  , $out
}
[pscustomobject]@{
  path = $p
  owner = $a.GetOwner([Security.Principal.SecurityIdentifier]).Value
  protectedDacl = $a.AreAccessRulesProtected
  principals = Get-Rights -rules $a.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])
} | ConvertTo-Json -Depth 6 -Compress
`.trim();

export function buildCredentialAclQueryScript(dir: string): string {
  const escaped = dir.replaceAll("'", "''");
  return ACL_QUERY_SCRIPT.replace(
    '$p = $null # substituted with a single-quoted literal by readCredentialDirAcl',
    `$p = '${escaped}'`,
  );
}

/** Parse the JSON output of the ACL query script into a structured AclReport. */
export function parseAclJson(json: string): AclReport {
  // ConvertTo-Json with -Compress emits a single-line JSON.
  const parsed = JSON.parse(json) as {
    path: string;
    owner: string | null;
    protectedDacl: boolean;
    principals: Array<{ sid: string; isAllow: boolean; inherited: boolean; rights: number }>;
  };
  if (!parsed || typeof parsed !== 'object') throw new Error('windows_acl_report_invalid');
  if (typeof parsed.path !== 'string' || typeof parsed.protectedDacl !== 'boolean' || !Array.isArray(parsed.principals)) {
    throw new Error('windows_acl_report_invalid');
  }
  if (parsed.owner !== null && typeof parsed.owner !== 'string') throw new Error('windows_acl_owner_invalid');
  const principals = parsed.principals.map((p) => {
    if (!p || typeof p !== 'object'
      || typeof p.sid !== 'string' || !/^S-\d(?:-\d+)+$/.test(p.sid)
      || typeof p.isAllow !== 'boolean' || typeof p.inherited !== 'boolean'
      || typeof p.rights !== 'number' || !Number.isSafeInteger(p.rights)) {
      throw new Error('windows_acl_ace_invalid');
    }
    // PowerShell serializes signed Int32 masks. Normalize to the unsigned
    // 32-bit representation without the signed corruption caused by `| 0`.
    const rights = p.rights >>> 0;
    return { sid: p.sid, isAllow: p.isAllow, inherited: p.inherited, rights };
  });
  return {
    path: parsed.path,
    owner: parsed.owner ?? null,
    protectedDacl: parsed.protectedDacl,
    principals,
    raw: json,
  };
}

/**
 * Run a non-mutating Get-Acl + structural parse. Throws on tool failure
 * (caller should treat tool absence / non-Windows as a separate `skipped`
 * branch and decide policy).
 */
export function readCredentialDirAcl(
  dir: string,
  options: { runPowerShellImpl?: (script: string) => string } = {},
): AclReport {
  const runner = options.runPowerShellImpl ?? runPowerShell;
  const script = buildCredentialAclQueryScript(dir);
  const json = runner(script);
  return parseAclJson(json);
}

/**
 * Verdict: does the report grant FullControl to SYSTEM + Administrators, and
 * grant NO other principal a non-tolerated right?
 */
export function evaluateAclReport(report: AclReport): AclCheckResult {
  if (!report.protectedDacl) return { ok: false, reason: 'dacl_inheritance_enabled', report };
  if (report.principals.some((p) => p.inherited)) {
    return { ok: false, reason: 'inherited_ace_present', report };
  }
  if (report.owner !== null && !REQUIRED_SIDS.includes(report.owner)) {
    return { ok: false, reason: `unauthorized_owner:${report.owner}`, report };
  }
  // Aggregate allow entries, but reject a deny that removes any required right.
  for (const wantSid of REQUIRED_SIDS) {
    const entries = report.principals.filter((p) => p.sid === wantSid);
    const allowed = entries.filter((p) => p.isAllow).reduce((mask, p) => mask | p.rights, 0) >>> 0;
    const denied = entries.filter((p) => !p.isAllow).reduce((mask, p) => mask | p.rights, 0) >>> 0;
    if ((denied & REQUIRED_FULL_CONTROL) !== 0) {
      return { ok: false, reason: `required_right_denied:${wantSid}`, report };
    }
    if ((allowed & REQUIRED_FULL_CONTROL) !== REQUIRED_FULL_CONTROL) {
      return {
        ok: false,
        reason: `missing_full_control:${wantSid}`,
        report,
      };
    }
  }
  // No additional principal is accepted. Even read/list/traverse permission
  // leaks the existence or contents of reusable machine credentials.
  for (const p of report.principals) {
    if (REQUIRED_SIDS.includes(p.sid)) continue;
    if (p.isAllow && p.rights !== 0) {
      return {
        ok: false,
        reason: `unauthorized_allow:${p.sid}:0x${p.rights.toString(16)}`,
        report,
      };
    }
  }
  return { ok: true, reason: 'ok', report };
}

/**
 * Public entry point: read the current effective ACL on `dir` and verdict it.
 * Throws on tool failure (non-Windows, PowerShell missing, etc.) — callers
 * that need a "skipped" signal should call `readCredentialDirAcl` directly
 * and treat the thrown error as "cannot evaluate, fall through to caller
 * policy".
 */
export function assertCredentialDirSecured(dir: string): void {
  const report = readCredentialDirAcl(dir);
  const result = evaluateAclReport(report);
  if (!result.ok) throw new Error(`windows_credential_acl_insecure:${result.reason}`);
}
