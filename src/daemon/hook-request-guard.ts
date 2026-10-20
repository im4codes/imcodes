/**
 * The hook server listens on 127.0.0.1 and identifies its callers by a header the CALLER writes (`x-imcodes-session`), so the only thing
 * standing between it and a web page is the socket address. A page in the user's browser can still reach a loopback port (DNS
 * rebinding makes the page's own origin resolve to 127.0.0.1; a plain cross-site form POST needs no preflight). Every legitimate caller is
 * a local program (the stdio MCP child, `imcodes send`, the peer-audit CLI, agent hooks): it connects to the loopback address and sends no
 * `Origin` -- a browser always does for a cross-origin request. Requests that show either browser trait are refused.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export interface HookRequestHeaders {
  host?: string | string[] | undefined;
  origin?: string | string[] | undefined;
}

export function isLocalHookRequest(headers: HookRequestHeaders): boolean {
  if (headers.origin !== undefined) return false;
  const rawHost = Array.isArray(headers.host) ? headers.host[0] : headers.host;
  // HTTP/1.0 clients may omit Host; the socket is loopback either way.
  if (rawHost === undefined || rawHost === '') return true;
  const host = rawHost.trim().toLowerCase();
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
  return LOOPBACK_HOSTS.has(name);
}
