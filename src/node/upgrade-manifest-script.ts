/**
 * PowerShell for backing up and restoring the node's release manifest
 * (`imcodes-node.exe.manifest.json`) around a Windows self-upgrade. Plain text
 * blocks so the generated upgrade script and the script-level tests run the very
 * same code.
 *
 * Variables the generated script provides: `$dstManifest`, `$backupManifest`,
 * `$srcManifestHash` (hash of the manifest being published), and the flags
 * `$manifestBackedUp` / `$manifestPublished` / `$rollbackManifestHash`
 * (initialised false/false/'' before the transaction).
 *
 * The flag that says a backup exists was initialised and read by the rollback
 * but never set, so every rollback fell through to "remove the published
 * manifest" and left the node without one.
 */

/**
 * Take the rollback copy BEFORE the new manifest is published, and record what
 * the rollback must restore.
 *
 * The backup is refreshed from the installed manifest unless that manifest is
 * already the one being published: then an earlier interrupted attempt got that
 * far and the backup it took is the original, so it stays the authority. A
 * leftover backup from an older, since-rolled-back attempt must not outlive a
 * manifest that changed in the meantime.
 */
export function windowsManifestBackupScript(): string {
  return [
    `if (Test-Path -LiteralPath $dstManifest) {`,
    `  if (-not (Test-Path -LiteralPath $backupManifest) -or (Get-FileHash -Algorithm SHA256 -LiteralPath $dstManifest).Hash.ToLowerInvariant() -cne $srcManifestHash) { Copy-Item -Force -LiteralPath $dstManifest -Destination $backupManifest }`,
    `}`,
    `$manifestBackedUp = Test-Path -LiteralPath $backupManifest`,
    `if ($manifestBackedUp) { $rollbackManifestHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $backupManifest).Hash.ToLowerInvariant() }`,
  ].join('\r\n') + '\r\n';
}

/** The rollback step: put the original manifest back, or remove one this upgrade created from nothing. */
export function windowsManifestRestoreScript(): string {
  return `& $runRecovery 'restore_manifest' { if ($manifestBackedUp -and (Test-Path $backupManifest)) { if ((Get-FileHash -Algorithm SHA256 -LiteralPath $backupManifest).Hash.ToLowerInvariant() -cne $rollbackManifestHash) { throw 'controlled node manifest rollback source hash mismatch' }; Copy-Item -Force $backupManifest $dstManifest; if ((Get-FileHash -Algorithm SHA256 -LiteralPath $dstManifest).Hash.ToLowerInvariant() -cne $rollbackManifestHash) { throw 'controlled node restored manifest hash mismatch' } } elseif ($manifestPublished) { Remove-Item -Force $dstManifest -ErrorAction Stop } }\r\n`;
}
