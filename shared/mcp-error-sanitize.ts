const MAX_MCP_ERROR_MESSAGE_CHARS = 300;

export function sanitizeMcpErrorMessage(err: unknown, fallback = 'internal error'): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err ?? fallback);
  const singleLine = raw.split(/\r?\n/)[0] || fallback;
  return singleLine
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(token|secret|key|api_key|access_token|refresh_token)[=:]\s*[^&\s"']+/gi, '$1=[redacted]')
    .replace(/\b(?:postgres|postgresql|mysql|redis|mongodb|sqlite):\/\/[^\s"')]+/gi, '[redacted-url]')
    .replace(/https?:\/\/[^\s"')]+/gi, '[redacted-url]')
    .replace(/\/api\/server\/[^/\s"')]+\/cron/gi, '/api/server/[redacted]/cron')
    .slice(0, MAX_MCP_ERROR_MESSAGE_CHARS);
}
