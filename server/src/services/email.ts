/**
 * Zero-dependency dual-channel transactional email service:
 * - Amazon SES v2 (`POST /v2/email/outbound-emails`, AWS SigV4)
 * - Alibaba Cloud DirectMail (`SingleSendMail` API `2015-11-23`, POP HMAC-SHA1)
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { EnvConfig } from '../env.js';
import logger from '../util/logger.js';

export type EmailProvider = 'aws_ses' | 'aliyun_dm';

export type EmailServiceErrorCode =
  | 'email_not_configured'
  | 'email_invalid_input'
  | 'email_provider_not_configured'
  | 'email_send_failed';

export class EmailServiceError extends Error {
  readonly code: EmailServiceErrorCode;
  readonly statusCode?: number;

  constructor(code: EmailServiceErrorCode, message: string, statusCode?: number) {
    super(message);
    this.name = 'EmailServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface EmailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  /**
   * Optional reply-to email address.
   * - Amazon SES v2 sets `ReplyToAddresses` to this exact address.
   * - Alibaba Cloud DirectMail `SingleSendMail` treats `ReplyToAddress` as a boolean toggle (`true`
   *   selects the verified reply-to address configured in the DirectMail console; cannot override per email).
   */
  replyTo?: string;
}

export interface EmailSendResult {
  provider: EmailProvider;
  messageId: string;
  fallbackUsed: boolean;
}

export interface EmailConfigStatus {
  configured: boolean;
  providers: {
    awsSes: boolean;
    aliyunDm: boolean;
  };
}

export interface EmailSendOptions {
  provider?: EmailProvider;
  fetch?: typeof fetch;
  now?: () => number;
  nonce?: () => string;
  timeoutMs?: number;
}

interface AwsSesConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  from: string;
  endpoint?: string;
}

interface AliyunDmConfig {
  accessKeyId: string;
  accessKeySecret: string;
  region: string;
  from: string;
  fromAlias?: string;
  endpoint?: string;
}

export const DEFAULT_EMAIL_CN_DOMAINS: readonly string[] = [
  'qq.com',
  'foxmail.com',
  'vip.qq.com',
  '163.com',
  '126.com',
  'yeah.net',
  '188.com',
  'sina.com',
  'sina.cn',
  'sohu.com',
  'aliyun.com',
  '139.com',
  '189.cn',
  'wo.cn',
];

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_AWS_SES_REGION = 'us-east-1';
const DEFAULT_ALIYUN_DM_REGION = 'ap-southeast-1';

const ALIYUN_DM_ENDPOINTS: Record<string, string> = {
  'cn-hangzhou': 'https://dm.aliyuncs.com/',
  'ap-southeast-1': 'https://dm.ap-southeast-1.aliyuncs.com/',
  // Legacy retired endpoint mapping retained for endpoint-resolution compatibility.
  'ap-southeast-2': 'https://dm.ap-southeast-2.aliyuncs.com/',
};

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const SINGLE_EMAIL_RE = /^[^\s@,;<>()[\]\\"]+@[^\s@,;<>()[\]\\"]+\.[^\s@,;<>()[\]\\"]{2,}$/;
const SAFE_REGION_RE = /^[a-z0-9-]+$/;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function getAwsSesConfig(env: Partial<EnvConfig>): AwsSesConfig | null {
  const accessKeyId = nonEmpty(env.AWS_SES_ACCESS_KEY_ID);
  const secretAccessKey = nonEmpty(env.AWS_SES_SECRET_ACCESS_KEY);
  const from = nonEmpty(env.AWS_SES_FROM);
  if (!accessKeyId || !secretAccessKey || !from) return null;
  return {
    accessKeyId,
    secretAccessKey,
    region: nonEmpty(env.AWS_SES_REGION) ?? DEFAULT_AWS_SES_REGION,
    from,
    endpoint: nonEmpty(env.AWS_SES_ENDPOINT),
  };
}

function getAliyunDmConfig(env: Partial<EnvConfig>): AliyunDmConfig | null {
  const accessKeyId = nonEmpty(env.ALIYUN_DM_ACCESS_KEY_ID);
  const accessKeySecret = nonEmpty(env.ALIYUN_DM_ACCESS_KEY_SECRET);
  const from = nonEmpty(env.ALIYUN_DM_FROM);
  if (!accessKeyId || !accessKeySecret || !from) return null;
  return {
    accessKeyId,
    accessKeySecret,
    region: nonEmpty(env.ALIYUN_DM_REGION) ?? DEFAULT_ALIYUN_DM_REGION,
    from,
    fromAlias: nonEmpty(env.ALIYUN_DM_FROM_ALIAS),
    endpoint: nonEmpty(env.ALIYUN_DM_ENDPOINT),
  };
}

/** Non-secret email provider availability summary. */
export function getEmailConfigStatus(env: Partial<EnvConfig>): EmailConfigStatus {
  const awsSes = getAwsSesConfig(env) !== null;
  const aliyunDm = getAliyunDmConfig(env) !== null;
  return {
    configured: awsSes || aliyunDm,
    providers: { awsSes, aliyunDm },
  };
}

/** Resolve active China-mailbox domains used for automatic Aliyun DirectMail routing. */
export function resolveEmailCnDomains(env: Partial<EnvConfig>): Set<string> {
  const custom = nonEmpty(env.EMAIL_CN_DOMAINS);
  if (!custom) return new Set(DEFAULT_EMAIL_CN_DOMAINS);
  const domains = custom
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  return new Set(domains.length > 0 ? domains : DEFAULT_EMAIL_CN_DOMAINS);
}

/** Return true when the recipient email domain belongs to the configured China-mailbox set. */
export function isCnEmailDomain(email: string, cnDomains: ReadonlySet<string>): boolean {
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return cnDomains.has(domain);
}

function validateEmailAddress(raw: unknown, field: string): string {
  if (typeof raw !== 'string') {
    throw new EmailServiceError('email_invalid_input', `Invalid ${field} email address`);
  }
  if (CONTROL_CHAR_RE.test(raw)) {
    throw new EmailServiceError('email_invalid_input', `Invalid characters in ${field} email address`);
  }
  const trimmed = raw.trim();
  if (!trimmed || !SINGLE_EMAIL_RE.test(trimmed)) {
    throw new EmailServiceError('email_invalid_input', `Invalid ${field} email address`);
  }
  return trimmed;
}

function validateFromAddress(raw: string, field: string): string {
  if (CONTROL_CHAR_RE.test(raw)) {
    throw new EmailServiceError('email_invalid_input', `Invalid characters in ${field}`);
  }
  return raw.trim();
}

function validateSubject(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new EmailServiceError('email_invalid_input', 'Email subject is required');
  }
  if (CONTROL_CHAR_RE.test(raw)) {
    throw new EmailServiceError('email_invalid_input', 'Invalid characters in email subject');
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new EmailServiceError('email_invalid_input', 'Email subject is required');
  }
  return trimmed;
}

