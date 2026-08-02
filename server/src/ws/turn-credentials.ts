import { createHash, createHmac } from 'node:crypto';
import {
  DIRECT_FILE_TRANSFER_ICE_SERVERS,
  type DirectFileTransferIceServerConfig,
} from '../../../shared/direct-file-transfer.js';
import {
  TURN_SERVICE_DEFAULTS,
  TURN_SERVICE_ENV,
  isTurnServiceHost,
  isTurnServiceIpv4,
  parseTurnServicePort,
  type TurnServiceConfig,
} from '../../../shared/turn-service.js';

export interface TurnIceServerAuthority {
  iceServers: DirectFileTransferIceServerConfig[];
  /** Absolute coturn REST username expiry, before the safety margin. */
  credentialExpiresAt?: number;
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
    || !relayMinPort
    || !relayMaxPort
    || relayMinPort > relayMaxPort
    || relayMaxPort - relayMinPort > 255
    || (port >= relayMinPort && port <= relayMaxPort)) return undefined;
  return { host, port, externalIp, sharedSecret, credentialTtlSeconds, relayMinPort, relayMaxPort };
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
