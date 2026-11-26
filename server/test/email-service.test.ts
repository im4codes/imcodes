import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { loadEnv, type Env, type EnvConfig } from '../src/env.js';
import {
  EmailServiceError,
  getEmailConfigStatus,
  isCnEmailDomain,
  resolveEmailCnDomains,
  sendEmail,
} from '../src/services/email.js';
import { adminRoutes } from '../src/routes/admin.js';
import { signJwt } from '../src/security/crypto.js';

function baseAwsEnv(overrides: Partial<EnvConfig> = {}): Partial<EnvConfig> {
  return {
    AWS_SES_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SES_SECRET_ACCESS_KEY: 'aws-secret-key-do-not-leak',
    AWS_SES_REGION: 'us-east-1',
    AWS_SES_FROM: 'noreply@im.codes',
    ...overrides,
  };
}

function baseAliyunEnv(overrides: Partial<EnvConfig> = {}): Partial<EnvConfig> {
  return {
    ALIYUN_DM_ACCESS_KEY_ID: 'LTAI5tAliyunExampleKey',
    ALIYUN_DM_ACCESS_KEY_SECRET: 'aliyun-secret-key-do-not-leak',
    ALIYUN_DM_REGION: 'ap-southeast-1',
    ALIYUN_DM_FROM: 'mail@notice.im.codes',
    ALIYUN_DM_FROM_ALIAS: 'IM.codes',
    ...overrides,
  };
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

describe('email env and config status', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('loadEnv preserves defaults for regions and treats missing email config as disabled', () => {
    process.env = {
      DATABASE_URL: 'postgresql://localhost/imcodes',
      JWT_SIGNING_KEY: 'test-jwt-key-32-chars-minimum-ok!',
    };
    const env = loadEnv();
    expect(env.AWS_SES_REGION).toBe('us-east-1');
    expect(env.ALIYUN_DM_REGION).toBe('ap-southeast-1');
    expect(getEmailConfigStatus(env)).toEqual({
      configured: false,
      providers: { awsSes: false, aliyunDm: false },
    });
  });

  it('getEmailConfigStatus reports partial configs as false and omits secret fields', () => {
    const partial = getEmailConfigStatus({
      AWS_SES_ACCESS_KEY_ID: 'AKIA...',
      AWS_SES_SECRET_ACCESS_KEY: 'secret',
      // missing AWS_SES_FROM
      ALIYUN_DM_ACCESS_KEY_ID: 'LTAI...',
      ALIYUN_DM_ACCESS_KEY_SECRET: 'secret',
      ALIYUN_DM_FROM: 'mail@im.codes',
    });
    expect(partial).toEqual({
      configured: true,
      providers: { awsSes: false, aliyunDm: true },
    });
    expect(JSON.stringify(partial)).not.toContain('secret');
  });
});

