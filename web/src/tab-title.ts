import { pickReadableSessionDisplay } from '@shared/session-display.js';
import type { SessionInfo } from './types.js';

export const APP_TITLE = 'IM.codes — AI Force Workbench · Your Dedicated AI Squad';
export const DEFAULT_APP_TITLE = APP_TITLE;

export function getSessionTitleLabel(session: SessionInfo | null): string | null {
  if (!session) return null;
  return pickReadableSessionDisplay(
    [session.label, session.project, session.name],
    session.name,
  ) ?? session.name ?? null;
}

export function buildDocumentTitle(
  serverName: string | null,
  session: SessionInfo | null,
  appTitle?: string,
): string {
  const resolvedAppTitle = appTitle?.trim() || APP_TITLE;
  const parts = [
    serverName?.trim() || null,
    getSessionTitleLabel(session),
    resolvedAppTitle,
  ].filter((value): value is string => !!value);
  return parts.join(' · ');
}
