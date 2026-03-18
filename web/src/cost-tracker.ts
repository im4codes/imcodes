/**
 * Lightweight cost ledger for tracking Claude Code API spend.
 * Stores deltas in localStorage, aggregated by week and month.
 * Only Claude Code emits costUsd; Codex and Gemini are token-only.
 */

const LEDGER_KEY = 'rcc_cost_ledger';
const sessionHwmKey = (id: string) => `rcc_cost_s_${id}`;

interface LedgerEntry {
  date: string;   // YYYY-MM-DD
  week: string;   // YYYY-WW
  month: string;  // YYYY-MM
  delta: number;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoWeek(d: Date): string {
  const t = new Date(d);
  t.setHours(0, 0, 0, 0);
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));
  const jan4 = new Date(t.getFullYear(), 0, 4);
  const wn = 1 + Math.round(((t.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return `${t.getFullYear()}-W${String(wn).padStart(2, '0')}`;
}

function monthStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function loadLedger(): LedgerEntry[] {
  try {
    const v = localStorage.getItem(LEDGER_KEY);
    if (v) return JSON.parse(v) as LedgerEntry[];
  } catch { /* ignore */ }
  return [];
}

function saveLedger(entries: LedgerEntry[]): void {
  // Keep at most 400 entries (~13 months of daily activity)
  const trimmed = entries.length > 400 ? entries.slice(-400) : entries;
  try { localStorage.setItem(LEDGER_KEY, JSON.stringify(trimmed)); } catch { /* ignore */ }
}

/**
 * Record a new total_cost_usd observation for a session.
 * Computes delta vs previous high-water mark and appends to ledger.
 */
export function recordCost(sessionId: string, totalCostUsd: number): void {
  const hwmKey = sessionHwmKey(sessionId);
  let prev = 0;
  try {
    const v = localStorage.getItem(hwmKey);
    if (v) prev = Number(v);
  } catch { /* ignore */ }

  // totalCostUsd is cumulative within a CC session run.
  // If it's higher → delta = increase. If lower → new session started, delta = full amount.
  const delta = totalCostUsd > prev ? totalCostUsd - prev : totalCostUsd;
  if (delta <= 0.000001) return;

  try { localStorage.setItem(hwmKey, String(Math.max(totalCostUsd, prev))); } catch { /* ignore */ }

  const now = new Date();
  const entries = loadLedger();
  entries.push({ date: todayStr(), week: isoWeek(now), month: monthStr(now), delta });
  saveLedger(entries);
}

/** Latest known total cost for a session (current run high-water mark). */
export function getSessionCost(sessionId: string): number {
  try {
    const v = localStorage.getItem(sessionHwmKey(sessionId));
    if (v) return Number(v);
  } catch { /* ignore */ }
  return 0;
}

export function getWeeklyCost(): number {
  const wk = isoWeek(new Date());
  return loadLedger().filter((e) => e.week === wk).reduce((s, e) => s + e.delta, 0);
}

export function getMonthlyCost(): number {
  const mk = monthStr(new Date());
  return loadLedger().filter((e) => e.month === mk).reduce((s, e) => s + e.delta, 0);
}

export function formatCost(usd: number): string {
  if (usd < 0.001) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