function sanitizeSecrets(raw: string, secrets: Array<string | undefined>): string {
  let out = raw.replace(/[\r\n]+/g, ' ').trim();
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  out = out.replace(/Signature=[^&\s]+/gi, 'Signature=[REDACTED]');
  out = out.replace(/Authorization:\s*[^\s,;]+(?:\s+[^\r\n]+)?/gi, 'Authorization: [REDACTED]');
  return out.slice(0, 240);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmacSha256(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function buildAwsEndpointUrl(config: AwsSesConfig): URL {
  if (!SAFE_REGION_RE.test(config.region)) {
    throw new EmailServiceError('email_invalid_input', 'Invalid AWS_SES_REGION');
  }
  const base = config.endpoint ?? `https://email.${config.region}.amazonaws.com`;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new EmailServiceError('email_invalid_input', 'Invalid AWS_SES_ENDPOINT');
  }
  const prefix = url.pathname.replace(/\/+$/, '');
  url.pathname = `${prefix}/v2/email/outbound-emails`;
  return url;
}

async function sendViaAwsSes(
  config: AwsSesConfig,
  params: { to: string; subject: string; text?: string; html?: string; replyTo?: string },
  opts: Required<Pick<EmailSendOptions, 'fetch' | 'now' | 'timeoutMs'>>,
  secrets: Array<string | undefined>,
): Promise<EmailSendResult> {
  const from = validateFromAddress(config.from, 'AWS_SES_FROM');
  const url = buildAwsEndpointUrl(config);
  const amzDate = new Date(opts.now()).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const bodyObj = {
    FromEmailAddress: from,
    Destination: { ToAddresses: [params.to] },
    ...(params.replyTo ? { ReplyToAddresses: [params.replyTo] } : {}),
    Content: {
      Simple: {
        Subject: { Data: params.subject, Charset: 'UTF-8' },
        Body: {
          ...(params.text ? { Text: { Data: params.text, Charset: 'UTF-8' } } : {}),
          ...(params.html ? { Html: { Data: params.html, Charset: 'UTF-8' } } : {}),
        },
      },
    },
  };
  const bodyJson = JSON.stringify(bodyObj);
  const payloadHash = sha256Hex(bodyJson);

  const canonicalHeaders =
    `content-type:application/json\n` +
    `host:${url.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalQuery = Array.from(url.searchParams.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${percentEncode(k)}=${percentEncode(v)}`)
    .join('&');
  const canonicalRequest =
    `POST\n${url.pathname}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const scope = `${dateStamp}/${config.region}/ses/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonicalRequest)}`;
  const signingKey = hmacSha256(
    hmacSha256(hmacSha256(hmacSha256(`AWS4${config.secretAccessKey}`, dateStamp), config.region), 'ses'),
    'aws4_request',
  );
  const signature = hmacSha256(signingKey, stringToSign).toString('hex');
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  let response: Response;
  try {
    response = await opts.fetch(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: url.host,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        authorization,
      },
      body: bodyJson,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    const reason = sanitizeSecrets(err instanceof Error ? err.message : String(err), secrets);
    throw new EmailServiceError('email_send_failed', `AWS SES request failed: ${reason || 'network error'}`);
  }

  const responseText = await response.text().catch(() => '');
  if (!response.ok) {
    const safeDetail = sanitizeSecrets(responseText, secrets);
    throw new EmailServiceError(
      'email_send_failed',
      `AWS SES failed with status ${response.status}${safeDetail ? `: ${safeDetail}` : ''}`,
      response.status,
    );
  }

  let messageId = 'unknown';
  try {
    const parsed = JSON.parse(responseText) as { MessageId?: string };
    if (typeof parsed.MessageId === 'string' && parsed.MessageId) {
      messageId = parsed.MessageId;
    }
  } catch {
    // Some relays or mocks may omit JSON body on 200 OK
  }

  return { provider: 'aws_ses', messageId, fallbackUsed: false };
}

function buildAliyunEndpointUrl(config: AliyunDmConfig): URL {
  if (!SAFE_REGION_RE.test(config.region)) {
    throw new EmailServiceError('email_invalid_input', 'Invalid ALIYUN_DM_REGION');
  }
  const rawEndpoint = config.endpoint ?? ALIYUN_DM_ENDPOINTS[config.region] ?? `https://dm.${config.region}.aliyuncs.com/`;
  try {
    return new URL(rawEndpoint);
  } catch {
    throw new EmailServiceError('email_invalid_input', 'Invalid ALIYUN_DM_ENDPOINT');
  }
}

