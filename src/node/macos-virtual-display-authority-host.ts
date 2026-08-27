/**
 * The daemon's live virtual-display authority.
 *
 * This is the piece that was missing: the listener, the grant and the lease all
 * existed, and nothing started, sent or held them. Every worker request
 * therefore answered `agent_unavailable`, and the whole display path was dead
 * code that type-checked.
 *
 * WHAT IT OWNS
 *
 *   * the root rendezvous listener the resident agent dials;
 *   * exactly ONE live lease -- the agent connection itself;
 *   * the grant, built from the SAME verified artifact the worker was launched
 *     from, so a helper can never be authorised against a set that was never
 *     verified;
 *   * a STRICTLY SERIAL exchange onto that lease.
 *
 * WHY SERIAL. The agent answers one control line at a time on one socket. Two
 * requests in flight would be correlated by arrival order, and arrival order is
 * not identity: the second answer would settle the first request.
 *
 * WHAT ENDS IT. The lease connection ending, and nothing else silently. When it
 * ends, the pending channel is revoked so no request is left waiting on an
 * answer that can no longer come from the principal it was asked of.
 */

import type { Socket } from 'node:net';

import {
  buildMacosVirtualDisplayAuthority,
  serializeMacosVirtualDisplayAuthority,
  MACOS_VIRTUAL_DISPLAY_AUTHORITY_MAX_LIFETIME_MS,
  type MacosVirtualDisplayAuthorityArtifact,
} from '../../shared/macos-virtual-display-authority.js';
import {
  startMacosVirtualDisplayAuthorityListener,
  type MacosVirtualDisplayAuthorityLease,
  type MacosVirtualDisplayAuthorityListener,
  type MacosVirtualDisplayAuthorityListenerSeams,
} from './macos-virtual-display-authority-listener.js';
import {
  MACOS_VIRTUAL_DISPLAY_PROXY_MAX_LINE_BYTES,
  MACOS_VIRTUAL_DISPLAY_PROXY_OP,
  proxyVirtualDisplayRequest,
  type MacosVirtualDisplayProxyLease,
  type MacosVirtualDisplayProxySeams,
} from './macos-virtual-display-proxy.js';

/** Bounded wait for the agent to acknowledge the grant. */
export const MACOS_VIRTUAL_DISPLAY_GRANT_ACK_TIMEOUT_MS = 5_000 as const;

/**
 * The ONE frame that acknowledges a grant.
 *
 * Byte-for-byte, because there is exactly one legal success frame:
 * `SerializeVirtualDisplayControlReply({ok:true})` emits this and nothing else
 * (verified against the native serializer). The previous version parsed
 * arbitrary `k=v` tokens and trimmed, so `ctl1r ok=1 unexpected=1` and
 * whitespace variants were accepted -- an agent describing something we did not
 * understand had its grant published as authority anyway.
 */
export const MACOS_VIRTUAL_DISPLAY_GRANT_ACK_FRAME =
  'ctl1r ok=1 admitted=0 presence=absent' as const;

/**
 * Whether the agent's first frame is THE acknowledgement.
 *
 * An exact identity test, not a parse. Nothing here can be lenient about
 * ordering, whitespace, duplicates, unknown keys or extra fields, because it
 * never decomposes the frame in the first place. A timeout (null), a refusal,
 * another grammar or any variant is not an acceptance -- the next thing this
 * daemon would do is answer display requests against a helper nobody confirmed.
 */
export function grantAckAccepted(line: string | null): boolean {
  return line === MACOS_VIRTUAL_DISPLAY_GRANT_ACK_FRAME;
}

export const MACOS_VIRTUAL_DISPLAY_AUTHORITY_HOST_ERROR = Object.freeze({
  NO_LEASE: 'macos_virtual_display_no_lease',
  BUSY: 'macos_virtual_display_exchange_busy',
  GRANT_REFUSED: 'macos_virtual_display_grant_refused',
} as const);

export interface MacosVirtualDisplayAuthorityHostOptions {
  /** The exact verified artifact this daemon launched the worker from. */
  readonly artifact: MacosVirtualDisplayAuthorityArtifact;
  readonly socketPath?: string;
  readonly mintChallenge: () => string;
  readonly nextServiceGeneration: () => number;
  readonly verification: MacosVirtualDisplayAuthorityListenerSeams['verification'];
  /** Called whenever authority ends, so the IPC channel can be revoked. */
  readonly onAuthorityLost: () => void;
  readonly onBackgroundError?: (error: Error) => void;
}

