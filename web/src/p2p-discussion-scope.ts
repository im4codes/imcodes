export interface P2pScopedDiscussion {
  state?: string;
  mainSession?: string;
  initiatorSession?: string;
  participantSessions?: readonly string[];
}

export interface P2pScopeContext {
  activeSession?: string | null;
  activeRootSession?: string | null;
  visibleSubSessionNames?: readonly string[];
}

export function isP2pDiscussionVisibleInSubSessionBar(
  discussion: P2pScopedDiscussion,
  context: P2pScopeContext,
): boolean {
  // Both terminal states leave the bar (aligned with DiscussionsPage.activeLive),
  // so a failed classic discussion does not linger as a permanent red card.
  if (discussion.state === 'done' || discussion.state === 'failed') return false;

  const visibleSubSessionNames = new Set(context.visibleSubSessionNames ?? []);
  const matchesCurrentView = (sessionName?: string | null) => {
    if (!sessionName) return false;
    return sessionName === context.activeSession
      || sessionName === context.activeRootSession
      || visibleSubSessionNames.has(sessionName);
  };

  if (matchesCurrentView(discussion.mainSession)) return true;
  if (matchesCurrentView(discussion.initiatorSession)) return true;
  if (discussion.participantSessions?.some(matchesCurrentView)) return true;

  const hasScope = !!discussion.mainSession
    || !!discussion.initiatorSession
    || !!discussion.participantSessions?.length;
  return !hasScope;
}
