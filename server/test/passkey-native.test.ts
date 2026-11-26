import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  generateRegistrationOptionsMock,
  generateAuthenticationOptionsMock,
} = vi.hoisted(() => ({
  generateRegistrationOptionsMock: vi.fn(async (opts: Record<string, unknown>) => ({
    challenge: 'reg-challenge-1',
    rp: { id: opts.rpID ?? 'localhost', name: 'IM.codes' },
    user: { id: 'dXNlcg', name: 'Mobile User', displayName: 'Mobile User' },
    pubKeyCredParams: [],
  })),
  generateAuthenticationOptionsMock: vi.fn(async (opts: Record<string, unknown>) => ({
    challenge: 'auth-challenge-default',
    rpId: opts.rpID ?? 'localhost',
  })),
}));

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: generateRegistrationOptionsMock,
  generateAuthenticationOptions: generateAuthenticationOptionsMock,
  verifyRegistrationResponse: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));

import { buildApp } from '../src/index.js';
import type { Env } from '../src/env.js';
import type { Database } from '../src/db/client.js';

interface MemChallenge {
  id: string;
  challenge: string;
  user_id: string | null;
  display_name: string;
  expires_at: number;
  created_at: number;
}

function makeNativeTestDb() {
  const settings = new Map<string, string>();
  const passkeyChallenges = new Map<string, MemChallenge>();
  const norm = (sql: string) => sql.toLowerCase().replace(/\s+/g, ' ').trim();

  const db: Database = {
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
      const s = norm(sql);
      if (s.includes('from settings where key = $1')) {
        const val = settings.get(String(params[0]));
        return val !== undefined ? ({ value: val } as T) : null;
      }
      if (s.includes('from passkey_challenges where id = $1')) {
        const row = passkeyChallenges.get(String(params[0]));
        return (row ? { ...row } : null) as T | null;
      }
      return null;
    },
    query: async <T = unknown>() => [] as T[],
    execute: async (sql: string, params: unknown[] = []): Promise<{ changes: number }> => {
      const s = norm(sql);
      if (s.startsWith('insert into passkey_challenges')) {
        passkeyChallenges.set(String(params[0]), {
          id: String(params[0]),
          challenge: String(params[1]),
          user_id: (params[2] as string | null) ?? null,
          display_name: String(params[3]),
          expires_at: Number(params[4]),
          created_at: Number(params[5]),
        });
        return { changes: 1 };
      }
      if (s.startsWith('delete from passkey_challenges where expires_at < $1')) {
        const cutoff = Number(params[0]);
        for (const [k, v] of passkeyChallenges) {
          if (v.expires_at < cutoff) passkeyChallenges.delete(k);
        }
        return { changes: 0 };
      }
      return { changes: 0 };
    },
    exec: async () => undefined,
    close: async () => undefined,
    transaction: async <T>(fn: (tx: Database) => Promise<T>): Promise<T> => fn(db),
  };

  return { db, settings, passkeyChallenges };
}

function makeEnv(db: Database): Env {
  return {
    DB: db,
    JWT_SIGNING_KEY: 'test-signing-key-32chars-padding!!',
    BOT_ENCRYPTION_KEY: 'abcdef0123456789'.repeat(2),
    SERVER_URL: 'https://app.im.codes',
    ALLOWED_ORIGINS: 'https://app.im.codes',
    TRUSTED_PROXIES: '',
    BIND_HOST: '127.0.0.1',
    PORT: '3000',
    NODE_ENV: 'production',
  } as Env;
}

interface MockElement {
  id: string;
  textContent: string;
  disabled: boolean;
  dataset: Record<string, string>;
  style: Record<string, string>;
  method: string;
  action: string;
  name: string;
  value: string;
  children: MockElement[];
  listeners: Record<string, Array<() => void>>;
  addEventListener: (event: string, fn: () => void) => void;
  appendChild: (el: MockElement) => void;
  submit: () => void;
  click: () => void;
}

function extractInlineScript(html: string, nonce: string): string {
  const open = `<script nonce="${nonce}">`;
  const start = html.indexOf(open);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('</script>', start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start + open.length, end);
}

