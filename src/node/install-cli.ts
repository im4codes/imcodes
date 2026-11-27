import {
  CONTROLLED_NODE_ENROLL_STDIN_FLAG,
  CONTROLLED_NODE_ENROLL_STDIN_MAX_BYTES,
  CONTROLLED_NODE_INSTALL_SUBCOMMAND,
  parseEnrollmentPayloadJson,
} from '../../shared/controlled-node-install.js';
import type { EnrollmentBlob } from '../../shared/remote-exec.js';
import { parseTrustPeerSpec, type TrustedPeerPinInput } from '../daemon/port-forward-trust-cli.js';

export const CONTROLLED_NODE_TRUST_PEER_FLAG = '--trust-peer' as const;

/**
 * Inspect `process.argv` for the `install --enroll-stdin` subcommand and optional
 * repeatable `--trust-peer <peerServerId>=<publicKey>` pins.
 * Fails closed on unsupported flags or extra positional arguments.
 */
export function parseInstallSubcommandArgs(argv: readonly string[]): boolean {
  if (argv[2] !== CONTROLLED_NODE_INSTALL_SUBCOMMAND) {
    return false;
  }
  const usage = `usage: imcodes-node ${CONTROLLED_NODE_INSTALL_SUBCOMMAND} ${CONTROLLED_NODE_ENROLL_STDIN_FLAG} [--trust-peer <peerServerId>=<publicKey>]`;
  let sawEnrollStdin = false;
  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === CONTROLLED_NODE_ENROLL_STDIN_FLAG) {
      if (sawEnrollStdin) throw new Error(usage);
      sawEnrollStdin = true;
      continue;
    }
    if (arg === CONTROLLED_NODE_TRUST_PEER_FLAG) {
      const value = argv[++i];
      if (!value) throw new Error(usage);
      parseTrustPeerSpec(value);
      continue;
    }
    if (arg.startsWith(`${CONTROLLED_NODE_TRUST_PEER_FLAG}=`)) {
      parseTrustPeerSpec(arg.slice(CONTROLLED_NODE_TRUST_PEER_FLAG.length + 1));
      continue;
    }
    throw new Error(usage);
  }
  if (!sawEnrollStdin) {
    throw new Error(usage);
  }
  return true;
}

export function parseInstallTrustPeers(argv: readonly string[]): TrustedPeerPinInput[] {
  if (argv[2] !== CONTROLLED_NODE_INSTALL_SUBCOMMAND) return [];
  const pins: TrustedPeerPinInput[] = [];
  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === CONTROLLED_NODE_TRUST_PEER_FLAG) {
      const value = argv[++i];
      if (value) pins.push(parseTrustPeerSpec(value));
    } else if (arg.startsWith(`${CONTROLLED_NODE_TRUST_PEER_FLAG}=`)) {
      pins.push(parseTrustPeerSpec(arg.slice(CONTROLLED_NODE_TRUST_PEER_FLAG.length + 1)));
    }
  }
  return pins;
}

/**
 * Read a bounded UTF-8 JSON enrollment payload from stdin and validate it against
 * the shared schema. Never echoes raw stdin or secret tokens in error messages.
 */
export async function readEnrollmentBlobFromStdin(
  stream: AsyncIterable<Buffer | string> = process.stdin,
  maxBytes = CONTROLLED_NODE_ENROLL_STDIN_MAX_BYTES,
): Promise<EnrollmentBlob> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk, 'utf8');
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new Error('enrollment stdin payload exceeds maximum allowed size');
    }
    chunks.push(chunk);
  }
  const rawText = Buffer.concat(chunks, totalBytes).toString('utf8');
  const validated = parseEnrollmentPayloadJson(rawText, maxBytes);
  if (!validated.ok) {
    throw new Error(`invalid enrollment stdin payload (${validated.error})`);
  }
  return validated.value;
}
