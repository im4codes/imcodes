import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REMOTE_DESKTOP_ACCESS_MODE } from '../../shared/remote-desktop.js';
import {
  REMOTE_DESKTOP_ACTOR_SOURCE,
  REMOTE_DESKTOP_BOOTSTRAP_PROOF,
  REMOTE_DESKTOP_BROWSER_CLAIM,
  REMOTE_DESKTOP_CONSENT_MSG,
  REMOTE_DESKTOP_LINK_KIND,
  REMOTE_DESKTOP_LINK_TOKEN,
  REMOTE_DESKTOP_PRESENTATION_SOURCE,
  REMOTE_DESKTOP_PRIVACY_MSG,
  REMOTE_DESKTOP_REDACTED_AUDIT_FIELDS,
  containsRemoteDesktopPreProofDisclosure,
  containsRemoteDesktopSecretField,
  isRemoteDesktopPreProofResponseSafe,
  redactRemoteDesktopAuditRecord,
  validateRemoteDesktopBootstrapProof,
  validateRemoteDesktopBootstrapRedemption,
  validateRemoteDesktopClaimProof,
  validateRemoteDesktopConsentMessage,
  validateRemoteDesktopLinkCreateRequest,
  validateRemoteDesktopPrivacyMessage,
  validateRemoteDesktopShellLaunchContext,
} from '../../shared/remote-desktop-access.js';
import {
  REMOTE_DESKTOP_MSG,
  validateRemoteDesktopDaemonCommand,
} from '../../shared/remote-desktop.js';
import {
  WORKER_CONSENT_FRAME,
  WORKER_CONSENT_OUTCOME,
  parseWorkerConsentFrame,
} from '../../src/node/remote-desktop-consent-ipc.js';
import {
  WORKER_PRIVACY_FRAME,
  parseWorkerPrivacyFrame,
} from '../../src/node/remote-desktop-privacy-ipc.js';

const ROOT = process.cwd();
const HOST_ID = 'host-00000000000000000001';
const SERVER_ID = 'srv-000000000000000000001';
const ROUTE_ID = 'route-000000000000000001';
const EPOCH_ID = 'epoch-0000000000000000001';
const REQUEST_ID = 'request-00000000000000001';
const SESSION_ID = 'session-00000000000000001';
const CAPABILITY = 'H'.repeat(43);
const TOKEN = 'A'.repeat(REMOTE_DESKTOP_LINK_TOKEN.ENCODED_LENGTH);
const TOKEN_HASH = 'a'.repeat(REMOTE_DESKTOP_LINK_TOKEN.HASH_LENGTH);
const CHALLENGE_ID = 'B'.repeat(REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_ID_ENCODED_LENGTH);
const CHALLENGE = 'C'.repeat(REMOTE_DESKTOP_BROWSER_CLAIM.CHALLENGE_ENCODED_LENGTH);
const SPKI = 'D'.repeat(REMOTE_DESKTOP_BROWSER_CLAIM.PUBLIC_KEY_SPKI_ENCODED_LENGTH);
const THUMBPRINT = 'E'.repeat(REMOTE_DESKTOP_BROWSER_CLAIM.THUMBPRINT_ENCODED_LENGTH);
const SIGNATURE = 'F'.repeat(REMOTE_DESKTOP_BROWSER_CLAIM.SIGNATURE_ENCODED_LENGTH);
const TICKET = 'G'.repeat(REMOTE_DESKTOP_BOOTSTRAP_PROOF.TICKET_ENCODED_LENGTH);
const RAW_PASSWORD = 'correct horse battery staple';
const BROWSER_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----browser-only-----END PRIVATE KEY-----';

const FORBIDDEN_EXACT_FIELD_NAMES = [
  'token',
  'rawToken',
  'linkToken',
  'password',
  'passwordAttempt',
  'browserPrivateKey',
  'privateKey',
  'bootstrapProof',
  'bootstrapTicket',
  'ticket',
  'launchSecret',
] as const;

type JsonRecord = Record<string, unknown>;

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

function walk(dir: string, predicate: (path: string) => boolean): string[] {
  const abs = resolve(ROOT, dir);
  const out: string[] = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const full = join(abs, entry.name);
    const rel = relative(ROOT, full);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...walk(rel, predicate));
    } else if (predicate(rel)) {
      out.push(rel);
    }
  }
  return out.sort();
}

