import { pickReadableSessionDisplay } from '@shared/session-display.js';
import type { SessionInfo } from './types.js';

const APP_TITLE = 'IM.codes — The IM for agents';

export function getSessionTitleLabel(session: SessionInfo | null): string | null {
  if (!session) return null;
  return pickReadableSessionDisplay(
    [session.label, session.project, session.name],
    session.name,
  ) ?? session.name ?? null;
}

export function buildDocumentTitle(serverName: string | null, session: SessionInfo | null): string {
  const parts = [
    serverName?.trim() || null,
    getSessionTitleLabel(session),
    APP_TITLE,
  ].filter((value): value is string => !!value);
  return parts.join(' · ');
}
