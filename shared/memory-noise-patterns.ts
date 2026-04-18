/**
 * Detect low-value transport/API failure text that should not become memory.
 *
 * This is intentionally conservative. We only match summaries / turns that are
 * clearly just request-failure noise (for example
 * `[API Error: Connection error. (cause: fetch failed)]`), not normal prose
 * discussing those failures.
 */

const API_ERROR_PREFIX_RE = /^\[?api error:/i;
const REQUEST_FAILURE_RE = /(\bconnection error\b|\bfetch failed\b|\bnetwork request failed\b|\b(?:econnreset|econnrefused|enotfound|etimedout)\b|\b(?:dns lookup failed|socket hang up)\b)/i;

function normalizeLine(line: string): string {
  return line
    .replace(/^>\s*/, '')
    .replace(/^(?:-|\*)\s+/, '')
    .replace(/^`[^`]+`:\s*/, '')
    .replace(/^\*\*(?:user|assistant):\*\*\s*/i, '')
    .trim();
}

function isPureRequestFailureText(text: string): boolean {
  const normalized = normalizeLine(text)
    .replace(/^\(+|\)+$/g, '')
    .trim();
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  if (lower.startsWith('fixed ') || lower.startsWith('fix ') || lower.startsWith('avoid ') || lower.startsWith('handle ')) {
    return false;
  }
  return API_ERROR_PREFIX_RE.test(normalized) && REQUEST_FAILURE_RE.test(normalized);
}

function isMetaSummaryLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^##\s+/i.test(trimmed)) return true;
  if (/^---\s*updated\s*---$/i.test(trimmed)) return true;
  if (/^>\s*⚠️\s*\*\*structured summary unavailable\*\*/i.test(trimmed)) return true;
  return false;
}

export function isMemoryNoiseTurn(text: string | null | undefined): boolean {
  if (!text || typeof text !== 'string') return false;
  return isPureRequestFailureText(text.trim());
}

export function isMemoryNoiseSummary(summary: string | null | undefined): boolean {
  if (!summary || typeof summary !== 'string') return false;
  const trimmed = summary.trim();
  if (!trimmed) return false;
  if (isPureRequestFailureText(trimmed)) return true;

  const meaningfulLines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isMetaSummaryLine(line));

  if (meaningfulLines.length === 0) return false;

  const assistantLines = meaningfulLines.filter((line) =>
    /^\*\*assistant:\*\*/i.test(line) || /^-\s*`assistant\.(?:text|turn)`:/i.test(line),
  );
  if (assistantLines.length === 0) return false;

  return assistantLines.every((line) => isPureRequestFailureText(line));
}
