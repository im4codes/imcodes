/**
 * Which request of the shared-context management panel failed, and why, in terms a user
 * can act on. The panel used to funnel every load into ONE red string (`API 404: not_found`)
 * that named neither the request nor the cause and stayed on screen across tabs, so a
 * stale enterprise id, a server the account does not own, or a server older than the web
 * all looked identical.
 */

export const PANEL_LOAD_SECTIONS = {
  TEAMS: 'teams',
  ENTERPRISE: 'enterprise',
  POLICY: 'policy',
  RUNTIME_CONFIG: 'runtimeConfig',
  CLOUD_MEMORY: 'cloudMemory',
  ENTERPRISE_MEMORY: 'enterpriseMemory',
} as const;
export type PanelLoadSection = (typeof PANEL_LOAD_SECTIONS)[keyof typeof PANEL_LOAD_SECTIONS];

const ENTERPRISE_TABS = ['enterprise', 'members', 'projects', 'knowledge'] as const;

/** A load error is only worth a red line on the tabs that show what failed to load. */
export const PANEL_LOAD_SECTION_TABS: Readonly<Record<PanelLoadSection, readonly string[]>> = {
  [PANEL_LOAD_SECTIONS.TEAMS]: ENTERPRISE_TABS,
  [PANEL_LOAD_SECTIONS.ENTERPRISE]: ENTERPRISE_TABS,
  [PANEL_LOAD_SECTIONS.POLICY]: ['projects'],
  [PANEL_LOAD_SECTIONS.RUNTIME_CONFIG]: ['processing', 'memory'],
  [PANEL_LOAD_SECTIONS.CLOUD_MEMORY]: ['memory'],
  [PANEL_LOAD_SECTIONS.ENTERPRISE_MEMORY]: ['memory'],
};

export const PANEL_LOAD_ERROR_KINDS = {
  NOT_FOUND: 'not_found',
  FORBIDDEN: 'forbidden',
  UNAUTHORIZED: 'unauthorized',
  UNAVAILABLE: 'unavailable',
  NETWORK: 'network',
  OTHER: 'other',
} as const;
export type PanelLoadErrorKind = (typeof PANEL_LOAD_ERROR_KINDS)[keyof typeof PANEL_LOAD_ERROR_KINDS];

export interface PanelLoadErrorInfo {
  kind: PanelLoadErrorKind;
  status: number | null;
  /** The raw message, only shown for `other`. */
  detail: string;
}

/** Duck-typed on `status` so it also classifies the `ApiError` of a different module instance. */
export function classifyPanelLoadError(err: unknown): PanelLoadErrorInfo {
  const detail = err instanceof Error ? err.message : String(err);
  const status = typeof (err as { status?: unknown } | null)?.status === 'number'
    ? (err as { status: number }).status
    : null;
  if (status === null) {
    // `fetch` rejects with a TypeError when the server cannot be reached at all.
    return { kind: err instanceof TypeError ? PANEL_LOAD_ERROR_KINDS.NETWORK : PANEL_LOAD_ERROR_KINDS.OTHER, status, detail };
  }
  if (status === 404) return { kind: PANEL_LOAD_ERROR_KINDS.NOT_FOUND, status, detail };
  if (status === 403) return { kind: PANEL_LOAD_ERROR_KINDS.FORBIDDEN, status, detail };
  if (status === 401) return { kind: PANEL_LOAD_ERROR_KINDS.UNAUTHORIZED, status, detail };
  if (status >= 500) return { kind: PANEL_LOAD_ERROR_KINDS.UNAVAILABLE, status, detail };
  return { kind: PANEL_LOAD_ERROR_KINDS.OTHER, status, detail };
}

/** i18n keys (all seven locales carry them). */
export const panelLoadSectionKey = (section: PanelLoadSection): string => `sharedContext.management.loadSection.${section}`;
export const panelLoadErrorKey = (kind: PanelLoadErrorKind): string => `sharedContext.management.loadError.${kind}`;
