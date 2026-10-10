/**
 * The pair each session was last messaged about (in memory). A session in
 * several pairs usually answers the message it just got, so its plain output
 * is progress on that pair and not on every pair it belongs to, and its next
 * turn runs in that pair's workspace (turn-cwd.ts).
 *
 * Kept apart from delivery.ts, which pulls in the session manager: the turn
 * path of a transport runtime reads the focus and must not import that cycle.
 */
const lastMessagedTask = new Map<string, string>();

export function noteTaskPairFocus(sessionName: string, taskId: string): void {
  lastMessagedTask.set(sessionName, taskId);
}

export function taskPairFocusOf(sessionName: string): string | undefined {
  return lastMessagedTask.get(sessionName);
}

export function resetTaskPairFocusForTests(): void {
  lastMessagedTask.clear();
}
