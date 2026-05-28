export interface NewUserGuidePref {
  pending: boolean;
  completed: boolean;
  disabled: boolean;
}

export interface TeamDiscussionGuidePref {
  dismissed: boolean;
}

export const DEFAULT_NEW_USER_GUIDE_PREF: NewUserGuidePref = {
  pending: false,
  completed: false,
  disabled: false,
};

export const DEFAULT_TEAM_DISCUSSION_GUIDE_PREF: TeamDiscussionGuidePref = {
  dismissed: false,
};

export function shouldMarkNewUserGuidePending(
  pref: NewUserGuidePref,
  sessionsLoaded: boolean,
  mainSessionCount: number,
  sawLoadedEmptySessions: boolean,
): boolean {
  return sessionsLoaded
    && sawLoadedEmptySessions
    && mainSessionCount > 0
    && !pref.pending
    && !pref.completed
    && !pref.disabled;
}

export function shouldShowNewUserGuidePrompt(
  pref: NewUserGuidePref,
  sessionsLoaded: boolean,
  mainSessionCount: number,
): boolean {
  return sessionsLoaded
    && mainSessionCount > 0
    && pref.pending
    && !pref.completed
    && !pref.disabled;
}

export function shouldShowTeamDiscussionGuide(
  pref: TeamDiscussionGuidePref,
  sessionsLoaded: boolean,
  mainSessionCount: number,
  blockedByModal: boolean,
): boolean {
  return sessionsLoaded
    && mainSessionCount > 0
    && !pref.dismissed
    && !blockedByModal;
}
