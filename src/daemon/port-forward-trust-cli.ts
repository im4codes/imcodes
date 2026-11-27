import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  computePortForwardIdentityFingerprint,
  listTrustedPeerPublicKeys,
  loadOrCreatePortForwardIdentity,
  removeTrustedPeerPublicKey,
  upsertTrustedPeerPublicKey,
  validateEd25519SpkiPublicKey,
} from './port-forward-crypto.js';
import { IMCODES_HOME_ENV, imcodesStateDir } from '../util/imcodes-state-dir.js';

export const PORT_FORWARD_IDENTITY_BASENAME = 'port-forward-identity.json';
export const PORT_FORWARD_TRUSTED_PEERS_BASENAME = 'port-forward-trusted-peers.json';

export interface TrustedPeerPinInput {
  peerServerId: string;
  publicKey: string;
}

/**
 * Resolve the authoritative port-forward state directory for a controlled node:
 * - Scoped/test instances (`IMCODES_HOME` set) stay strictly isolated under `imcodesStateDir()`.
 * - Standard system controlled-node installs keep identity & trust alongside `credential.json`.
 */
export function controlledNodePortForwardStateDir(
  credentialPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env[IMCODES_HOME_ENV]?.trim()) return imcodesStateDir(env);
  if (credentialPath) return dirname(credentialPath);
  return imcodesStateDir(env);
}

/**
 * Parse a `<peerServerId>=<publicKeyB64>` CLI trust specification cleanly and fail closed.
 */
export function parseTrustPeerSpec(rawSpec: string): TrustedPeerPinInput {
  const eq = rawSpec.indexOf('=');
  if (eq <= 0 || eq === rawSpec.length - 1) {
    throw new Error('trust-peer must use <peerServerId>=<publicKey>');
  }
  const peerServerId = rawSpec.slice(0, eq).trim();
  const publicKey = rawSpec.slice(eq + 1).trim();
  if (!peerServerId || peerServerId.length > 128 || /[\s\0]/.test(peerServerId)) {
    throw new Error(`invalid peerServerId in trust-peer: "${peerServerId}"`);
  }
  if (!validateEd25519SpkiPublicKey(publicKey)) {
    throw new Error(`invalid Ed25519 public key in trust-peer for "${peerServerId}"`);
  }
  return { peerServerId, publicKey };
}

export function applyTrustedPeerPins(
  stateDir: string,
  peers: readonly TrustedPeerPinInput[],
): Array<{ peerServerId: string; publicKey: string; fingerprint: string; created: boolean }> {
  const trustPath = join(stateDir, PORT_FORWARD_TRUSTED_PEERS_BASENAME);
  return peers.map((p) => upsertTrustedPeerPublicKey(trustPath, p.peerServerId, p.publicKey));
}

function readIdentityBindingMetadata(credentialPath: string): { serverId: string | null; nodeId: string | null } {
  try {
    const raw = JSON.parse(readFileSync(credentialPath, 'utf8')) as {
      serverId?: unknown;
      nodeId?: unknown;
    };
    return {
      serverId: typeof raw.serverId === 'string' && raw.serverId.trim() ? raw.serverId.trim() : null,
      nodeId: typeof raw.nodeId === 'string' && raw.nodeId.trim() ? raw.nodeId.trim() : null,
    };
  } catch {
    return { serverId: null, nodeId: null };
  }
}

export interface PortForwardCliOptions {
  role: 'full' | 'controlled';
  stateDir: string;
  credentialPath: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/**
 * Shared pure-Node production CLI handler for `imcodes port-forward ...` (FULL daemon)
 * and `imcodes-node port-forward ...` (controlled node SEA binary).
 */
export async function runPortForwardCliCommand(
  argv: readonly string[],
  opts: PortForwardCliOptions,
): Promise<number> {
  const jsonOutput = argv.includes('--json');
  const positional = argv.filter((arg) => arg !== '--json');
  const sub = positional[0];
  const identityPath = join(opts.stateDir, PORT_FORWARD_IDENTITY_BASENAME);
  const trustedPeersPath = join(opts.stateDir, PORT_FORWARD_TRUSTED_PEERS_BASENAME);

  if (!sub || sub === '--help' || sub === '-h') {
    opts.stdout(
      [
        'Usage:',
        '  port-forward identity [--json]',
        '  port-forward trust add <peerServerId> <publicKey> [--json]',
        '  port-forward trust remove <peerServerId> [--json]',
        '  port-forward trust list [--json]',
        '',
      ].join('\n'),
    );
    return sub ? 0 : 1;
  }

  if (sub === 'identity') {
    const kp = loadOrCreatePortForwardIdentity(identityPath);
    const binding = readIdentityBindingMetadata(opts.credentialPath);
    const fingerprint = computePortForwardIdentityFingerprint(kp.publicKeyB64);
    const payload = {
      role: opts.role,
      serverId: binding.serverId,
      ...(binding.nodeId ? { nodeId: binding.nodeId } : {}),
      identityPublicKey: kp.publicKeyB64,
      fingerprint,
      identityFilePath: identityPath,
      trustedPeersFilePath: trustedPeersPath,
    };
    if (jsonOutput) {
      opts.stdout(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      opts.stdout(`Role:        ${payload.role}\n`);
      opts.stdout(`Server ID:   ${payload.serverId ?? '(not bound yet)'}\n`);
      if (payload.nodeId) opts.stdout(`Node ID:     ${payload.nodeId}\n`);
      opts.stdout(`Public Key:  ${payload.identityPublicKey}\n`);
      opts.stdout(`Fingerprint: ${payload.fingerprint}\n`);
    }
    return 0;
  }

  if (sub === 'trust') {
    const action = positional[1];
    if (action === 'add') {
      const peerServerId = positional[2];
      const publicKey = positional[3];
      if (!peerServerId || !publicKey || positional.length > 4) {
        opts.stderr('Usage: port-forward trust add <peerServerId> <publicKey> [--json]\n');
        return 1;
      }
      try {
        const saved = upsertTrustedPeerPublicKey(trustedPeersPath, peerServerId, publicKey);
        if (jsonOutput) {
          opts.stdout(`${JSON.stringify(saved, null, 2)}\n`);
        } else {
          opts.stdout(
            `${saved.created ? 'Added' : 'Updated'} trusted peer ${saved.peerServerId} (${saved.fingerprint})\n`,
          );
        }
        return 0;
      } catch (err) {
        opts.stderr(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
    }

    if (action === 'remove') {
      const peerServerId = positional[2];
      if (!peerServerId || positional.length > 3) {
        opts.stderr('Usage: port-forward trust remove <peerServerId> [--json]\n');
        return 1;
      }
      const removed = removeTrustedPeerPublicKey(trustedPeersPath, peerServerId);
      if (jsonOutput) {
        opts.stdout(`${JSON.stringify({ peerServerId, removed })}\n`);
      } else {
        opts.stdout(removed ? `Removed trusted peer ${peerServerId}\n` : `Peer ${peerServerId} not found\n`);
      }
      return 0;
    }

    if (action === 'list') {
      const peers = listTrustedPeerPublicKeys(trustedPeersPath);
      if (jsonOutput) {
        opts.stdout(`${JSON.stringify({ peers }, null, 2)}\n`);
      } else if (peers.length === 0) {
        opts.stdout('No trusted port-forward peers configured.\n');
      } else {
        for (const p of peers) {
          opts.stdout(`${p.peerServerId}\t${p.fingerprint}\t${p.publicKey}\n`);
        }
      }
      return 0;
    }
  }

  opts.stderr('Unknown port-forward subcommand. Use --help for usage.\n');
  return 1;
}
