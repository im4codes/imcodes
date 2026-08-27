// Type surface for the shared Apple trust checks.
//
// The implementation is .mjs because the packager is a plain Node script and
// must run without a TypeScript build. This declaration lets the daemon-side
// verifier consume the SAME implementation rather than keeping a second copy.

export interface MacosAppleTrustCommandResult {
  stdout: string;
  stderr: string;
}

export type MacosAppleTrustExecutor = (
  tool: string,
  args: readonly string[],
) => Promise<MacosAppleTrustCommandResult>;

export interface MacosAppleTrustIdentity {
  bundleIdentifier: string;
  designatedRequirement: string;
}

export interface MacosAppleTrustNotarization {
  status: string;
  stapled: boolean;
  stapleValidated: boolean;
}

export declare const MACOS_APPLE_TOOLS: Readonly<{
  lipo: string;
  codesign: string;
  spctl: string;
  xcrun: string;
}>;

export declare const MACOS_APPLE_TRUST_ERROR: Readonly<{
  ARCHITECTURE_MISMATCH: string;
  CODE_IDENTITY_MISMATCH: string;
  DESIGNATED_REQUIREMENT_MISMATCH: string;
  NOTARIZATION_REJECTED: string;
  STAPLE_INVALID: string;
}>;

export declare function appleCommandOutput(result: MacosAppleTrustCommandResult): string;
export declare function appleLineValue(output: string, prefix: string): string | null;

export declare function verifyMacosAppleTrust(
  executablePath: string,
  identity: MacosAppleTrustIdentity,
  notarization: MacosAppleTrustNotarization,
  teamId: string,
  expectedArch: 'arm64' | 'x64',
  execute: MacosAppleTrustExecutor,
): Promise<void>;

export declare function assertExactComponentSetEntries(
  directory: string,
  expectedNames: readonly string[],
  readdir: (
    path: string,
    options: { withFileTypes: true },
  ) => Promise<Array<{ name: string; isFile(): boolean; isSymbolicLink(): boolean }>>,
): Promise<void>;
