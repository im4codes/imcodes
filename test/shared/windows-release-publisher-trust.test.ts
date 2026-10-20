import { describe, expect, it } from 'vitest';
import {
  buildWindowsReleasePublisherTrustScript,
  buildWindowsReleasePublisherTrustScriptForVariable,
} from '../../shared/windows-release-publisher-trust.js';

const SIGNER = '5aedf20057238b95a27f714a1c8d7b038f42a0233189625d2f2c1fa251870b9a';

/** Strip PowerShell comments so assertions match executed code, not prose. */
function executableLines(script: string): string {
  return script
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#.*$/, ''))
    .join('\n');
}

const BOTH = [
  ['path', buildWindowsReleasePublisherTrustScript('C:\\imcodes\\node.exe', SIGNER)],
  ['variable', buildWindowsReleasePublisherTrustScriptForVariable('stagedPath', SIGNER)],
] as const;

describe('windows release publisher trust script', () => {
  describe.each(BOTH)('%s form', (_form, script) => {
    const code = executableLines(script);

    // The regression this file exists for. Import-Certificate cannot create a
    // LocalMachine physical store that does not exist yet: on a machine that has
    // never trusted a publisher, Cert:\LocalMachine\TrustedPublisher has no
    // registry key and the cmdlet fails with E_ACCESSDENIED even when elevated.
    // That aborted the trust step on every fresh Windows install, which in turn
    // aborted enrolment before the node ever registered.
    it('never writes stores through Import-Certificate', () => {
      expect(code).not.toContain('Import-Certificate');
    });

    it('writes stores through X509Store opened ReadWrite, which creates them', () => {
      expect(code).toContain('X509Certificates.X509Store($storeName');
      expect(code).toContain('X509Certificates.OpenFlags]::ReadWrite');
      expect(code).toContain('$store.Add($certificate)');
      expect(code).toContain('$store.Close()');
    });

    // Dropping Import-Certificate removes the only PKI cmdlet, so requiring the
    // PKI module would be a failure mode with nothing behind it. Slimmed Windows
    // images routinely ship without it.
    it('does not require the PKI module', () => {
      expect(code).not.toContain('PKI.psd1');
      expect(code).toContain('Microsoft.PowerShell.Security.psd1');
    });

    it('covers both anchor stores', () => {
      expect(code).toContain("$anchorStoreNames = @('TrustedPeople', 'TrustedPublisher')");
    });

    // A store that cannot be written must not stop the other from being tried,
    // and must not by itself fail the install: the executable validating is what
    // the caller actually needs.
    it('attempts every store and lets the final validation decide', () => {
      expect(code).toContain('catch { $storeFailures += ');
      const failureIndex = code.indexOf('$storeFailures +=');
      const gateIndex = code.indexOf('$trusted = Get-AuthenticodeSignature');
      expect(failureIndex).toBeGreaterThan(-1);
      expect(gateIndex).toBeGreaterThan(failureIndex);
    });

    it('surfaces store failures in the thrown reason', () => {
      expect(code).toContain("$storeFailures -join '; '");
    });

    // The security contract, unchanged by the fix.
    it('still pins the signer to the compiled anchor', () => {
      expect(code).toContain(`$expected = '${SIGNER}'`);
      expect(code).toContain("throw 'release signer does not match the compiled trust anchor'");
      expect(code).toContain("throw 'trusted release signer changed during installation'");
      expect(code).toContain("throw 'release signer is not valid for code signing'");
      expect(code).toContain("throw 'release signer certificate is missing'");
    });
  });

  it('rejects a signer hash that is not lowercase hex', () => {
    expect(() => buildWindowsReleasePublisherTrustScript('C:\\a.exe', 'nope'))
      .toThrow('invalid_windows_release_signer_sha256');
    expect(() => buildWindowsReleasePublisherTrustScript('C:\\a.exe', SIGNER.toUpperCase()))
      .toThrow('invalid_windows_release_signer_sha256');
  });

  it('rejects a variable name that could inject PowerShell', () => {
    expect(() => buildWindowsReleasePublisherTrustScriptForVariable('x; iex(1)', SIGNER))
      .toThrow('invalid_windows_release_publisher_path_variable');
  });
});
