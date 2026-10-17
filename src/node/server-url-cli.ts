import { readEndpointState, updatePinnedEndpoints } from './server-endpoints.js';

export interface ServerUrlCliDeps {
  /** Administrator/root of this machine: the only party allowed to add an address the node will send its token to. */
  isElevated: () => boolean;
  endpointsPath: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const SERVER_URL_CLI_USAGE = [
  'usage: imcodes-node set-server-url <https-origin>        add an alternate server address (tried when the enrolled one cannot be reached)',
  '       imcodes-node set-server-url --remove <https-origin>',
  '       imcodes-node set-server-url --clear',
  '       imcodes-node set-server-url --list',
  'The address must be a plain https origin (no path). It must reach the SAME server this node is enrolled with: the node sends its',
  'credential only after choosing an address from this list or from its server, and the server refuses a credential it does not know.',
  'Takes effect within about a minute, without restarting the node.',
].join('\n');

/** `imcodes-node set-server-url ...`. Returns the process exit code. */
export async function runServerUrlCommand(args: readonly string[], deps: ServerUrlCliDeps): Promise<number> {
  const [first, second] = args;
  if (first === undefined || first === '--help' || first === '-h') {
    deps.stdout(`${SERVER_URL_CLI_USAGE}\n`);
    return first === undefined ? 2 : 0;
  }
  if (first === '--list') {
    const state = await readEndpointState(deps.endpointsPath);
    deps.stdout(`pinned: ${state.pinned.join(', ') || '(none)'}\nadvertised by the server: ${state.advertised.join(', ') || '(none)'}\nlast used: ${state.lastGood ?? '(enrolled address)'}\n`);
    return 0;
  }
  if (!deps.isElevated()) {
    deps.stderr('imcodes-node: set-server-url needs Administrator/root\n');
    return 1;
  }
  try {
    let pinned: string[];
    if (first === '--clear') pinned = await updatePinnedEndpoints(deps.endpointsPath, { clear: true });
    else if (first === '--remove' && second) pinned = await updatePinnedEndpoints(deps.endpointsPath, { remove: second });
    else if (!first.startsWith('-') && args.length === 1) pinned = await updatePinnedEndpoints(deps.endpointsPath, { add: first });
    else {
      deps.stderr(`${SERVER_URL_CLI_USAGE}\n`);
      return 2;
    }
    deps.stdout(`alternate server addresses: ${pinned.join(', ') || '(none)'}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.stderr(`imcodes-node: ${message === 'server_url_must_be_an_https_origin' ? 'the address must be a plain https origin such as https://example.com' : message}\n`);
    return 1;
  }
}
