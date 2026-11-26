import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildWindowsControlledNodeUpgradeScript } from '../../src/node/self-upgrade.js';
import { windowsManifestBackupScript, windowsManifestRestoreScript } from '../../src/node/upgrade-manifest-script.js';
import { findPowerShell, runPowerShell } from './powershell-test-helper.js';

const pwsh = findPowerShell();
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const OLD = '{"build":{"version":"2026.10.5479-dev.5940"}}';
const NEW = '{"build":{"version":"2026.10.5493-dev.5954"}}';
const STALE = '{"build":{"version":"2026.9.1-dev.1"}}';

/**
 * Runs the REAL backup block, a publish of the new manifest, the REAL restore block
 * (rollback), under PowerShell with a minimal `$runRecovery`, on temp files.
 */
function upgradeThenRollback(input: { installed?: string; leftoverBackup?: string; alreadyPublished?: boolean; failBeforePublish?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'imcodes-manifest-'));
  dirs.push(dir);
  const dst = join(dir, 'imcodes-node.exe.manifest.json');
  const backup = `${dst}.upgrade-old`;
  const src = join(dir, 'staged.manifest.json');
  writeFileSync(src, NEW);
  if (input.installed !== undefined) writeFileSync(dst, input.installed);
  if (input.leftoverBackup !== undefined) writeFileSync(backup, input.leftoverBackup);
  const script = `
$ErrorActionPreference = 'Stop'
$dstManifest = '${dst}'
$backupManifest = '${backup}'
$srcManifest = '${src}'
$srcManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $srcManifest).Hash.ToLowerInvariant()
$manifestBackedUp = $false
$manifestPublished = $false
$rollbackManifestHash = ''
$recoveryFailures = [System.Collections.Generic.List[string]]::new()
$runRecovery = { param([string]$label,[scriptblock]$action) try { & $action } catch { [void]$recoveryFailures.Add(('{0}: {1}' -f $label, $_.Exception.Message)) } }
${windowsManifestBackupScript()}
$backedUpAfterBackup = $manifestBackedUp
${input.failBeforePublish ? '' : 'Copy-Item -Force -LiteralPath $srcManifest -Destination $dstManifest; $manifestPublished = $true'}
${windowsManifestRestoreScript()}
[ordered]@{ backedUp = $backedUpAfterBackup; failures = @($recoveryFailures) } | ConvertTo-Json -Compress
`;
  const run = runPowerShell(pwsh!, script);
  expect(run.status, run.stderr).toBe(0);
  const out = JSON.parse(run.stdout.trim().split('\n').pop()!) as { backedUp: boolean; failures: string[] };
  return {
    ...out,
    manifest: existsSync(dst) ? readFileSync(dst, 'utf8') : null,
    backupFile: existsSync(backup) ? readFileSync(backup, 'utf8') : null,
  };
}

describe.skipIf(!pwsh)('Windows self-upgrade manifest backup and rollback (PowerShell)', () => {
  it('a rollback puts the ORIGINAL manifest back, byte for byte (it used to delete it)', () => {
    const result = upgradeThenRollback({ installed: OLD });
    expect(result.backedUp).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.manifest).not.toBeNull();
    expect(sha(result.manifest!)).toBe(sha(OLD));
    expect(result.backupFile).toBe(OLD); // the recovery copy is kept for the operator
  });

  it('a node that had no manifest ends the rollback with none (nothing to restore, the published one is removed)', () => {
    const result = upgradeThenRollback({});
    expect(result.backedUp).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.manifest).toBeNull();
  });

  it('a leftover backup from an older rolled-back attempt does not replace a manifest that has changed since', () => {
    const result = upgradeThenRollback({ installed: OLD, leftoverBackup: STALE });
    expect(result.failures).toEqual([]);
    expect(sha(result.manifest!)).toBe(sha(OLD));
  });

  it('an interrupted earlier attempt that already published the new manifest keeps ITS backup as the authority', () => {
    // dst already holds the new manifest, the backup (taken by the interrupted attempt) holds the original.
    const result = upgradeThenRollback({ installed: NEW, leftoverBackup: OLD });
    expect(result.backedUp).toBe(true);
    expect(result.failures).toEqual([]);
    expect(sha(result.manifest!)).toBe(sha(OLD));
  });

  it('a failure before the new manifest was published still restores the original (and does not delete it)', () => {
    const result = upgradeThenRollback({ installed: OLD, failBeforePublish: true });
    expect(result.failures).toEqual([]);
    expect(sha(result.manifest!)).toBe(sha(OLD));
  });

  it('refuses to restore from a backup that no longer matches what was recorded, and reports it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imcodes-manifest-'));
    dirs.push(dir);
    const dst = join(dir, 'imcodes-node.exe.manifest.json');
    const backup = `${dst}.upgrade-old`;
    const src = join(dir, 'staged.manifest.json');
    writeFileSync(src, NEW);
    writeFileSync(dst, OLD);
    const run = runPowerShell(pwsh!, `
$ErrorActionPreference = 'Stop'
$dstManifest = '${dst}'; $backupManifest = '${backup}'; $srcManifest = '${src}'
$srcManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $srcManifest).Hash.ToLowerInvariant()
$manifestBackedUp = $false; $manifestPublished = $false; $rollbackManifestHash = ''
$recoveryFailures = [System.Collections.Generic.List[string]]::new()
$runRecovery = { param([string]$label,[scriptblock]$action) try { & $action } catch { [void]$recoveryFailures.Add(('{0}: {1}' -f $label, $_.Exception.Message)) } }
${windowsManifestBackupScript()}
Copy-Item -Force -LiteralPath $srcManifest -Destination $dstManifest; $manifestPublished = $true
Set-Content -LiteralPath $backupManifest -Value 'tampered'
${windowsManifestRestoreScript()}
@($recoveryFailures) | ConvertTo-Json -Compress`);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('manifest rollback source hash mismatch');
    expect(readFileSync(dst, 'utf8')).toBe(NEW); // not overwritten with the tampered copy
  });
});