function collectRemoteDesktopSchemaColumns(sql: string): string[] {
  const columns: string[] = [];
  const lines = sql.split(/\r?\n/);
  let inRemoteDesktopTable = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/--.*$/, '').trim();
    if (/^CREATE TABLE IF NOT EXISTS remote_desktop_[\w]+ \($/i.test(line)) {
      inRemoteDesktopTable = true;
      continue;
    }
    if (inRemoteDesktopTable && line.startsWith(');')) {
      inRemoteDesktopTable = false;
      continue;
    }
    if (inRemoteDesktopTable) {
      const match = /^([a-z][a-z0-9_]*)\s+/i.exec(line);
      if (match && !['CONSTRAINT', 'CHECK', 'UNIQUE', 'PRIMARY', 'FOREIGN'].includes(match[1]!.toUpperCase())) {
        columns.push(match[1]!);
      }
    }
    const alter = /^ADD COLUMN IF NOT EXISTS ([a-z][a-z0-9_]*)\s+/i.exec(line);
    if (alter) columns.push(alter[1]!);
  }
  return columns;
}

function schemaLeaks(sql: string): string[] {
  const forbiddenColumns = new Set([
    'token',
    'raw_token',
    'link_token',
    'password',
    'password_attempt',
    'browser_private_key',
    'private_key',
    'bootstrap_proof',
    'bootstrap_ticket',
    'ticket',
    'launch_secret',
    'authorization_code',
    'grant_token',
    'server_secret',
  ]);
  return collectRemoteDesktopSchemaColumns(sql).filter((column) => forbiddenColumns.has(column));
}

function collectExactSensitiveValueLeaks(
  value: unknown,
  exactValues: readonly string[],
  path: readonly string[] = [],
): string[] {
  if (typeof value === 'string') {
    return exactValues.includes(value) ? [path.join('.') || '<root>'] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectExactSensitiveValueLeaks(entry, exactValues, [...path, String(index)]));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as JsonRecord)
      .flatMap(([key, child]) => collectExactSensitiveValueLeaks(child, exactValues, [...path, key]));
  }
  return [];
}

function assertNoExactSensitiveValues(value: unknown, exactValues: readonly string[]): void {
  expect(collectExactSensitiveValueLeaks(value, exactValues)).toEqual([]);
}

function leakFields(value: unknown, path: readonly string[] = []): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => leakFields(entry, [...path, String(index)]));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as JsonRecord).flatMap(([key, child]) => {
    const current = [...path, key];
    const own = FORBIDDEN_EXACT_FIELD_NAMES.includes(key as typeof FORBIDDEN_EXACT_FIELD_NAMES[number])
      ? [current.join('.')]
      : [];
    return [...own, ...leakFields(child, current)];
  });
}

describe('remote desktop raw-secret persistence and telemetry gate', () => {
  it('keeps raw invite, password, browser-private-key and bootstrap-proof fields out of remote desktop schemas', () => {
    const migrationFiles = walk('server/src/db/migrations', (path) => /remote_desktop.*\.sql$/.test(path));
    expect(migrationFiles).not.toEqual([]);

    const leaks = migrationFiles.flatMap((file) => (
      schemaLeaks(read(file)).map((column) => `${file}:${column}`)
    ));
    expect(leaks).toEqual([]);
  });

  it('positive control: the schema gate fails for representative raw credential columns', () => {
    expect(schemaLeaks(`
      CREATE TABLE IF NOT EXISTS remote_desktop_bad (
        id TEXT PRIMARY KEY,
        raw_token TEXT NOT NULL,
        browser_private_key TEXT NOT NULL
      );
    `)).toEqual(['raw_token', 'browser_private_key']);
  });

  it('redacts exact secret field names recursively before audit/log metadata can persist them', () => {
    const auditRecord = {
      actorAuditId: 'audit-000000000000000001',
      event: 'remote_desktop.guest.link_claimed',
      nested: {
        token: TOKEN,
        passwordAttempt: RAW_PASSWORD,
        browserPrivateKey: BROWSER_PRIVATE_KEY,
        allowed: { serverId: SERVER_ID },
      },
    };

    expect(REMOTE_DESKTOP_REDACTED_AUDIT_FIELDS).toEqual(expect.arrayContaining([
      'token',
      'rawToken',
      'linkToken',
      'password',
      'passwordAttempt',
      'browserPrivateKey',
      'launchSecret',
    ]));
    const redacted = redactRemoteDesktopAuditRecord(auditRecord);
    expect(redacted).toEqual({
      actorAuditId: 'audit-000000000000000001',
      event: 'remote_desktop.guest.link_claimed',
      nested: {
        allowed: { serverId: SERVER_ID },
      },
    });
    assertNoExactSensitiveValues(redacted, [TOKEN, RAW_PASSWORD, BROWSER_PRIVATE_KEY]);
  });

  it('positive control: the recursive exact-value gate detects a representative telemetry leak', () => {
    expect(collectExactSensitiveValueLeaks(
      { telemetry: { message: 'ok', rawToken: TOKEN } },
      [TOKEN],
    )).toEqual(['telemetry.rawToken']);
  });
});