/**
 * Asks the live agent whether this host can create a virtual display.
 *
 * ZERO MUTATION, and on the SAME lease. There is deliberately no second
 * authority channel for this: a short-lived probe process with its own channel
 * would be a second way to obtain display authority, and the weaker of two
 * channels is the one that gets used.
 *
 * The answer is `qualifiedToCreate` alone. `displayControlAdmitted` describes a
 * display that already exists, so requiring it here would mean a headless host
 * could never advertise the capability that lets it make its first one.
 */
export async function probeVirtualDisplayCreateReadiness(
  host: Pick<MacosVirtualDisplayAuthorityHost, 'lease' | 'seams'>,
  nonce: number,
): Promise<boolean> {
  const lease = host.lease();
  if (lease === null) return false;
  const reply = await proxyVirtualDisplayRequest(
    lease,
    { op: MACOS_VIRTUAL_DISPLAY_PROXY_OP.READINESS, nonce },
    lease.serviceGeneration,
    host.seams,
  ).catch(() => null);
  // Unreachable, refused, or an answer to another question: all false. This is
  // the answer a capability is advertised on.
  return reply !== null && reply.ok === true && reply.qualifiedToCreate === true;
}

export interface MacosVirtualDisplayAuthorityHost {
  /** Null until an agent has authenticated and been granted. */
  readonly lease: () => MacosVirtualDisplayProxyLease | null;
  readonly seams: MacosVirtualDisplayProxySeams;
  readonly close: () => Promise<void>;
}

interface LiveLease {
  readonly lease: MacosVirtualDisplayAuthorityLease;
  readonly socket: Socket;
  /** Only true once the agent has ACKed the grant. */
  granted: boolean;
  buffer: string;
  waiter: ((line: string | null) => void) | null;
  /** Set while the grant ACK is outstanding; consumes exactly one frame. */
  grantAck: ((line: string | null) => void) | null;
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export async function startMacosVirtualDisplayAuthorityHost(
  options: MacosVirtualDisplayAuthorityHostOptions,
): Promise<MacosVirtualDisplayAuthorityHost> {
  let live: LiveLease | null = null;
  let listener: MacosVirtualDisplayAuthorityListener | null = null;
  // One request at a time, enforced by a promise chain rather than a flag: a
  // flag races when two callers check it in the same tick.
  let tail: Promise<unknown> = Promise.resolve();

  const endLease = (reason: string): void => {
    const ending = live;
    live = null;
    for (const settle of [ending?.grantAck, ending?.waiter]) {
      if (!settle) continue;
      if (ending) { ending.grantAck = null; ending.waiter = null; }
      settle(null);
    }
    if (ending) {
      // Authority is over. Revoked BEFORE anything else can observe the gap,
      // so no request is answered from a principal that is already gone.
      try { options.onAuthorityLost(); } catch (error) {
        options.onBackgroundError?.(errorOf(error));
      }
      if (reason !== 'closed') ending.socket.destroy();
    }
  };

  const attach = (entry: LiveLease): void => {
    entry.socket.setEncoding('utf8');
    entry.socket.on('data', (chunk: string) => {
      entry.buffer += chunk;
      if (entry.buffer.length > MACOS_VIRTUAL_DISPLAY_PROXY_MAX_LINE_BYTES * 4) {
        // Refused rather than resynchronized: a reader that skips ahead can be
        // steered past a frame boundary.
        endLease('overflow');
        return;
      }
      for (;;) {
        const newline = entry.buffer.indexOf('\n');
        if (newline < 0) break;
        const line = entry.buffer.slice(0, newline);
        entry.buffer = entry.buffer.slice(newline + 1);
        // The grant ACK is the FIRST frame the agent sends and it has no
        // request behind it, so it is routed before the ordinary waiter.
        // Without this it fell through to "unsolicited" and destroyed the
        // lease immediately after granting -- authority died the moment it was
        // established, and every later request answered agent_unavailable.
        const ack = entry.grantAck;
        if (ack) {
          entry.grantAck = null;
          ack(line);
          continue;
        }
        const waiter = entry.waiter;
        if (!waiter) {
          // An answer nobody asked for. The stream's correlation has slipped
          // and cannot be recovered by guessing which request it belonged to.
          endLease('unsolicited');
          return;
        }
        entry.waiter = null;
        waiter(line);
      }
    });
  };

  listener = await startMacosVirtualDisplayAuthorityListener(
    {
      socketPath: options.socketPath,
      onLease: (lease) => {
        // A second agent does not replace the first: the incumbent is the one
        // holding the supervised helper.
        if (live !== null) { lease.socket.destroy(); return; }
        const entry: LiveLease = {
          lease, socket: lease.socket, granted: false, buffer: '', waiter: null,
          grantAck: null,
        };
        live = entry;
        attach(entry);
        void (async () => {
          try {
            // Built from the SAME verified artifact, and only after the agent
            // authenticated. A grant minted earlier would exist before there
            // was anyone entitled to receive it.
            //
            // THE CHALLENGE IS THE LEASE'S. The listener already minted one and
            // sent it on the `chal1` line the agent answered; minting a second
            // here produced a grant carrying a secret the agent had never seen,
            // and left two live challenges for one authentication.
            const authority = buildMacosVirtualDisplayAuthority(options.artifact, {
              uid: lease.uid,
              auditSessionId: lease.auditSessionId,
              sessionType: 'Aqua',
              serviceGeneration: lease.serviceGeneration,
              challenge: lease.challenge,
              lifetimeMs: MACOS_VIRTUAL_DISPLAY_AUTHORITY_MAX_LIFETIME_MS,
            });
            const wire = serializeMacosVirtualDisplayAuthority(authority);
            if (wire === null) throw new Error(
              MACOS_VIRTUAL_DISPLAY_AUTHORITY_HOST_ERROR.GRANT_REFUSED);

            // Bounded, strict handshake. The lease is NOT exposed until the
            // agent has said it accepted: an unacknowledged grant means the
            // agent may hold no helper at all, and answering display requests
            // against it would be advertising authority nobody confirmed.
            const acked = await new Promise<string | null>((resolveAck) => {
              let settled = false;
              const settle = (value: string | null) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (entry.grantAck === settle) entry.grantAck = null;
                resolveAck(value);
              };
              const timer = setTimeout(
                () => settle(null), MACOS_VIRTUAL_DISPLAY_GRANT_ACK_TIMEOUT_MS,
              );
              timer.unref?.();
              entry.grantAck = settle;
              entry.socket.write(`${wire}\n`);
            });
            if (live !== entry) return;                 // ended while waiting
            if (!grantAckAccepted(acked)) {
              options.onBackgroundError?.(new Error(
                MACOS_VIRTUAL_DISPLAY_AUTHORITY_HOST_ERROR.GRANT_REFUSED));
              endLease('grant_not_acked');
              return;
            }
            entry.granted = true;
          } catch (error) {
            options.onBackgroundError?.(errorOf(error));
            endLease('grant_failed');
          }
        })();
      },
      onLeaseEnded: () => endLease('ended'),
    },
    {
      verification: options.verification,
      nextServiceGeneration: options.nextServiceGeneration,
      mintChallenge: options.mintChallenge,
    },
  );

