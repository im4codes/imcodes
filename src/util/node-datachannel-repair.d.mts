// Type surface for the npm repair helpers.
//
// The implementation is .mjs because it runs as an npm postinstall step, before
// any TypeScript build exists. This declaration lets daemon code use the SAME
// npm resolution rather than keeping a second copy.

export function isDirectInvocation(entryPath: string, selfPath?: string): boolean;

/**
 * npm's own JavaScript entry point (`npm-cli.js`) beside this Node.js, or '' when
 * none is found. Running it through `process.execPath` needs no shell, which
 * matters on Windows, where `npm`/`npx` are `.cmd` files.
 */
export function resolveNpmCliJs(
  npmCommand?: string,
  nodeExecPath?: string,
  env?: NodeJS.ProcessEnv,
): string;

export function repairNodeDatachannel(options?: Record<string, unknown>): unknown;
