/**
 * POST JSON to the daemon hook server (the client half of `imcodes send`,
 * `status` and friends). Kept out of cli.ts so command mode can use its strict,
 * time-bounded form without duplicating the request code.
 */
import { SEND_COMMAND_FAILURE_KINDS, type SendCommandFailureKind } from '../../shared/send-command-mode.js';
import { hookCredentialHeaders } from '../../shared/hook-session-credential.js';

export interface HookPostOptions {
  /** Fail the request after this long. Unset: wait indefinitely, as before. */
  timeoutMs?: number;
  /** Reject every non-2xx status (and unreadable body) with a HookPostError instead of returning the parsed body. */
  strictStatus?: boolean;
}

/** A hook request that failed, classified for callers that must not guess (command mode). */
export class HookPostError extends Error {
  readonly kind: SendCommandFailureKind;
  readonly statusCode?: number;
  constructor(kind: SendCommandFailureKind, message: string, statusCode?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HookPostError';
    this.kind = kind;
    if (statusCode !== undefined) this.statusCode = statusCode;
  }
}

/** POST JSON to the hook server and return parsed response. */
export async function postToHookServer(
  port: number,
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  options: HookPostOptions = {},
): Promise<Record<string, unknown>> {
  const http = await import('http');
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...hookCredentialHeaders(),
          ...headers,
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;
          if (options.strictStatus && (statusCode < 200 || statusCode > 299)) {
            let detail = `HTTP ${statusCode}`;
            try {
              const parsed = JSON.parse(responseBody) as { error?: unknown };
              if (typeof parsed.error === 'string' && parsed.error) detail += `: ${parsed.error}`;
            } catch { /* not JSON: the status alone names the cause */ }
            reject(new HookPostError(SEND_COMMAND_FAILURE_KINDS.HTTP_STATUS, detail, statusCode));
            return;
          }
          try {
            resolve(JSON.parse(responseBody) as Record<string, unknown>);
          } catch {
            reject(options.strictStatus
              ? new HookPostError(SEND_COMMAND_FAILURE_KINDS.INVALID_RESPONSE, `HTTP ${statusCode}, body is not JSON`, statusCode)
              : Object.assign(new Error(`Invalid JSON response: ${responseBody}`), { statusCode: res.statusCode }));
          }
        });
        res.on('error', (err) => {
          reject(options.strictStatus ? new HookPostError(SEND_COMMAND_FAILURE_KINDS.UNREACHABLE, err.message, undefined, err) : err);
        });
      },
    );
    if (options.timeoutMs !== undefined) {
      req.setTimeout(options.timeoutMs, () => {
        req.destroy(new HookPostError(SEND_COMMAND_FAILURE_KINDS.TIMEOUT, `no answer within ${options.timeoutMs} ms`));
      });
    }
    req.on('error', (err) => {
      if (!options.strictStatus || err instanceof HookPostError) { reject(err); return; }
      const code = (err as NodeJS.ErrnoException).code;
      reject(new HookPostError(SEND_COMMAND_FAILURE_KINDS.UNREACHABLE, code ? `${code}: ${err.message}` : err.message, undefined, err));
    });
    req.write(data);
    req.end();
  });
}
