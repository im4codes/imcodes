import { createHash, createHmac } from 'node:crypto';
import { REMOTE_DESKTOP_QUALITY_BITRATE_CAP } from '../../../shared/remote-desktop.js';
import {
  DIRECT_FILE_TRANSFER_ICE_SERVERS,
  type DirectFileTransferIceServerConfig,
} from '../../../shared/direct-file-transfer.js';
import {
  TURN_SERVICE_DEFAULTS,
  TURN_SERVICE_ENV,
  isTurnServiceHost,
  isTurnServiceIpv4,
  parseTurnRelayRange,
  parseTurnServicePort,
  type TurnServiceConfig,
} from '../../../shared/turn-service.js';

export interface TurnIceServerAuthority {
  iceServers: DirectFileTransferIceServerConfig[];
  /** Absolute coturn REST username expiry, before the safety margin. */
  credentialExpiresAt?: number;
  /**
   * Ceiling the handed-out relay enforces for this user's tier (bps); absent =
   * unlimited. A hint for remote-desktop workers (start/stay at it) and the
   * browser (badge); the relay itself is what enforces it.
   */
  relayBitrateCapBps?: number;
}

/** Optional relay ceiling; invalid or out-of-range values mean "unlimited". */
function readRelayBitrateCap(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value)
    && value >= REMOTE_DESKTOP_QUALITY_BITRATE_CAP.MIN_BPS
    && value <= REMOTE_DESKTOP_QUALITY_BITRATE_CAP.MAX_BPS
    ? value
    : undefined;
}

function boundedCredentialTtl(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return TURN_SERVICE_DEFAULTS.CREDENTIAL_TTL_SECONDS;
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value)
    && value >= TURN_SERVICE_DEFAULTS.CREDENTIAL_TTL_MIN_SECONDS
    && value <= TURN_SERVICE_DEFAULTS.CREDENTIAL_TTL_MAX_SECONDS
    ? value
    : undefined;
}

export function readTurnServiceConfig(env: NodeJS.ProcessEnv = process.env): TurnServiceConfig | undefined {
  if (env[TURN_SERVICE_ENV.ENABLED] !== 'true') return undefined;
  const host = env[TURN_SERVICE_ENV.HOST]?.trim().toLowerCase();
  const port = parseTurnServicePort(env[TURN_SERVICE_ENV.PORT] ?? String(TURN_SERVICE_DEFAULTS.PORT));
  const externalIp = env[TURN_SERVICE_ENV.EXTERNAL_IP]?.trim();
  const sharedSecret = env[TURN_SERVICE_ENV.SHARED_SECRET];
  const credentialTtlSeconds = boundedCredentialTtl(env[TURN_SERVICE_ENV.CREDENTIAL_TTL_SECONDS]);
  const relayMinPort = parseTurnServicePort(
    env[TURN_SERVICE_ENV.RELAY_MIN_PORT] ?? String(TURN_SERVICE_DEFAULTS.RELAY_MIN_PORT),
  );
  const relayMaxPort = parseTurnServicePort(
    env[TURN_SERVICE_ENV.RELAY_MAX_PORT] ?? String(TURN_SERVICE_DEFAULTS.RELAY_MAX_PORT),
  );
  if (!isTurnServiceHost(host)
    || !port
    || !isTurnServiceIpv4(externalIp)
    || typeof sharedSecret !== 'string'
    || sharedSecret.length < TURN_SERVICE_DEFAULTS.SHARED_SECRET_BYTES * 2
    || !credentialTtlSeconds
    ) return undefined;
  // One shared rule, so the installer and the runtime cannot disagree about
  // what a valid relay range is. They did, and that disagreement served every
  // client a STUN-only ICE list against a perfectly healthy coturn.
  const relayRange = parseTurnRelayRange({ port, relayMinPort, relayMaxPort });
  if ('rejection' in relayRange) return undefined;
  const bitrateCapBps = readRelayBitrateCap(env[TURN_SERVICE_ENV.BITRATE_CAP_BPS]);
  return {
    host,
    port,
    externalIp,
    sharedSecret,
    credentialTtlSeconds,
    relayMinPort: relayRange.relayMinPort,
    relayMaxPort: relayRange.relayMaxPort,
    ...(bitrateCapBps !== undefined ? { bitrateCapBps } : {}),
  };
}

export function createTurnIceServerAuthority(
  userId: string,
  options: { env?: NodeJS.ProcessEnv; nowMs?: number } = {},
): TurnIceServerAuthority {
  const base = [...DIRECT_FILE_TRANSFER_ICE_SERVERS];
  const config = readTurnServiceConfig(options.env);
  if (!config) return { iceServers: base };
  const nowMs = options.nowMs ?? Date.now();
  const expiresAtSeconds = Math.floor(nowMs / 1000) + config.credentialTtlSeconds;
  const subject = createHash('sha256')
    .update(userId, 'utf8')
    .digest('hex')
    .slice(0, TURN_SERVICE_DEFAULTS.SUBJECT_HEX_LENGTH);
  const username = `${expiresAtSeconds}:${subject}`;
  const credential = createHmac('sha1', config.sharedSecret).update(username, 'utf8').digest('base64');
  return {
    credentialExpiresAt: expiresAtSeconds * 1000,
    ...(config.bitrateCapBps !== undefined ? { relayBitrateCapBps: config.bitrateCapBps } : {}),
    iceServers: [
      ...base,
      {
        urls: [`turn:${config.host}:${config.port}?transport=udp`],
        username,
        credential,
      },
      {
        urls: [`turn:${config.host}:${config.port}?transport=tcp`],
        username,
        credential,
      },
    ],
  };
}

export function createTurnIceServers(
  userId: string,
  options: { env?: NodeJS.ProcessEnv; nowMs?: number } = {},
): DirectFileTransferIceServerConfig[] {
  return createTurnIceServerAuthority(userId, options).iceServers;
}
