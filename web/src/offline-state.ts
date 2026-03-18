/**
 * Offline state handling for mobile/web.
 * - Persists last-known terminal frames in localStorage
 * - Queues messages sent while disconnected for replay on reconnect
 */

const LAST_FRAME_KEY = (session: string) => `deck_frame_${session}`;
const QUEUE_KEY = 'deck_offline_queue';

interface QueuedMessage {
  sessionName: string;
  text: string;
  queuedAt: number;
}

/** Save current terminal frame for a session */
export function saveLastFrame(sessionName: string, content: string): void {
  try {
    localStorage.setItem(LAST_FRAME_KEY(sessionName), content);
  } catch {
    // Storage full — ignore
  }
}

/** Load the last known terminal frame for a session */
export function loadLastFrame(sessionName: string): string | null {
  return localStorage.getItem(LAST_FRAME_KEY(sessionName));
}

/** Queue a message to be sent when reconnected */
export function queueMessage(sessionName: string, text: string): void {
  const queue = loadQueue();
  queue.push({ sessionName, text, queuedAt: Date.now() });
  saveQueue(queue);
}

/** Get all queued messages */
export function loadQueue(): QueuedMessage[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) as QueuedMessage[] : [];
  } catch {
    return [];
  }
}

function saveQueue(queue: QueuedMessage[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Storage full — ignore
  }
}

/** Clear the message queue */
export function clearQueue(): void {
  localStorage.removeItem(QUEUE_KEY);
}

/** Drain the queue — call onSend for each queued message then clear */
export async function drainQueue(
  onSend: (sessionName: string, text: string) => Promise<void>,
): Promise<void> {
  const queue = loadQueue();
  if (queue.length === 0) return;

  clearQueue();
  for (const msg of queue) {
    try {
      await onSend(msg.sessionName, msg.text);
    } catch {
      // Re-queue on failure
      queueMessage(msg.sessionName, msg.text);
    }
  }
}