describe('remote desktop pre-proof and post-proof routing boundary', () => {
  it('allows only generic unavailable or content-free challenge bodies before proof', () => {
    expect(isRemoteDesktopPreProofResponseSafe({ status: 'unavailable' })).toBe(true);
    expect(isRemoteDesktopPreProofResponseSafe({
      keyAlgorithm: REMOTE_DESKTOP_BROWSER_CLAIM.KEY_ALGORITHM,
      challengeId: CHALLENGE_ID,
      challenge: CHALLENGE,
      expiresAt: 10_000,
    })).toBe(true);
  });

  it.each([
    ['serverId', { status: 'unavailable', serverId: SERVER_ID }],
    ['nested hostId', { status: 'unavailable', debug: { hostId: HOST_ID } }],
    ['internal routeId attached to an error', { error: 'unavailable', details: { routeId: ROUTE_ID } }],
  ] as const)('rejects a pre-proof %s disclosure', (_label, body) => {
    if ('status' in body || 'debug' in body) {
      expect(containsRemoteDesktopPreProofDisclosure(body)).toBe(true);
    }
    expect(isRemoteDesktopPreProofResponseSafe(body)).toBe(false);
  });

  it('permits serverId only in the post-proof bootstrap redemption shape', () => {
    expect(validateRemoteDesktopBootstrapRedemption({
      ticketId: 'ticket-000000000000000001',
      hostId: HOST_ID,
      serverId: SERVER_ID,
      source: REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      credentialGeneration: 3,
      browserPublicKeySpki: SPKI,
      browserKeyThumbprint: THUMBPRINT,
      expiresAt: 30_000,
    }).ok).toBe(true);

    expect(validateRemoteDesktopBootstrapRedemption({
      ticketId: 'ticket-000000000000000001',
      hostId: HOST_ID,
      serverId: SERVER_ID,
      source: REMOTE_DESKTOP_ACTOR_SOURCE.UNATTENDED_LINK,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      credentialGeneration: 3,
      browserPublicKeySpki: SPKI,
      browserKeyThumbprint: THUMBPRINT,
      expiresAt: 30_000,
      ticket: TICKET,
    }).ok).toBe(false);
  });
});