function runNativePageScript(
  html: string,
  nonce: string,
  opts: {
    language?: string;
    credentialsGet?: (arg: { publicKey: Record<string, unknown> }) => Promise<unknown>;
    credentialsCreate?: (arg: { publicKey: Record<string, unknown> }) => Promise<unknown>;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  },
) {
  const script = extractInlineScript(html, nonce);
  const elements = new Map<string, MockElement>();
  const submittedForms: Array<{ action: string; method: string; json: string }> = [];

  const makeEl = (id: string): MockElement => ({
    id,
    textContent: '',
    disabled: false,
    dataset: {},
    style: {},
    method: '',
    action: '',
    name: '',
    value: '',
    children: [],
    listeners: {},
    addEventListener(event, fn) {
      (this.listeners[event] ??= []).push(fn);
    },
    appendChild(child) {
      this.children.push(child);
    },
    submit() {
      const jsonInput = this.children.find((c) => c.name === 'json');
      submittedForms.push({
        action: this.action,
        method: this.method,
        json: jsonInput?.value ?? '',
      });
    },
    click() {
      if (this.disabled) return;
      for (const fn of this.listeners.click ?? []) fn();
    },
  });

  for (const id of ['sp', 'st', 'gd', 'er', 'rt']) {
    elements.set(id, makeEl(id));
  }
  const body = makeEl('body');

  const context = {
    document: {
      cookie: 'rcc_csrf=csrf-token-1',
      body,
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: (tag: string) => makeEl(tag),
    },
    navigator: {
      language: opts.language ?? 'zh-CN',
      credentials: {
        get: opts.credentialsGet ?? (async () => null),
        create: opts.credentialsCreate ?? (async () => null),
      },
    },
    fetch: opts.fetchImpl ?? (async () => ({ ok: false, status: 500, json: async () => null })),
    atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
    Uint8Array,
    RegExp,
    JSON,
    Object,
    Array,
    String,
    Error,
    Promise,
    Date,
    encodeURIComponent,
    decodeURIComponent,
  };

  vm.runInNewContext(script, context);
  return { elements, submittedForms };
}

