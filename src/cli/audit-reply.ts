import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PEER_AUDIT_REPLY_VERSION,
  decodePeerAuditReplyEnvelope,
  type PeerAuditReplyEnvelope,
} from '../../shared/peer-audit.js';
import { resolveLiveHookPort } from '../daemon/hook-port.js';
import { detectSenderSession } from '../util/detect-session.js';

export interface AuditReplyCommandOptions {
  attemptId: string;
  capability: string;
  verdict: string;
  findingsFile: string;
  validationsFile: string;
}

export interface AuditReplyCommandDeps {
  detectSender: () => Promise<string>;
  resolveHookPort: () => Promise<number | null>;
  readText: (path: string) => string;
  post: (port: number, envelope: PeerAuditReplyEnvelope, sender: string) => Promise<Record<string, unknown>>;
}

async function postAuditReply(
  port: number,
  envelope: PeerAuditReplyEnvelope,
  sender: string,
): Promise<Record<string, unknown>> {
  const data = JSON.stringify(envelope);
  return new Promise((resolvePromise, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/audit-reply',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'x-imcodes-session': sender,
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => {
        try {
          resolvePromise(JSON.parse(body) as Record<string, unknown>);
        } catch {
          reject(new Error('peer-audit daemon ingress returned malformed JSON'));
        }
      });
    });
    req.on('error', () => reject(new Error('peer-audit daemon ingress unavailable')));
    req.end(data);
  });
}

const DEFAULT_DEPS: AuditReplyCommandDeps = {
  detectSender: async () => detectSenderSession(),
  resolveHookPort: resolveLiveHookPort,
  readText: (path) => readFileSync(resolve(path), 'utf8'),
  post: postAuditReply,
};

/** Submit through the daemon-only route. There is intentionally no tmux,
 * sendKeys, ordinary /send, or retry fallback in this module. */
export async function runAuditReplyCommand(
  options: AuditReplyCommandOptions,
  deps: AuditReplyCommandDeps = DEFAULT_DEPS,
): Promise<void> {
  const sender = await deps.detectSender().catch(() => '');
  if (!sender) throw new Error('audit-reply requires a managed current session (set IMCODES_SESSION)');

  let validations: unknown;
  try {
    validations = JSON.parse(deps.readText(options.validationsFile)) as unknown;
  } catch {
    throw new Error('invalid validations file');
  }
  const decoded = decodePeerAuditReplyEnvelope({
    version: PEER_AUDIT_REPLY_VERSION,
    attemptId: options.attemptId,
    replyCapability: options.capability,
    verdict: options.verdict,
    findings: deps.readText(options.findingsFile),
    validations,
  });
  if (!decoded.ok) throw new Error(`invalid peer-audit reply: ${decoded.error}`);

  const port = await deps.resolveHookPort();
  if (!port) throw new Error('peer-audit daemon ingress unavailable');
  const result = await deps.post(port, decoded.value, sender);
  if (result.ok !== true) {
    // Never include the one-time capability or the full envelope in errors.
    throw new Error(`peer-audit reply rejected: ${String(result.error ?? 'unknown_error')}`);
  }
}