describe('remote desktop browser URL/history/storage/DOM gate', () => {
  it('scrubs invite fragments before the main app and has no storage/DOM/analytics sink for the raw token', () => {
    const index = read('web/index.html');
    const entry = read('web/src/remote-desktop-invite-bootstrap-entry.ts');
    const bootstrap = read('web/src/remote-desktop-invite-bootstrap.ts');
    const accessApi = read('web/src/api/remote-desktop-access.ts');
    expect(index.indexOf('/src/remote-desktop-invite-bootstrap-entry.ts')).toBeGreaterThan(0);
    expect(index.indexOf('/src/remote-desktop-invite-bootstrap-entry.ts'))
      .toBeLessThan(index.indexOf('/src/main.tsx'));
    expect(entry).toContain('window.history.replaceState');
    expect(entry).toContain('window.location.pathname');
    expect(entry).toContain('window.location.search');
    expect(entry).toContain('fragment: window.location.hash');
    expect(entry).not.toMatch(/replaceState\([^)]*window\.location\.hash/);

    const forbiddenBrowserSinks = /\b(localStorage|sessionStorage|indexedDB|document\.cookie|navigator\.sendBeacon|console\.|innerHTML|outerHTML)\b/;
    expect(forbiddenBrowserSinks.test(entry)).toBe(false);
    expect(forbiddenBrowserSinks.test(bootstrap)).toBe(false);
    expect(forbiddenBrowserSinks.test(accessApi)).toBe(false);
    // Fragment handling is deliberately synchronous and network-free. The
    // bounded anonymous challenge/proof calls live in the access API module,
    // where their fetch policy remains part of this security gate.
    expect(accessApi).toContain("credentials: 'omit'");
    expect(accessApi).toContain("referrerPolicy: 'no-referrer'");
    expect(accessApi).toContain("cache: 'no-store'");
  });

  it('positive control: the browser sink gate fails if a raw invite token is stored or beaconed', () => {
    const leakySource = `
      window.localStorage.setItem('remote-desktop-token', token);
      navigator.sendBeacon('/analytics', JSON.stringify({ token }));
    `;
    expect(/\b(localStorage|sessionStorage|indexedDB|document\.cookie|navigator\.sendBeacon)\b/.test(leakySource))
      .toBe(true);
  });
});

describe('remote desktop protocol, node, consent, privacy and shell message gates', () => {
  it('rejects raw secret fields on shared wire contracts that must never carry them', () => {
    const consent = {
      type: REMOTE_DESKTOP_CONSENT_MSG.REQUEST,
      approvalId: 'approval-0000000000000001',
      hostId: HOST_ID,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      requesterLabel: 'owner@example.test',
      createdAt: 1_000,
      deadlineAt: 31_000,
    };
    expect(validateRemoteDesktopConsentMessage({ ...consent, token: TOKEN }).ok).toBe(false);

    const privacyBegin = {
      type: REMOTE_DESKTOP_PRIVACY_MSG.BEGIN,
      hostId: HOST_ID,
      epochId: EPOCH_ID,
      revision: 1,
      presentationSource: REMOTE_DESKTOP_PRESENTATION_SOURCE.SIGNED_SHELL,
      deadlineAt: 60_000,
      routeSnapshot: [],
    };
    expect(validateRemoteDesktopPrivacyMessage({ ...privacyBegin, password: RAW_PASSWORD }).ok).toBe(false);

    expect(validateRemoteDesktopShellLaunchContext({
      hostId: HOST_ID,
      launchId: 'launch-000000000000000001',
      issuedAt: 1_000,
      expiresAt: 30_000,
      endpointGeneration: 2,
      launchSecret: TOKEN,
    }).ok).toBe(false);
  });

  it('keeps raw bearer and private key out of link, claim and bootstrap proof requests', () => {
    expect(validateRemoteDesktopLinkCreateRequest({
      hostId: HOST_ID,
      creationRequestId: TOKEN,
      tokenHashVersion: REMOTE_DESKTOP_LINK_TOKEN.HASH_VERSION,
      tokenHash: TOKEN_HASH,
      kind: REMOTE_DESKTOP_LINK_KIND.ATTENDED,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      label: 'ops',
      rawToken: TOKEN,
    }).ok).toBe(false);

    expect(validateRemoteDesktopClaimProof({
      keyAlgorithm: REMOTE_DESKTOP_BROWSER_CLAIM.KEY_ALGORITHM,
      challengeId: CHALLENGE_ID,
      challenge: CHALLENGE,
      browserPublicKeySpki: SPKI,
      browserKeyThumbprint: THUMBPRINT,
      signature: SIGNATURE,
      browserPrivateKey: BROWSER_PRIVATE_KEY,
    }).ok).toBe(false);

    expect(validateRemoteDesktopBootstrapProof({
      ticket: TICKET,
      browserKeyThumbprint: THUMBPRINT,
      signature: SIGNATURE,
      browserPrivateKey: BROWSER_PRIVATE_KEY,
    }).ok).toBe(false);
  });

  it('rejects PREPARE attempts that smuggle raw secrets onto the signed-worker lifecycle', () => {
    const prepare = {
      type: REMOTE_DESKTOP_MSG.PREPARE,
      requestId: REQUEST_ID,
      sessionId: SESSION_ID,
      capability: CAPABILITY,
      expiresAt: 120_000,
      leaseExpiresAt: 60_000,
      daemonGeneration: 1,
      routeGeneration: 1,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      iceServers: [],
    };
    expect(validateRemoteDesktopDaemonCommand(prepare).ok).toBe(true);
    expect(validateRemoteDesktopDaemonCommand({ ...prepare, password: RAW_PASSWORD }).ok).toBe(false);
    expect(validateRemoteDesktopDaemonCommand({ ...prepare, browserPrivateKey: BROWSER_PRIVATE_KEY }).ok).toBe(false);
  });

  it('worker consent and privacy frames reject smuggled secret authority fields', () => {
    expect(parseWorkerConsentFrame({
      type: WORKER_CONSENT_FRAME.ANSWER,
      approvalId: 'approval-0000000000000001',
      outcome: WORKER_CONSENT_OUTCOME.ALLOWED,
      token: TOKEN,
    })).toBeNull();

    const clean = {
      type: WORKER_PRIVACY_FRAME.SHIELDED,
      epochId: EPOCH_ID,
      revision: 1,
      workerGeneration: 1,
      inputReleased: true,
      routes: [{ routeId: ROUTE_ID, routeGeneration: 1 }],
    } as const;
    const parsed = parseWorkerPrivacyFrame(clean);
    expect(parsed).toEqual({
      type: WORKER_PRIVACY_FRAME.SHIELDED,
      epochId: EPOCH_ID,
      revision: 1,
      workerGeneration: 1,
      inputReleased: true,
      routes: [{ routeId: ROUTE_ID, routeGeneration: 1 }],
    });
    expect(leakFields(parsed)).toEqual([]);
    assertNoExactSensitiveValues(parsed, [RAW_PASSWORD, BROWSER_PRIVATE_KEY]);
    expect(parseWorkerPrivacyFrame({
      ...clean,
      password: RAW_PASSWORD,
      browserPrivateKey: BROWSER_PRIVATE_KEY,
    })).toBeNull();
  });

  it('positive control: the shared secret-field scanner fails on nested worker payload leaks', () => {
    expect(containsRemoteDesktopSecretField({ worker: { payload: { password: RAW_PASSWORD } } })).toBe(true);
    expect(containsRemoteDesktopSecretField({ worker: { payload: { routeId: ROUTE_ID } } })).toBe(false);
  });
});

