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
    )).resolves.toBe(true);
    const script = decodedScript(calls);
    expect(script).toContain("$codeSigningOid = '1.3.6.1.5.5.7.3.3'");
    expect(script).toContain("Cert:\\LocalMachine\\TrustedPeople");
    expect(script).toContain("Cert:\\LocalMachine\\TrustedPublisher");
    expect(script).not.toContain('LocalMachine\\Root');
    expect(script).not.toContain('Export-PfxCertificate');
    expect(script).toContain('$certificate.RawData');
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
    await expect(installWindowsReleasePublisherTrust('C:\\x.exe', '', run as never)).resolves.toBe(false);
    await expect(verifyWindowsAuthenticodeSigners(['C:\\x.exe'], 'bad', run as never)).resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
