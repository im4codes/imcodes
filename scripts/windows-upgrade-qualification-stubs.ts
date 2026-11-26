import { WINDOWS_UPGRADE_HEALTH_WAIT_END_MARKER } from '../src/node/upgrade-health-script.js';

/**
 * Stubs for qualifying the generated Windows self-upgrade script without a real
 * node, scheduler or wall-clock wait (scripts/qualify-windows-self-upgrade.ts and
 * test/node/windows-upgrade-qualification-stubs.test.ts share this one source).
 *
 * The script waits for the new node's health with real primitives: a stopwatch,
 * `Start-Sleep -Milliseconds`, `Get-Process` and the lease file. A harness that
 * stubbed only the primitives of an older script (`Start-Sleep -Seconds`, WMI)
 * left the wait running on the real clock for its full spawn allowance.
 *
 * The node is "started" once the harness's own `Start-ScheduledTask` stub for the
 * node task sets `$script:qualificationNodeStarted`; until then no process exists,
 * so the executable-release waits (before the restart and during a rollback) see
 * a stopped node and return at once.
 */

/** Stubs that must exist BEFORE the generated script (it calls them while it runs). */
export const QUALIFICATION_BASE_STUBS: readonly string[] = [
  '$script:qualificationNodeStarted = $false',
  'function Start-Sleep { param([int]$Seconds, [int]$Milliseconds) }',
  'function Stop-ScheduledTask { param($TaskName, $ErrorAction) }',
  'function Unregister-ScheduledTask { param($TaskName, $Confirm, $ErrorAction) }',
  'function Stop-Process { param($Id, $Force, $ErrorAction) }',
];

/**
 * Stubs injected right after the health-wait block, so they replace its defaults:
 * a virtual clock that `Start-Sleep` advances (the wait finishes in milliseconds of
 * real time whatever its verdict) and a fake node process visible only once started.
 */
export const QUALIFICATION_HEALTH_STUBS: readonly string[] = [
  '$script:qualificationClockMs = [int64]0',
  'function Start-Sleep { param([int]$Seconds, [int]$Milliseconds) $script:qualificationClockMs += ([int64]$Seconds * 1000) + [int64]$Milliseconds }',
  'function Get-IMCodesElapsedMs { return [int64]$script:qualificationClockMs }',
  'function Get-Process { param($Name, $Id, $ErrorAction); if ($script:qualificationNodeStarted -and ($Name -eq "imcodes-node" -or $Id -eq 42)) { [pscustomobject]@{ Id = 42; Path = $qualificationNode } } }',
];

/** Inject the health stubs right after the marker that ends the script's health-wait block. */
export function applyQualificationHealthStubs(generatedScript: string): string {
  if (!generatedScript.includes(WINDOWS_UPGRADE_HEALTH_WAIT_END_MARKER)) {
    throw new Error('generated upgrade script has no health-wait end marker; the qualification stubs cannot be applied');
  }
  return generatedScript.replace(
    WINDOWS_UPGRADE_HEALTH_WAIT_END_MARKER,
    () => `${WINDOWS_UPGRADE_HEALTH_WAIT_END_MARKER}\r\n${QUALIFICATION_HEALTH_STUBS.join('\r\n')}`,
  );
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The whole harness script for one scenario: scenario variables, the stubs, the
 * node-start stub (publication/ACL evidence, and in `success` mode a started node
 * with a fresh lease) and then the generated upgrade script with the health stubs
 * injected. Used by scripts/qualify-windows-self-upgrade.ts and by tests.
 */
export function qualificationUpgradeHarnessScript(input: {
  mode: 'success' | 'rollback';
  installed: string;
  installedHelper: string;
  lease: string;
  publicationEvidence: string;
  generatedScript: string;
}): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$qualificationMode = ${psQuote(input.mode)}`,
    `$qualificationNode = ${psQuote(input.installed)}`,
    `$qualificationHelper = ${psQuote(input.installedHelper)}`,
    `$qualificationLease = ${psQuote(input.lease)}`,
    `$qualificationPublicationEvidence = ${psQuote(input.publicationEvidence)}`,
    ...QUALIFICATION_BASE_STUBS,
    'function Get-QualificationAclEvidence {',
    '  param([string]$Path)',
    '  $acl = Get-Acl -LiteralPath $Path',
    '  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))',
    '  $full = [System.Security.AccessControl.FileSystemRights]::FullControl',
    '  $readExecute = [System.Security.AccessControl.FileSystemRights]::ReadAndExecute',
    '  [pscustomobject]@{',
    '    protected = [bool]$acl.AreAccessRulesProtected',
    "    ownerSystem = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-18'",
    "    systemFull = @($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-18' -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $full) -eq $full }).Count -gt 0",
    "    administratorsFull = @($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-32-544' -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $full) -eq $full }).Count -gt 0",
    "    authenticatedUsersReadExecute = @($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-11' -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band $readExecute) -eq $readExecute }).Count -gt 0",
    '  }',
    '}',
    'function Start-ScheduledTask {',
    '  param($TaskName, $ErrorAction)',
    '  if ($TaskName -eq "imcodes-node") {',
    '    if (-not (Test-Path -LiteralPath $qualificationPublicationEvidence)) {',
    '      $mainAcl = Get-QualificationAclEvidence -Path $qualificationNode',
    '      $helperAcl = Get-QualificationAclEvidence -Path (Split-Path -Parent $qualificationHelper)',
    '      @{',
    '        mainSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $qualificationNode).Hash.ToLowerInvariant()',
    '        helperSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $qualificationHelper).Hash.ToLowerInvariant()',
    '        markerWasPresent = Test-Path -LiteralPath (Join-Path (Split-Path -Parent $qualificationNode) "upgrade-in-progress.json")',
    '        mainAcl = $mainAcl',
    '        helperRootAcl = $helperAcl',
    '      } | ConvertTo-Json -Depth 4 -Compress | Set-Content -LiteralPath $qualificationPublicationEvidence -Encoding utf8',
    '    }',
    '    if ($qualificationMode -eq "success") {',
    '      $script:qualificationNodeStarted = $true',
    '      @{ version = 1; pid = 42; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress | Set-Content -LiteralPath $qualificationLease -Encoding utf8',
    '    }',
    '  }',
    '}',
    applyQualificationHealthStubs(input.generatedScript),
  ].join('\r\n');
}
