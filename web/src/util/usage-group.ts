import type { UsageSummaryResponse, UsageSummaryRow } from '@shared/usage-analytics.js';

// Pure token-usage aggregation helpers, kept free of any UI/framework imports so
// they can be unit-tested directly (the components that use them pull in
// react-i18next, which a plain unit test shouldn't need to load).

export interface UsageTotals {
  factCount: number;
  inputTokens: number;
  cacheTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsdMicros: number | null;
}

export interface UsageGroupMember {
  sessionName: string;
  kind: 'main' | 'sub';
  totals: UsageTotals;
}

export interface UsageGroup {
  root: string;
  members: UsageGroupMember[];
  groupTotals: UsageTotals;
}

/**
 * Resolve the session group for `target` (a main session, or a sub whose parent
 * is the root) and aggregate its members' totals from an account-wide summary.
 */
export function computeSessionGroup(res: UsageSummaryResponse | null, target: string): UsageGroup {
  if (!res || !target) return { root: target, members: [], groupTotals: emptyUsageTotals() };
  const subRow = res.bySubSession.find((r) => r.sessionName === target);
  const root = (subRow?.parentSessionName && subRow.parentSessionName.trim()) ? subRow.parentSessionName : target;

  const members: UsageGroupMember[] = [];
  const mainRow = res.byMainSession.find((r) => r.sessionName === root);
  if (mainRow) members.push({ sessionName: root, kind: 'main', totals: rowToTotals(mainRow) });
  for (const r of res.bySubSession) {
    if (r.parentSessionName === root && r.sessionName) {
      members.push({ sessionName: r.sessionName, kind: 'sub', totals: rowToTotals(r) });
    }
  }
  return { root, members, groupTotals: sumUsageTotals(members.map((m) => m.totals)) };
}

/** Distinct, sorted, non-empty dropdown options from a summary's grouped rows. */
export function deriveFacetOptions(res: UsageSummaryResponse | null): {
  servers: string[]; providers: string[]; models: string[]; sessions: string[];
} {
  if (!res) return { servers: [], providers: [], models: [], sessions: [] };
  const distinct = (values: (string | null | undefined)[]) =>
    Array.from(new Set(values.filter((v): v is string => !!v && v.trim() !== ''))).sort();
  return {
    servers: distinct(res.byServer.map((r) => r.serverId)),
    providers: distinct(res.byProviderModel.map((r) => r.provider)),
    models: distinct(res.byProviderModel.map((r) => r.model)),
    sessions: distinct([...res.byMainSession, ...res.bySubSession].map((r) => r.sessionName)),
  };
}

export function rowToTotals(r: UsageSummaryRow): UsageTotals {
  return {
    factCount: r.factCount,
    inputTokens: r.inputTokens,
    cacheTokens: r.cacheTokens,
    outputTokens: r.outputTokens,
    totalTokens: r.totalTokens,
    costUsdMicros: r.costUsdMicros,
  };
}

export function sumUsageTotals(list: UsageTotals[]): UsageTotals {
  const acc = emptyUsageTotals();
  let anyCost = false;
  for (const t of list) {
    acc.factCount += t.factCount;
    acc.inputTokens += t.inputTokens;
    acc.cacheTokens += t.cacheTokens;
    acc.outputTokens += t.outputTokens;
    acc.totalTokens += t.totalTokens;
    if (t.costUsdMicros != null) { anyCost = true; acc.costUsdMicros = (acc.costUsdMicros ?? 0) + t.costUsdMicros; }
  }
  if (!anyCost) acc.costUsdMicros = null;
  return acc;
}

export function emptyUsageTotals(): UsageTotals {
  return { factCount: 0, inputTokens: 0, cacheTokens: 0, outputTokens: 0, totalTokens: 0, costUsdMicros: null };
}
