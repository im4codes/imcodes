/**
 * The daemon's live ServerLink, for code that is not handed one (MCP tools, the recycler, a half-made session being discarded).
 *
 * It also keeps the one thing a plain `serverLink.send` cannot promise: that the server hears a sub-session was closed. A close that
 * happens while the link is down is remembered (bounded, newest wins) and replayed when the link next opens, so the server stamps
 * `closed_at` and every browser drops the row instead of showing a session that no longer exists.
 */

export interface ActiveServerLink {
  send(msg: object): void;
  /** Present on the real ServerLink: false when the message was dropped (socket not open). */
  trySend?(msg: unknown): boolean;
  isConnected?(): boolean;
}

export interface SubSessionClosedNotice {
  type: 'subsession.closed';
  id: string;
  sessionName: string;
}

/** More than this many unsent notices means the daemon was offline for a very long time; the server's own sync reconciles the rest. */
const PENDING_NOTICE_LIMIT = 200;

let activeLink: ActiveServerLink | null = null;
const pendingNotices = new Map<string, SubSessionClosedNotice>();

export function setActiveServerLink(link: ActiveServerLink | null): void {
  activeLink = link;
}

export function getActiveServerLink(): ActiveServerLink | null {
  return activeLink;
}

function deliver(link: ActiveServerLink, message: SubSessionClosedNotice): boolean {
  if (link.isConnected && !link.isConnected()) return false;
  try {
    if (link.trySend) return link.trySend(message);
    link.send(message);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tell the server a sub-session was closed. Returns true when the message went out now; false when it was kept for the next
 * connection (or when there is no link at all).
 */
export function notifySubSessionClosed(notice: SubSessionClosedNotice, link: ActiveServerLink | null = activeLink): boolean {
  if (link && deliver(link, notice)) {
    pendingNotices.delete(notice.sessionName);
    return true;
  }
  pendingNotices.delete(notice.sessionName);
  pendingNotices.set(notice.sessionName, notice);
  while (pendingNotices.size > PENDING_NOTICE_LIMIT) {
    const oldest = pendingNotices.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    pendingNotices.delete(oldest);
  }
  return false;
}

/** Replay every remembered notice over a freshly opened link. Returns how many were sent. */
export function flushPendingSubSessionClosedNotices(link: ActiveServerLink | null = activeLink): number {
  if (!link) return 0;
  let sent = 0;
  for (const [name, notice] of [...pendingNotices]) {
    if (!deliver(link, notice)) break;
    pendingNotices.delete(name);
    sent += 1;
  }
  return sent;
}

export function pendingSubSessionClosedNoticeCount(): number {
  return pendingNotices.size;
}

export function resetActiveServerLinkForTests(): void {
  activeLink = null;
  pendingNotices.clear();
}