describe('remote desktop source-level sink inventory', () => {
  it('does not write exact raw-secret fields into remote desktop analytics, logs or error telemetry sinks', () => {
    const files = [
      ...walk('server/src/routes', (path) => /remote-desktop.*\.ts$/.test(path)),
      ...walk('server/src/services', (path) => /remote-desktop.*\.ts$/.test(path)),
      ...walk('src/daemon', (path) => /remote-desktop.*\.ts$/.test(path)),
      ...walk('src/node', (path) => /remote-desktop.*\.ts$/.test(path)),
      ...walk('web/src', (path) => /remote-desktop.*\.(ts|tsx)$/.test(path)),
    ];
    const sinkCall = /\b(logger\.(?:debug|info|warn|error)|logAudit|console\.|navigator\.sendBeacon|analytics|telemetry|captureException)\s*\(/;
    const forbiddenField = /\b(token|rawToken|linkToken|password|passwordAttempt|browserPrivateKey|privateKey|bootstrapProof|bootstrapTicket|launchSecret)\b/;
    const leaks = files.flatMap((file) => {
      const lines = read(file).split(/\r?\n/);
      return lines.flatMap((line, index) => (
        sinkCall.test(line) && forbiddenField.test(line)
          ? [`${file}:${index + 1}:${line.trim()}`]
          : []
      ));
    });
    expect(leaks).toEqual([]);
  });

  it('positive control: the sink inventory flags a representative exact raw-token log', () => {
    const line = "logger.warn({ rawToken: token }, 'remote desktop bootstrap failed')";
    expect(/\b(logger\.(?:debug|info|warn|error)|logAudit|console\.|navigator\.sendBeacon|analytics|telemetry|captureException)\s*\(/.test(line))
      .toBe(true);
    expect(/\b(token|rawToken|linkToken|password|passwordAttempt|browserPrivateKey|privateKey|bootstrapProof|bootstrapTicket|launchSecret)\b/.test(line))
      .toBe(true);
  });
});