  const seams: MacosVirtualDisplayProxySeams = Object.freeze({
    exchange: async (
      lease: MacosVirtualDisplayProxyLease, line: string, timeoutMs: number,
    ): Promise<string | null> => {
      const run = async (): Promise<string | null> => {
        const entry = live;
        // Identity, not equality: the caller must be asking on the lease that
        // is live right now, not one that merely looks like it.
        if (!entry || !entry.granted || entry.socket !== lease.socket) return null;
        if (entry.waiter) return null;
        return await new Promise<string | null>((resolve) => {
          let settled = false;
          const settle = (value: string | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (entry.waiter === settle) entry.waiter = null;
            resolve(value);
          };
          const timer = setTimeout(() => {
            // A timed-out request is not revived. Its answer, if it ever
            // arrives, is unsolicited and ends the lease.
            settle(null);
          }, timeoutMs);
          timer.unref?.();
          entry.waiter = settle;
          try {
            entry.socket.write(`${line}\n`);
          } catch {
            settle(null);
          }
        });
      };
      const attempt = tail.then(run, run);
      tail = attempt.catch(() => undefined);
      return await attempt;
    },
  });

  return Object.freeze({
    lease: (): MacosVirtualDisplayProxyLease | null => {
      const entry = live;
      if (!entry || !entry.granted) return null;
      return {
        socket: entry.socket,
        serviceGeneration: entry.lease.serviceGeneration,
        auditSessionId: entry.lease.auditSessionId,
      };
    },
    seams,
    close: async (): Promise<void> => {
      endLease('closed');
      await listener?.close();
      listener = null;
    },
  });
}
