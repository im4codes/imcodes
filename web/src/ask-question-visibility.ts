import { isSubSessionName } from './session-list-merge.js';

export type AskQuestionViewMode = 'chat' | 'terminal';

export interface AskQuestionSessionVisibilityState {
  chatObscured: boolean;
  isMobile: boolean;
  activeSession: string | null;
  defaultViewMode: AskQuestionViewMode;
  activeSessionViewMode?: AskQuestionViewMode;
  viewModes: Readonly<Record<string, AskQuestionViewMode>>;
  openSubSessionIds: ReadonlySet<string>;
  pinnedSubSessions?: ReadonlyArray<{ sessionName: string; viewMode: AskQuestionViewMode }>;
  hasMaximizedSubSession: boolean;
  subSessions: ReadonlyArray<{ id: string; sessionName: string }>;
  subSessionViewModes: Readonly<Record<string, AskQuestionViewMode>>;
}

/**
 * Returns true when the user is currently viewing `sessionName`'s chat timeline
 * so inline timeline selection can handle `ask.question` without popping up the modal.
 */
export function isAskQuestionSessionVisible(
  sessionName: string,
  state: AskQuestionSessionVisibilityState,
): boolean {
  if (!sessionName || state.chatObscured) return false;
  if (isSubSessionName(sessionName)) {
    const sub = state.subSessions.find((entry) => entry.sessionName === sessionName);
    if (sub && state.openSubSessionIds.has(sub.id)) {
      return (state.subSessionViewModes[sessionName] ?? 'chat') === 'chat';
    }
    const pinned = state.pinnedSubSessions?.find((entry) => entry.sessionName === sessionName);
    if (pinned) {
      return pinned.viewMode === 'chat';
    }
    return false;
  }
  if (state.activeSession !== sessionName) return false;
  if ((state.isMobile || state.hasMaximizedSubSession) && state.openSubSessionIds.size > 0) {
    return false;
  }
  if (state.activeSessionViewMode !== undefined) {
    return state.activeSessionViewMode === 'chat';
  }
  return (state.viewModes[sessionName] ?? state.defaultViewMode) === 'chat';
}