describe('manifest backup in the generated upgrade script', () => {
  const script = buildWindowsControlledNodeUpgradeScript({
    stagedArtifactPath: 'C:\\Windows\\Temp\\imcodes-node-upgrade-ABC123\\imcodes-node.exe',
    stagedManifestPath: 'C:\\Windows\\Temp\\imcodes-node-upgrade-ABC123\\imcodes-node.exe.manifest.json',
    destinationPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
    destinationManifestPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe.manifest.json',
    targetVersion: '2026.9.9999',
    upgradeTaskName: 'imcodes-node-upgrade-test',
  });

  it('records the backup before it publishes the new manifest, and rolls back from the recorded hash', () => {
    const backup = script.indexOf(windowsManifestBackupScript().split('\r\n')[0]!);
    const publish = script.indexOf('$manifestPublished = $true');
    const restore = script.indexOf(windowsManifestRestoreScript().trim());
    expect(backup).toBeGreaterThan(0);
    expect(publish).toBeGreaterThan(backup);
    expect(restore).toBeGreaterThan(publish);
    expect(script).toContain("$rollbackManifestHash = ''");
    expect(script).toContain('$manifestBackedUp = Test-Path -LiteralPath $backupManifest');
  });

  it('every rollback "backed up" flag the script reads is also set by it (the class of the manifest bug)', () => {
    // A script with every optional artifact: main, manifest, computer-use helper, remote-desktop worker, journal.
    const full = buildWindowsControlledNodeUpgradeScript({
      stagedArtifactPath: 'C:\\Windows\\Temp\\imcodes-node-upgrade-ABC123\\imcodes-node.exe',
      stagedManifestPath: 'C:\\Windows\\Temp\\imcodes-node-upgrade-ABC123\\imcodes-node.exe.manifest.json',
      destinationPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe',
      destinationManifestPath: 'C:\\ProgramData\\imcodes-node\\imcodes-node.exe.manifest.json',
      stagedComputerUseHelperDir: 'C:\\Windows\\Temp\\imcodes-node-upgrade-ABC123\\helper',
      stagedRemoteDesktopWorkerDir: 'C:\\Windows\\Temp\\imcodes-node-upgrade-ABC123\\worker',
      stagedJournalPath: 'C:\\Windows\\Temp\\imcodes-node-upgrade-ABC123\\install-journal.json',
      destinationJournalPath: 'C:\\ProgramData\\imcodes-node\\install-journal.json',
      targetVersion: '2026.9.9999',
      upgradeTaskName: 'imcodes-node-upgrade-test',
    });
    const flags = [...new Set([...full.matchAll(/\$([A-Za-z]+BackedUp)\b/g)].map((m) => m[1]!))];
    expect(flags.sort()).toEqual(['helperBackedUp', 'journalBackedUp', 'mainBackedUp', 'manifestBackedUp', 'remoteDesktopBackedUp']);
    for (const flag of flags) {
      // `$flag = <anything but the initial $false>` must exist: a flag that is only ever false makes its rollback branch dead.
      const assigned = full.match(new RegExp(`\\$${flag} = (?!\\$false)`, 'g')) ?? [];
      expect(assigned.length, `${flag} is read by the rollback but never set`).toBeGreaterThan(0);
    }
  });
});