describe('AWS SES v2 sender and SigV4 signing', () => {
  it('signs canonical request accurately including UTF-8 CJK payload bytes and reply-to', async () => {
    const fixedNow = Date.UTC(2026, 10, 27, 1, 2, 3);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ MessageId: 'ses-msg-123' }), { status: 200 }),
    );

    const env = baseAwsEnv({ EMAIL_REPLY_TO: 'support@im.codes' });
    const result = await sendEmail(
      env,
      {
        to: 'user@gmail.com',
        subject: '验证码 Verification: 测试',
        text: '你好，验证码 123456',
        html: '<p>你好，验证码 <strong>123456</strong></p>',
      },
      { fetch: fetchMock, now: () => fixedNow },
    );

    expect(result).toEqual({
      provider: 'aws_ses',
      messageId: 'ses-msg-123',
      fallbackUsed: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://email.us-east-1.amazonaws.com/v2/email/outbound-emails');
    expect(init?.method).toBe('POST');

    const headers = init?.headers as Record<string, string>;
    expect(headers['x-amz-date']).toBe('20261127T010203Z');
    const bodyStr = init?.body as string;
    const expectedPayloadHash = createHash('sha256').update(bodyStr, 'utf8').digest('hex');
    expect(headers['x-amz-content-sha256']).toBe(expectedPayloadHash);

    const parsedBody = JSON.parse(bodyStr);
    expect(parsedBody).toEqual({
      FromEmailAddress: 'noreply@im.codes',
      Destination: { ToAddresses: ['user@gmail.com'] },
      ReplyToAddresses: ['support@im.codes'],
      Content: {
        Simple: {
          Subject: { Data: '验证码 Verification: 测试', Charset: 'UTF-8' },
          Body: {
            Text: { Data: '你好，验证码 123456', Charset: 'UTF-8' },
            Html: { Data: '<p>你好，验证码 <strong>123456</strong></p>', Charset: 'UTF-8' },
          },
        },
      },
    });

    const canonicalHeaders =
      `content-type:application/json\n` +
      `host:email.us-east-1.amazonaws.com\n` +
      `x-amz-content-sha256:${expectedPayloadHash}\n` +
      `x-amz-date:20261127T010203Z\n`;
    const canonicalRequest =
      `POST\n/v2/email/outbound-emails\n\n${canonicalHeaders}\ncontent-type;host;x-amz-content-sha256;x-amz-date\n${expectedPayloadHash}`;
    const scope = '20261127/us-east-1/ses/aws4_request';
    const stringToSign =
      `AWS4-HMAC-SHA256\n20261127T010203Z\n${scope}\n${createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')}`;
    const kDate = createHmac('sha256', `AWS4${env.AWS_SES_SECRET_ACCESS_KEY}`).update('20261127').digest();
    const kRegion = createHmac('sha256', kDate).update('us-east-1').digest();
    const kService = createHmac('sha256', kRegion).update('ses').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const expectedSig = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
    expect(headers.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=${env.AWS_SES_ACCESS_KEY_ID}/${scope}, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=${expectedSig}`,
    );
  });

  it('supports custom AWS_SES_ENDPOINT base path', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ MessageId: 'custom-ses-1' }), { status: 200 }),
    );
    await sendEmail(
      baseAwsEnv({ AWS_SES_ENDPOINT: 'http://127.0.0.1:4566/ses-proxy/' }),
      { to: 'dev@example.com', subject: 'Hello', text: 'World' },
      { fetch: fetchMock, now: () => 1700000000000 },
    );
    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:4566/ses-proxy/v2/email/outbound-emails');
  });
});

describe('Alibaba Cloud DirectMail sender and POP HMAC-SHA1 signing', () => {
  it('signs SingleSendMail RPC payload accurately with RFC3986 encoding and CJK UTF-8 content', async () => {
    const fixedNow = Date.UTC(2026, 10, 27, 4, 5, 6);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ EnvId: 'dm-env-999', RequestId: 'dm-req-1' }), { status: 200 }),
    );

    const env = baseAliyunEnv({ EMAIL_REPLY_TO: 'reply@im.codes' });
    const result = await sendEmail(
      env,
      {
        to: 'tester@qq.com',
        subject: "登录确认!()*' 测试",
        text: '内容 body ~ test',
      },
      { fetch: fetchMock, now: () => fixedNow, nonce: () => 'nonce-fixed-001' },
    );

    expect(result).toEqual({
      provider: 'aliyun_dm',
      messageId: 'dm-env-999',
      fallbackUsed: false,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://dm.ap-southeast-1.aliyuncs.com/');
    expect(init?.method).toBe('POST');

    const bodyStr = init?.body as string;
    const bodyParams = new URLSearchParams(bodyStr);
    expect(bodyParams.get('Action')).toBe('SingleSendMail');
    expect(bodyParams.get('Version')).toBe('2015-11-23');
    expect(bodyParams.get('AccountName')).toBe('mail@notice.im.codes');
    expect(bodyParams.get('FromAlias')).toBe('IM.codes');
    expect(bodyParams.get('AddressType')).toBe('1');
    expect(bodyParams.get('ReplyToAddress')).toBe('true');
    expect(bodyParams.get('ToAddress')).toBe('tester@qq.com');
    expect(bodyParams.get('Subject')).toBe("登录确认!()*' 测试");
    expect(bodyParams.get('TextBody')).toBe('内容 body ~ test');
    expect(bodyParams.get('Timestamp')).toBe('2026-11-27T04:05:06Z');
    expect(bodyParams.get('SignatureNonce')).toBe('nonce-fixed-001');

    // Verify RFC3986 percent encoding of special characters !()*'
    expect(bodyStr).toContain('%21%28%29%2A%27');

    // Recompute exact canonical POP signature
    const rawParams: Record<string, string> = {};
    for (const [k, v] of bodyParams.entries()) {
      if (k !== 'Signature') rawParams[k] = v;
    }
    const canonical = Object.keys(rawParams)
      .sort()
      .map((k) => `${percentEncode(k)}=${percentEncode(rawParams[k]!)}`)
      .join('&');
    const stringToSign = `POST&${percentEncode('/')}&${percentEncode(canonical)}`;
    const expectedSig = createHmac('sha1', `${env.ALIYUN_DM_ACCESS_KEY_SECRET}&`)
      .update(stringToSign, 'utf8')
      .digest('base64');
    expect(bodyParams.get('Signature')).toBe(expectedSig);
  });

  it('maps cn-hangzhou, ap-southeast-1, legacy ap-southeast-2, and custom endpoint override', async () => {
    const cases: Array<{ region?: string; endpoint?: string; expected: string }> = [
      { region: undefined, expected: 'https://dm.ap-southeast-1.aliyuncs.com/' },
      { region: 'ap-southeast-1', expected: 'https://dm.ap-southeast-1.aliyuncs.com/' },
      { region: 'cn-hangzhou', expected: 'https://dm.aliyuncs.com/' },
      { region: 'ap-southeast-2', expected: 'https://dm.ap-southeast-2.aliyuncs.com/' },
      { region: 'ap-southeast-1', endpoint: 'https://dm.custom.local/rpc', expected: 'https://dm.custom.local/rpc' },
    ];

    for (const c of cases) {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        new Response(JSON.stringify({ RequestId: 'req-ok' }), { status: 200 }),
      );
      await sendEmail(
        baseAliyunEnv({ ALIYUN_DM_REGION: c.region, ALIYUN_DM_ENDPOINT: c.endpoint }),
        { to: 'a@qq.com', subject: 'Ping', text: 'Pong' },
        { fetch: fetchMock },
      );
      expect(fetchMock.mock.calls[0]![0]).toBe(c.expected);
    }
  });
});

describe('dual-channel routing, single-provider operation, and cross-channel fallback', () => {
  it('routes China mailbox domains to Aliyun DM and global domains to AWS SES when both are configured', async () => {
    const env: Partial<EnvConfig> = { ...baseAwsEnv(), ...baseAliyunEnv() };

    for (const addr of ['a@qq.com', 'B@FOXMAIL.COM', 'c@163.com', 'd@vip.qq.com', 'e@126.com']) {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        new Response(JSON.stringify({ EnvId: 'dm-1', MessageId: 'ses-1' }), { status: 200 }),
      );
      const res = await sendEmail(env, { to: addr, subject: 'Hi', text: 'Body' }, { fetch: fetchMock });
      expect(res.provider).toBe('aliyun_dm');
      expect(res.fallbackUsed).toBe(false);
    }

    for (const addr of ['a@gmail.com', 'b@outlook.com', 'c@company.org']) {
      const fetchMock = vi.fn<typeof fetch>(async () =>
        new Response(JSON.stringify({ EnvId: 'dm-1', MessageId: 'ses-1' }), { status: 200 }),
      );
      const res = await sendEmail(env, { to: addr, subject: 'Hi', text: 'Body' }, { fetch: fetchMock });
      expect(res.provider).toBe('aws_ses');
      expect(res.fallbackUsed).toBe(false);
    }
  });

  it('supports EMAIL_CN_DOMAINS override', () => {
    const custom = resolveEmailCnDomains({ EMAIL_CN_DOMAINS: 'custom-cn.test, Mail.CN ' });
    expect(isCnEmailDomain('x@mail.cn', custom)).toBe(true);
    expect(isCnEmailDomain('x@qq.com', custom)).toBe(false);
  });

  it('sends all domains via single configured provider without fallback errors', async () => {
    const fetchAws = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ MessageId: 'aws-only' }), { status: 200 }),
    );
    const awsRes = await sendEmail(baseAwsEnv(), { to: 'user@qq.com', subject: 'Hi', text: 'Body' }, { fetch: fetchAws });
    expect(awsRes).toEqual({ provider: 'aws_ses', messageId: 'aws-only', fallbackUsed: false });

    const fetchAliyun = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ EnvId: 'dm-only' }), { status: 200 }),
    );
    const dmRes = await sendEmail(baseAliyunEnv(), { to: 'user@gmail.com', subject: 'Hi', text: 'Body' }, { fetch: fetchAliyun });
    expect(dmRes).toEqual({ provider: 'aliyun_dm', messageId: 'dm-only', fallbackUsed: false });
  });

  it('explicit provider override skips auto-routing and never falls back on failure', async () => {
    const env: Partial<EnvConfig> = { ...baseAwsEnv(), ...baseAliyunEnv() };
    const fetchFail = vi.fn<typeof fetch>(async () => new Response('upstream error', { status: 500 }));
    await expect(
      sendEmail(env, { to: 'user@qq.com', subject: 'Hi', text: 'Body' }, { provider: 'aws_ses', fetch: fetchFail }),
    ).rejects.toMatchObject({ code: 'email_send_failed' });
    expect(fetchFail).toHaveBeenCalledTimes(1);
    expect(fetchFail.mock.calls[0]![0]).toContain('amazonaws.com');

    await expect(
      sendEmail(baseAwsEnv(), { to: 'user@qq.com', subject: 'Hi', text: 'Body' }, { provider: 'aliyun_dm', fetch: fetchFail }),
    ).rejects.toMatchObject({ code: 'email_provider_not_configured' });
  });

  it('falls back once on primary failure and never leaks encoded secrets, auth headers, or upstream body sentinels', async () => {
    const awsSecret = 'aws+secret/key=special!';
    const aliyunSecret = 'aliyun+secret/key=special!';
    const env: Partial<EnvConfig> = {
      ...baseAwsEnv({ AWS_SES_SECRET_ACCESS_KEY: awsSecret }),
      ...baseAliyunEnv({ ALIYUN_DM_ACCESS_KEY_SECRET: aliyunSecret }),
    };
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Primary fails (500 with encoded secret + sentinel), fallback succeeds
    let call = 0;
    const fetchFallbackOk = vi.fn<typeof fetch>(async () => {
      call++;
      if (call === 1) {
        return new Response(
          `SENTINEL_PRIMARY_BODY ${encodeURIComponent(aliyunSecret)} Authorization: Bearer leaked`,
          { status: 500 },
        );
      }
      return new Response(JSON.stringify({ MessageId: 'ses-fallback-ok' }), { status: 200 });
    });

    const okRes = await sendEmail(env, { to: 'user@qq.com', subject: 'Hi', text: 'Body' }, { fetch: fetchFallbackOk });
    expect(okRes).toEqual({ provider: 'aws_ses', messageId: 'ses-fallback-ok', fallbackUsed: true });
    expect(fetchFallbackOk).toHaveBeenCalledTimes(2);
    const loggedText = warnSpy.mock.calls.flat().join(' ');
    expect(loggedText).not.toContain(aliyunSecret);
    expect(loggedText).not.toContain(encodeURIComponent(aliyunSecret));
    expect(loggedText).not.toContain('SENTINEL_PRIMARY_BODY');
    expect(loggedText).not.toContain('Authorization:');

    // Both fail (network throw + 502 with URL-encoded/JSON-escaped secret & sentinel)
    const fetchBothFail = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('aliyuncs.com')) {
        throw new Error(`SENTINEL_NET_ERR ${encodeURIComponent(aliyunSecret)} Signature=abc123`);
      }
      return new Response(
        JSON.stringify({ sentinel: 'SENTINEL_AWS_502', raw: awsSecret, encoded: encodeURIComponent(awsSecret) }),
        { status: 502 },
      );
    });

    let caught: unknown;
    try {
      await sendEmail(env, { to: 'user@qq.com', subject: 'Hi', text: 'Body' }, { fetch: fetchBothFail });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EmailServiceError);
    const err = caught as EmailServiceError & { cause?: unknown };
    expect(err.code).toBe('email_send_failed');
    expect(err.cause).toBeUndefined();
    for (const forbidden of [
      awsSecret,
      encodeURIComponent(awsSecret),
      aliyunSecret,
      encodeURIComponent(aliyunSecret),
      'SENTINEL_NET_ERR',
      'SENTINEL_AWS_502',
      'Signature=abc123',
      'Authorization:',
    ]) {
      expect(err.message).not.toContain(forbidden);
      expect(warnSpy.mock.calls.flat().join(' ')).not.toContain(forbidden);
    }

    warnSpy.mockRestore();
  });

  it('treats body read timeouts and malformed/empty-receipt 2xx responses as send failures and triggers fallback in auto mode', async () => {
    const dualEnv: Partial<EnvConfig> = { ...baseAwsEnv(), ...baseAliyunEnv() };

    // 1. Both providers reject 200 HTML proxy page, {}, whitespace/non-string IDs, and API error Code
    const badAwsBodies = [
      '<html><body>200 OK Proxy Error</body></html>',
      '{}',
      JSON.stringify({ MessageId: '   ' }),
      JSON.stringify({ MessageId: 12345 }),
    ];
    for (const body of badAwsBodies) {
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));
      await expect(
        sendEmail(dualEnv, { to: 'u@gmail.com', subject: 'Hi', text: 'Body' }, { provider: 'aws_ses', fetch: fetchMock }),
      ).rejects.toMatchObject({ code: 'email_send_failed' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }

    const badAliyunBodies = [
      '<html><body>200 OK Proxy Error</body></html>',
      '{}',
      JSON.stringify({ EnvId: '   ', RequestId: null }),
      JSON.stringify({ Code: 'InvalidMailAddress.NotFound', EnvId: 'ignored' }),
    ];
    for (const body of badAliyunBodies) {
      const fetchMock = vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));
      await expect(
        sendEmail(dualEnv, { to: 'u@qq.com', subject: 'Hi', text: 'Body' }, { provider: 'aliyun_dm', fetch: fetchMock }),
      ).rejects.toMatchObject({ code: 'email_send_failed' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }

    // 2. Headers arrive 200 OK, but response.text() hangs past timeoutMs -> fails in explicit mode, falls back in auto mode
    const hangingResponse = (): Response =>
      ({
        ok: true,
        status: 200,
        text: () => new Promise<string>(() => {}),
      }) as unknown as Response;

    const hangExplicitFetch = vi.fn<typeof fetch>(async () => hangingResponse());
    await expect(
      sendEmail(dualEnv, { to: 'u@gmail.com', subject: 'Hi', text: 'Body' }, {
        provider: 'aws_ses',
        timeoutMs: 20,
        fetch: hangExplicitFetch,
      }),
    ).rejects.toMatchObject({ code: 'email_send_failed', category: 'timeout' });
    expect(hangExplicitFetch).toHaveBeenCalledTimes(1);

    let autoCall = 0;
    const hangThenRecoverFetch = vi.fn<typeof fetch>(async () => {
      autoCall++;
      if (autoCall === 1) return hangingResponse();
      return new Response(JSON.stringify({ MessageId: 'ses-after-dm-body-timeout' }), { status: 200 });
    });
    const recovered = await sendEmail(
      dualEnv,
      { to: 'u@qq.com', subject: 'Hi', text: 'Body' },
      { timeoutMs: 20, fetch: hangThenRecoverFetch },
    );
    expect(recovered).toEqual({
      provider: 'aws_ses',
      messageId: 'ses-after-dm-body-timeout',
      fallbackUsed: true,
    });
    expect(hangThenRecoverFetch).toHaveBeenCalledTimes(2);
  });
});

describe('email input validation and header injection protection', () => {
  it('rejects leading/trailing CRLF, NUL, multi-recipient lists, replyTo injection, and empty bodies before calling fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const env = baseAwsEnv({ EMAIL_REPLY_TO: 'safe@im.codes' });

    const badPayloads = [
      { to: 'a@b.com\r\n', subject: 'Hi', text: 'Body' },
      { to: '  \ra@b.com', subject: 'Hi', text: 'Body' },
      { to: 'a@b.com\n  ', subject: 'Hi', text: 'Body' },
      { to: 'a@b.com\0', subject: 'Hi', text: 'Body' },
      { to: 'a@b.com\r\nBcc: evil@x.com', subject: 'Hi', text: 'Body' },
      { to: 'a@b.com,c@d.com', subject: 'Hi', text: 'Body' },
      { to: 'Name <a@b.com>', subject: 'Hi', text: 'Body' },
      { to: 'a@b.com', subject: 'Hello\r\n', text: 'Body' },
      { to: 'a@b.com', subject: '\nHello', text: 'Body' },
      { to: 'a@b.com', subject: 'Hello\nBcc: evil@x.com', text: 'Body' },
      { to: 'a@b.com', subject: 'Hello\0', text: 'Body' },
      { to: 'a@b.com', subject: 'Hi', text: '   ', html: '' },
      { to: 'a@b.com', subject: 'Hi', text: 'Body', replyTo: 'r@b.com\r\n' },
      { to: 'a@b.com', subject: 'Hi', text: 'Body', replyTo: '\r\n' },
      { to: 'a@b.com', subject: 'Hi', text: 'Body', replyTo: '  \0r@b.com  ' },
      { to: 'a@b.com', subject: 'Hi', text: 'Body', replyTo: 'r@b.com\r\nX: y' },
    ];

    for (const msg of badPayloads) {
      await expect(sendEmail(env, msg, { fetch: fetchMock })).rejects.toMatchObject({
        code: 'email_invalid_input',
      });
    }
    await expect(
      sendEmail(
        baseAwsEnv({ EMAIL_REPLY_TO: 'reply@im.codes\r\n' }),
        { to: 'a@b.com', subject: 'Hi', text: 'Body' },
        { fetch: fetchMock },
      ),
    ).rejects.toMatchObject({ code: 'email_invalid_input' });
    expect(fetchMock).not.toHaveBeenCalled();

    // Ordinary surrounding spaces remain supported cleanly
    const okFetch = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ MessageId: 'space-trim-ok' }), { status: 200 }),
    );
    const trimmedRes = await sendEmail(
      env,
      { to: '  a@gmail.com  ', subject: '  Hello  ', text: 'Body', replyTo: '  r@im.codes  ' },
      { fetch: okFetch },
    );
    expect(trimmedRes).toEqual({ provider: 'aws_ses', messageId: 'space-trim-ok', fallbackUsed: false });

    await expect(sendEmail({}, { to: 'a@b.com', subject: 'Hi', text: 'Body' }, { fetch: fetchMock })).rejects.toMatchObject({
      code: 'email_not_configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('admin email endpoints', () => {
  const JWT_KEY = 'admin-email-route-test-jwt-signing-key-32';
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function buildAdminTestApp(opts: {
    user: { id: string; is_admin: boolean; status: string } | null;
    envOverrides?: Partial<EnvConfig>;
  }) {
    const auditInserts: Array<{ sql: string; params: unknown[] }> = [];
    const mockDb = {
      queryOne: vi.fn(async (sql: string) => {
        if (sql.includes('FROM users')) return opts.user;
        return null;
      }),
      query: vi.fn(async () => []),
      execute: vi.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes('INSERT INTO audit_log')) {
          auditInserts.push({ sql, params });
        }
        return { changes: 1 };
      }),
    };

    const app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      if (!c.env) (c as unknown as { env: Env }).env = {} as Env;
      Object.assign(c.env, {
        DB: mockDb,
        DATABASE_URL: 'postgresql://localhost/test',
        JWT_SIGNING_KEY: JWT_KEY,
        BOT_ENCRYPTION_KEY: '0'.repeat(64),
        SERVER_URL: 'https://app.im.codes',
        NODE_ENV: 'test',
        ...opts.envOverrides,
      });
      await next();
    });
    app.route('/api/admin', adminRoutes);
    return { app, auditInserts };
  }

  it('rejects unauthenticated and non-admin callers with 401/403', async () => {
    const { app } = buildAdminTestApp({
      user: { id: 'u-member', is_admin: false, status: 'active' },
      envOverrides: baseAwsEnv(),
    });

    const unauthRes = await app.request('/api/admin/email/status');
    expect(unauthRes.status).toBe(401);

    const memberJwt = signJwt({ sub: 'u-member', type: 'web' }, JWT_KEY, 3600);
    const statusRes = await app.request('/api/admin/email/status', {
      headers: { Authorization: `Bearer ${memberJwt}` },
    });
    expect(statusRes.status).toBe(403);

    const postRes = await app.request('/api/admin/email/test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${memberJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'a@gmail.com' }),
    });
    expect(postRes.status).toBe(403);

    const disabledApp = buildAdminTestApp({
      user: { id: 'u-disabled-admin', is_admin: true, status: 'disabled' },
      envOverrides: baseAwsEnv(),
    });
    const disabledJwt = signJwt({ sub: 'u-disabled-admin', type: 'web' }, JWT_KEY, 3600);
    const disabledRes = await disabledApp.app.request('/api/admin/email/status', {
      headers: { Authorization: `Bearer ${disabledJwt}` },
    });
    expect(disabledRes.status).toBe(403);
  });

  it('returns status and 503 when unconfigured, 502 on upstream failure, and sends + audit-logs when configured', async () => {
    const adminJwt = signJwt({ sub: 'u-admin', type: 'web' }, JWT_KEY, 3600);

    // Unconfigured case
    const uncfg = buildAdminTestApp({
      user: { id: 'u-admin', is_admin: true, status: 'active' },
    });
    const st1 = await uncfg.app.request('/api/admin/email/status', {
      headers: { Authorization: `Bearer ${adminJwt}` },
    });
    expect(st1.status).toBe(200);
    expect(await st1.json()).toEqual({
      configured: false,
      providers: { awsSes: false, aliyunDm: false },
    });

    const test503 = await uncfg.app.request('/api/admin/email/test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'user@gmail.com' }),
    });
    expect(test503.status).toBe(503);
    expect((await test503.json()).error).toBe('email_not_configured');

    // Configured case (both providers, routes @qq.com to aliyun_dm)
    const cfg = buildAdminTestApp({
      user: { id: 'u-admin', is_admin: true, status: 'active' },
      envOverrides: { ...baseAwsEnv(), ...baseAliyunEnv() },
    });
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ EnvId: 'adm-dm-42' }), { status: 200 }),
    );

    const st2 = await cfg.app.request('/api/admin/email/status', {
      headers: { Authorization: `Bearer ${adminJwt}` },
    });
    expect(st2.status).toBe(200);
    expect(await st2.json()).toEqual({
      configured: true,
      providers: { awsSes: true, aliyunDm: true },
    });

    const badRes = await cfg.app.request('/api/admin/email/test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'bad\r\n@qq.com' }),
    });
    expect(badRes.status).toBe(400);

    // Trailing CRLF / leading NUL on valid-looking email must still reject 400 without calling fetch
    for (const badTo of ['recipient@qq.com\r\n', '\nrecipient@qq.com', 'recipient@qq.com\0']) {
      const trailingBadRes = await cfg.app.request('/api/admin/email/test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: badTo }),
      });
      expect(trailingBadRes.status).toBe(400);
      expect((await trailingBadRes.json()).error).toBe('email_invalid_input');
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();

    const okRes = await cfg.app.request('/api/admin/email/test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'recipient@qq.com' }),
    });
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({
      ok: true,
      provider: 'aliyun_dm',
      messageId: 'adm-dm-42',
      fallbackUsed: false,
    });
    expect(cfg.auditInserts).toHaveLength(1);
    expect(cfg.auditInserts[0]!.params[3]).toBe('admin.email_test');
    const details = JSON.parse(cfg.auditInserts[0]!.params[4] as string);
    expect(details).toEqual({
      provider: 'aliyun_dm',
      fallbackUsed: false,
      recipientDomain: 'qq.com',
      messageId: 'adm-dm-42',
    });

    // Explicit unconfigured provider -> 503
    const awsOnly = buildAdminTestApp({
      user: { id: 'u-admin', is_admin: true, status: 'active' },
      envOverrides: baseAwsEnv(),
    });
    const prov503 = await awsOnly.app.request('/api/admin/email/test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'recipient@qq.com', provider: 'aliyun_dm' }),
    });
    expect(prov503.status).toBe(503);
    expect((await prov503.json()).error).toBe('email_provider_not_configured');

    // Upstream failure -> 502 without leaking raw or encoded secrets or body sentinels
    const trickySecret = 'aws+secret/key=special!';
    const trickyAws = buildAdminTestApp({
      user: { id: 'u-admin', is_admin: true, status: 'active' },
      envOverrides: baseAwsEnv({ AWS_SES_SECRET_ACCESS_KEY: trickySecret }),
    });
    globalThis.fetch = vi.fn<typeof fetch>(async () =>
      new Response(`SENTINEL_ADMIN_502 ${trickySecret} ${encodeURIComponent(trickySecret)}`, { status: 500 }),
    );
    const fail502 = await trickyAws.app.request('/api/admin/email/test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminJwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'recipient@gmail.com' }),
    });
    expect(fail502.status).toBe(502);
    const failJson = await fail502.json();
    expect(failJson.error).toBe('email_send_failed');
    expect(failJson.message).not.toContain(trickySecret);
    expect(failJson.message).not.toContain(encodeURIComponent(trickySecret));
    expect(failJson.message).not.toContain('SENTINEL_ADMIN_502');
  });
});