async function flushMicrotasks(turns = 10) {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

describe('passkey native iOS ASWebAuthenticationSession flow', () => {
  beforeEach(() => {
    let seq = 0;
    generateAuthenticationOptionsMock.mockReset().mockImplementation(async (opts: Record<string, unknown>) => {
      seq += 1;
      return {
        challenge: Buffer.from(`auth-ch-${seq}`).toString('base64url'),
        rpId: opts.rpID ?? 'localhost',
      };
    });
    generateRegistrationOptionsMock.mockReset().mockImplementation(async (opts: Record<string, unknown>) => ({
      challenge: Buffer.from('reg-ch-1').toString('base64url'),
      rp: { id: opts.rpID ?? 'localhost', name: 'IM.codes' },
      user: { id: Buffer.from('user-1').toString('base64url'), name: 'Mobile User', displayName: 'Mobile User' },
      pubKeyCredParams: [],
    }));
  });

  it('pre-generates login options & persists single-use challenge on GET /native (while keeping register unseeded)', async () => {
    const store = makeNativeTestDb();
    const app = buildApp(makeEnv(store.db));

    const loginRes = await app.request('/api/auth/passkey/native?callback=imcodes%3A%2F%2Fauth', {
      headers: { host: 'hk.im.codes' },
    });
    expect(loginRes.status).toBe(200);
    expect(loginRes.headers.get('cache-control')).toBe('no-store');
    expect(store.passkeyChallenges.size).toBe(1);
    const saved = [...store.passkeyChallenges.values()][0]!;
    expect(saved.user_id).toBeNull();
    const loginHtml = await loginRes.text();
    expect(loginHtml).toContain(`"challengeId":"${saved.id}"`);
    expect(loginHtml).toContain(`"challenge":"${saved.challenge}"`);

    const regRes = await app.request('/api/auth/passkey/native?callback=imcodes%3A%2F%2Fauth&action=register');
    expect(regRes.status).toBe(200);
    expect(store.passkeyChallenges.size).toBe(1); // register GET does not pre-mint a challenge
    const regHtml = await regRes.text();
    expect(regHtml).toContain('var INITIAL_OPTS=null;');
  });

  it('invokes navigator.credentials.get synchronously inside user tap with ZERO preceding fetch after auto-start NotAllowedError', async () => {
    const store = makeNativeTestDb();
    const app = buildApp(makeEnv(store.db));
    const res = await app.request('/api/auth/passkey/native?callback=imcodes%3A%2F%2Fauth');
    const html = await res.text();
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = csp.match(/script-src 'nonce-([a-f0-9]+)'/)![1]!;
    const initialChallengeId = [...store.passkeyChallenges.keys()][0]!;

    const events: string[] = [];
    const fetchSpy = vi.fn(async () => {
      events.push('fetch');
      return { ok: true, status: 200, json: async () => ({}) };
    });

    let getCount = 0;
    const credentialsGet = vi.fn((arg: { publicKey: Record<string, unknown> }) => {
      getCount += 1;
      events.push(`get:${getCount}`);
      expect(arg.publicKey.challenge).toBeInstanceOf(ArrayBuffer);
      if (getCount === 1) {
        const err = new Error('The operation is not allowed at this time because the page does not have focus or user activation.');
        err.name = 'NotAllowedError';
        return Promise.reject(err);
      }
      return Promise.resolve({
        id: 'cred-1',
        rawId: new Uint8Array([1, 2, 3]).buffer,
        type: 'public-key',
        response: {
          authenticatorData: new Uint8Array([4]).buffer,
          clientDataJSON: new Uint8Array([5]).buffer,
          signature: new Uint8Array([6]).buffer,
          userHandle: new Uint8Array([7]).buffer,
        },
        getClientExtensionResults: () => ({}),
      });
    });

    const { elements, submittedForms } = runNativePageScript(html, nonce, {
      language: 'zh-CN',
      credentialsGet,
      fetchImpl: fetchSpy,
    });
    await flushMicrotasks();

    // Auto-start blocked by iOS WebKit -> clean tap prompt, NEVER "Cancelled", zero network calls
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(elements.get('st')!.textContent).toBe('请轻触下方按钮以调起系统通行密钥弹窗');
    expect(elements.get('rt')!.style.display).toBe('inline-block');
    expect(elements.get('rt')!.textContent).toBe('使用通行密钥登录');
    expect(elements.get('gd')!.style.display).toBe('none');

    // User taps CTA button -> navigator.credentials.get MUST fire synchronously in the click call stack before any await/fetch
    elements.get('rt')!.click();
    expect(events).toEqual(['get:1', 'get:2']);
    expect(fetchSpy).not.toHaveBeenCalled();

    await flushMicrotasks();
    expect(submittedForms).toHaveLength(1);
    expect(submittedForms[0]!.action).toContain('/api/auth/passkey/login/complete?native=1');
    expect(JSON.parse(submittedForms[0]!.json)).toMatchObject({ challengeId: initialChallengeId });
  });

  it('shows localized iCloud Keychain guidance on user-tap NotAllowedError and fetches a fresh challenge for Retry', async () => {
    const store = makeNativeTestDb();
    const app = buildApp(makeEnv(store.db));
    const res = await app.request('/api/auth/passkey/native?callback=imcodes%3A%2F%2Fauth');
    const html = await res.text();
    const nonce = (res.headers.get('content-security-policy') ?? '').match(/script-src 'nonce-([a-f0-9]+)'/)![1]!;
    const initialChallengeId = [...store.passkeyChallenges.keys()][0]!;

    const fetchSpy = vi.fn(async (url: string) => {
      expect(url).toBe('/api/auth/passkey/login/begin');
      const beginRes = await app.request('/api/auth/passkey/login/begin', { method: 'POST' });
      const data = await beginRes.json();
      return { ok: true, status: 200, json: async () => data };
    });

    let call = 0;
    const credentialsGet = vi.fn(() => {
      call += 1;
      if (call <= 2) {
        const err = new Error('NotAllowedError');
        err.name = 'NotAllowedError';
        return Promise.reject(err);
      }
      return Promise.resolve({
        id: 'cred-2',
        rawId: new Uint8Array([9]).buffer,
        type: 'public-key',
        response: {
          authenticatorData: new Uint8Array([10]).buffer,
          clientDataJSON: new Uint8Array([11]).buffer,
          signature: new Uint8Array([12]).buffer,
          userHandle: null,
        },
        getClientExtensionResults: () => ({}),
      });
    });

    const { elements, submittedForms } = runNativePageScript(html, nonce, {
      language: 'zh-CN',
      credentialsGet,
      fetchImpl: fetchSpy,
    });
    await flushMicrotasks();

    // First tap fails with NotAllowedError (e.g. China Apple ID iCloud Keychain disabled)
    elements.get('rt')!.click();
    await vi.waitFor(() => {
      expect(elements.get('st')!.textContent).toBe('未能打开通行密钥弹窗');
      expect(elements.get('rt')!.disabled).toBe(false);
    });

    expect(elements.get('gd')!.style.display).toBe('block');
    expect(elements.get('gd')!.textContent).toContain('密码与钥匙串');
    expect(elements.get('gd')!.textContent).toContain('自动填充与密码');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Retry uses the newly prefetched challengeId synchronously (no extra fetch on Retry click)
    const freshChallengeId = [...store.passkeyChallenges.keys()].find((id) => id !== initialChallengeId)!;
    expect(freshChallengeId).toBeTruthy();

    elements.get('rt')!.click();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(submittedForms).toHaveLength(1));
    expect(JSON.parse(submittedForms[0]!.json)).toMatchObject({ challengeId: freshChallengeId });
  });

  it('prefetches register options so action=register tap calls credentials.create synchronously without waiting on fetch', async () => {
    const store = makeNativeTestDb();
    const app = buildApp(makeEnv(store.db));
    const res = await app.request('/api/auth/passkey/native?callback=imcodes%3A%2F%2Fauth&action=register');
    const html = await res.text();
    const nonce = (res.headers.get('content-security-policy') ?? '').match(/script-src 'nonce-([a-f0-9]+)'/)![1]!;

    const fetchSpy = vi.fn(async (url: string) => {
      expect(url).toBe('/api/auth/passkey/register/begin');
      const beginRes = await app.request('/api/auth/passkey/register/begin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"displayName":"Mobile User"}',
      });
      return { ok: beginRes.ok, status: beginRes.status, json: async () => beginRes.json() };
    });

    let createCall = 0;
    const credentialsCreate = vi.fn((arg: { publicKey: Record<string, unknown> }) => {
      createCall += 1;
      expect(arg.publicKey.challenge).toBeInstanceOf(ArrayBuffer);
      if (createCall === 1) {
        const err = new Error('NotAllowedError');
        err.name = 'NotAllowedError';
        return Promise.reject(err);
      }
      return Promise.resolve({
        id: 'new-cred-1',
        rawId: new Uint8Array([1]).buffer,
        type: 'public-key',
        response: {
          attestationObject: new Uint8Array([2]).buffer,
          clientDataJSON: new Uint8Array([3]).buffer,
        },
        getClientExtensionResults: () => ({}),
      });
    });

    const { elements, submittedForms } = runNativePageScript(html, nonce, {
      language: 'en-US',
      credentialsCreate,
      fetchImpl: fetchSpy,
    });
    await vi.waitFor(() => {
      expect(elements.get('st')!.textContent).toBe('Tap below to open the system Passkey prompt');
      expect(elements.get('rt')!.disabled).toBe(false);
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(elements.get('rt')!.textContent).toBe('Create Passkey');

    // User tap reuses the unconsumed prefetched register challenge synchronously (zero fetch before create)
    elements.get('rt')!.click();
    expect(createCall).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(submittedForms).toHaveLength(1));
    expect(submittedForms[0]!.action).toContain('/api/auth/passkey/register/complete?native=1');
  });
});
