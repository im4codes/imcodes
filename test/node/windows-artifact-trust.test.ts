import { describe, expect, it, vi } from 'vitest';
import type { execFile } from 'node:child_process';
import {
  installWindowsReleasePublisherTrust,
  verifyWindowsAuthenticodeSigners,
} from '../../src/node/windows-artifact-trust.js';

function successfulRunner(capture: string[]): typeof execFile {
  return vi.fn((file: string, args: readonly string[], options: unknown, callback: (error: Error | null) => void) => {
    capture.push(file, ...args, JSON.stringify(options));
    callback(null);
    return {} as never;
  }) as unknown as typeof execFile;
}

function decodedScript(capture: string[]): string {
  const encodedIndex = capture.indexOf('-EncodedCommand') + 1;
  return Buffer.from(capture[encodedIndex]!, 'base64').toString('utf16le');
}

/** execFile stub that fails the way PowerShell actually fails. */
function failingRunner(stderr: string, extra: Record<string, unknown> = {}): typeof execFile {
  return vi.fn((
    _file: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderrOut: string) => void,
  ) => {
    callback(Object.assign(new Error('Command failed'), extra), '', stderr);
    return {} as never;
  }) as unknown as typeof execFile;
}

describe('Windows release publisher trust failure reporting', () => {
  it('carries the script\'s own reason instead of a bare boolean', async () => {
    // Each of these is a distinct throw in the trust script. Collapsing them
    // into one message is what left a real failed install undiagnosable.
    const reasons = [
      'release signer certificate is missing',
      'release signer does not match the compiled trust anchor',
      'release signer is not valid for code signing',
      'release publisher trust installation did not validate the executable',
      'trusted release signer changed during installation',
    ];
    for (const reason of reasons) {
      const outcome = await installWindowsReleasePublisherTrust(
        'C:\\Users\\test\\Downloads\\imcodes-node.exe',
        'a'.repeat(64),
        failingRunner(`${reason}\r\nAt line:22 char:35\r\n+     throw 'x'\r\n+     ~~~~~~~~~`),
      );
      expect(outcome).toEqual({ ok: false, detail: reason });
    }
  });

  it('strips PowerShell position noise and the script-name prefix', async () => {
    const outcome = await installWindowsReleasePublisherTrust(
      'C:\\Users\\test\\Downloads\\imcodes-node.exe',
      'a'.repeat(64),
      failingRunner('C:\\Windows\\Temp\\t.ps1 : Access is denied.\r\nAt line:1 char:1\r\n+ ~~~~\r\n    + CategoryInfo : SecurityError'),
    );
    expect(outcome).toEqual({ ok: false, detail: 'Access is denied.' });
  });

  it('names a timeout as a timeout rather than an empty reason', async () => {
    const outcome = await installWindowsReleasePublisherTrust(
      'C:\\Users\\test\\Downloads\\imcodes-node.exe',
      'a'.repeat(64),
      failingRunner('', { killed: true }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/did not finish within \d+s/);
  });
});

describe('Windows release artifact trust', () => {
  it('verifies every launch against a valid chain and the exact raw-DER signer hash', async () => {
    const calls: string[] = [];
    const signer = 'a'.repeat(64);
    await expect(verifyWindowsAuthenticodeSigners(
      ['C:\\ProgramData\\imcodes-node\\open-computer-use.exe'],
      signer,
      successfulRunner(calls),
    )).resolves.toBe(true);
    const script = decodedScript(calls);
    expect(script).toContain("Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'");
    expect(script.indexOf('Import-Module -Name $securityModulePath -ErrorAction Stop'))
      .toBeLessThan(script.indexOf('Get-AuthenticodeSignature'));
    expect(script).toContain('Get-AuthenticodeSignature');
    expect(script).toContain('SignatureStatus]::Valid');
    expect(script).toContain('SignerCertificate.RawData');
    expect(script).toContain(signer);
  });

  it('installs only the anchored public code-signing leaf into machine publisher stores', async () => {
    const calls: string[] = [];
    const signer = 'b'.repeat(64);
    await expect(installWindowsReleasePublisherTrust(
      'C:\\Users\\test\\Downloads\\imcodes-node.exe',
      signer,
      successfulRunner(calls),
    )).resolves.toEqual({ ok: true, detail: '' });
    const script = decodedScript(calls);
    expect(script).toContain("$codeSigningOid = '1.3.6.1.5.5.7.3.3'");
    expect(script).toContain("Cert:\\LocalMachine\\TrustedPeople");
    expect(script).toContain("Cert:\\LocalMachine\\TrustedPublisher");
    expect(script).not.toContain('LocalMachine\\Root');
    expect(script).not.toContain('Export-PfxCertificate');
    expect(script).toContain('$certificate.RawData');
    expect(script).toContain('Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1');
    expect(script).toContain('Modules\\PKI\\PKI.psd1');
    expect(script).toContain('if ($actual -cne $expected)');
    expect(script).toContain('if (-not $hasCodeSigningEku)');
    expect(script.indexOf("throw 'release signer does not match the compiled trust anchor'"))
      .toBeLessThan(script.indexOf('Import-Certificate'));
    expect(script.indexOf("throw 'release signer is not valid for code signing'"))
      .toBeLessThan(script.indexOf('Import-Certificate'));
    expect(script).toContain('Test-AnchoredCertificateInStore');
    expect(script.indexOf('Test-AnchoredCertificateInStore')).toBeLessThan(script.indexOf('[IO.File]::WriteAllBytes'));
    expect(script).toContain('$trustedPeoplePresent -and $trustedPublisherPresent');
    expect(script).toContain('Remove-Item -LiteralPath $temporaryCertificate');
    expect(script).toContain(signer);
    expect(calls.at(-1)).toContain('"timeout":60000');
    expect(calls.at(-1)).toContain('"maxBuffer":65536');
  });

  it('fails closed without a compiled-style signer anchor', async () => {
    const run = vi.fn();
    await expect(installWindowsReleasePublisherTrust('C:\\x.exe', '', run as never))
      .resolves.toEqual({ ok: false, detail: 'no compiled release trust anchor' });
    await expect(verifyWindowsAuthenticodeSigners(['C:\\x.exe'], 'bad', run as never)).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