async function sendViaAliyunDm(
  config: AliyunDmConfig,
  params: { to: string; subject: string; text?: string; html?: string; replyTo?: string },
  opts: Required<Pick<EmailSendOptions, 'fetch' | 'now' | 'nonce' | 'timeoutMs'>>,
  secrets: Array<string | undefined>,
): Promise<EmailSendResult> {
  const from = validateEmailAddress(config.from, 'ALIYUN_DM_FROM');
  const url = buildAliyunEndpointUrl(config);
  const timestamp = new Date(opts.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const signatureNonce = opts.nonce();

  const rpcParams: Record<string, string> = {
    Action: 'SingleSendMail',
    AccountName: from,
    AddressType: '1',
    ReplyToAddress: params.replyTo ? 'true' : 'false',
    ToAddress: params.to,
    Subject: params.subject,
    Format: 'JSON',
    Version: '2015-11-23',
    AccessKeyId: config.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    Timestamp: timestamp,
    SignatureVersion: '1.0',
    SignatureNonce: signatureNonce,
  };
  if (config.fromAlias) {
    if (CONTROL_CHAR_RE.test(config.fromAlias)) {
      throw new EmailServiceError('email_invalid_input', 'Invalid characters in ALIYUN_DM_FROM_ALIAS');
    }
    rpcParams.FromAlias = config.fromAlias;
  }
  if (params.html) rpcParams.HtmlBody = params.html;
  if (params.text) rpcParams.TextBody = params.text;

  const sortedKeys = Object.keys(rpcParams).sort();
  const canonicalQuery = sortedKeys
    .map((k) => `${percentEncode(k)}=${percentEncode(rpcParams[k]!)}`)
    .join('&');
  const stringToSign = `POST&${percentEncode('/')}&${percentEncode(canonicalQuery)}`;
  const signature = createHmac('sha1', `${config.accessKeySecret}&`)
    .update(stringToSign, 'utf8')
    .digest('base64');
  const body = `${canonicalQuery}&Signature=${percentEncode(signature)}`;

  let response: Response;
  try {
    response = await opts.fetch(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    const reason = sanitizeSecrets(err instanceof Error ? err.message : String(err), secrets);
    throw new EmailServiceError('email_send_failed', `Aliyun DirectMail request failed: ${reason || 'network error'}`);
  }

  const responseText = await response.text().catch(() => '');
  let parsed: { EnvId?: string; RequestId?: string; Code?: string; Message?: string } | null = null;
  try {
    parsed = JSON.parse(responseText) as { EnvId?: string; RequestId?: string; Code?: string; Message?: string };
  } catch {
    parsed = null;
  }

  if (!response.ok || (parsed && typeof parsed.Code === 'string' && parsed.Code.length > 0)) {
    const safeDetail = sanitizeSecrets(parsed?.Message ?? responseText, secrets);
    const codeSuffix = parsed?.Code ? ` (${sanitizeSecrets(parsed.Code, secrets)})` : '';
    throw new EmailServiceError(
      'email_send_failed',
      `Aliyun DirectMail failed with status ${response.status}${codeSuffix}${safeDetail ? `: ${safeDetail}` : ''}`,
      response.status,
    );
  }

  const messageId = parsed?.EnvId || parsed?.RequestId || 'unknown';
  return { provider: 'aliyun_dm', messageId, fallbackUsed: false };
}

/**
 * Send a transactional email via Amazon SES v2 and/or Alibaba Cloud DirectMail.
 * Auto-routes China domains to Aliyun DirectMail (when both configured) with single-attempt
 * cross-channel fallback unless an explicit `options.provider` is requested.
 */
export async function sendEmail(
  env: Partial<EnvConfig>,
  message: EmailMessage,
  options?: EmailSendOptions,
): Promise<EmailSendResult> {
  const to = validateEmailAddress(message.to, 'recipient');
  const subject = validateSubject(message.subject);
  const text = typeof message.text === 'string' && message.text.trim() ? message.text : undefined;
  const html = typeof message.html === 'string' && message.html.trim() ? message.html : undefined;
  if (!text && !html) {
    throw new EmailServiceError('email_invalid_input', 'Email text or html body is required');
  }
  const rawReplyTo = nonEmpty(message.replyTo) ?? nonEmpty(env.EMAIL_REPLY_TO);
  const replyTo = rawReplyTo !== undefined ? validateEmailAddress(rawReplyTo, 'replyTo') : undefined;

  const awsConfig = getAwsSesConfig(env);
  const aliyunConfig = getAliyunDmConfig(env);
  const secrets = [
    awsConfig?.accessKeyId,
    awsConfig?.secretAccessKey,
    aliyunConfig?.accessKeyId,
    aliyunConfig?.accessKeySecret,
  ];

  const runtimeOpts = {
    fetch: options?.fetch ?? globalThis.fetch,
    now: options?.now ?? (() => Date.now()),
    nonce: options?.nonce ?? (() => randomUUID()),
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  let primary: EmailProvider;
  let fallback: EmailProvider | null = null;

  if (options?.provider) {
    const selected = options.provider;
    if ((selected === 'aws_ses' && !awsConfig) || (selected === 'aliyun_dm' && !aliyunConfig)) {
      throw new EmailServiceError('email_provider_not_configured', `Email provider ${selected} is not configured`);
    }
    primary = selected;
  } else {
    if (!awsConfig && !aliyunConfig) {
      throw new EmailServiceError('email_not_configured', 'No email provider is configured');
    }
    if (awsConfig && aliyunConfig) {
      const cnDomains = resolveEmailCnDomains(env);
      const isCn = isCnEmailDomain(to, cnDomains);
      primary = isCn ? 'aliyun_dm' : 'aws_ses';
      fallback = isCn ? 'aws_ses' : 'aliyun_dm';
    } else {
      primary = awsConfig ? 'aws_ses' : 'aliyun_dm';
    }
  }

  const dispatch = async (provider: EmailProvider): Promise<EmailSendResult> => {
    if (provider === 'aws_ses') {
      return sendViaAwsSes(awsConfig!, { to, subject, text, html, replyTo }, runtimeOpts, secrets);
    }
    return sendViaAliyunDm(aliyunConfig!, { to, subject, text, html, replyTo }, runtimeOpts, secrets);
  };

  try {
    return await dispatch(primary);
  } catch (primaryErr) {
    if (primaryErr instanceof EmailServiceError && primaryErr.code === 'email_invalid_input') {
      throw primaryErr;
    }
    if (!fallback) {
      throw primaryErr;
    }
    const domain = to.slice(to.lastIndexOf('@') + 1).toLowerCase();
    logger.warn(
      {
        primary,
        fallback,
        recipientDomain: domain,
        error: primaryErr instanceof Error ? sanitizeSecrets(primaryErr.message, secrets) : 'unknown_error',
      },
      'Primary email provider failed; retrying on fallback provider',
    );
    try {
      const res = await dispatch(fallback);
      return { ...res, fallbackUsed: true };
    } catch (fallbackErr) {
      const pMsg = primaryErr instanceof Error ? sanitizeSecrets(primaryErr.message, secrets) : 'failed';
      const fMsg = fallbackErr instanceof Error ? sanitizeSecrets(fallbackErr.message, secrets) : 'failed';
      throw new EmailServiceError(
        'email_send_failed',
        `Both ${primary} and fallback ${fallback} failed (${pMsg}; ${fMsg})`,
        fallbackErr instanceof EmailServiceError ? fallbackErr.statusCode : undefined,
      );
    }
  }
}
