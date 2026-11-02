import { TASK_PAIR_DECISION_MSG, type TaskPairDecisionRecord } from '@shared/task-pair-decision.js';
export interface TaskPairDecisionReply { decisions: TaskPairDecisionRecord[]; revision: string; }
export interface TaskPairDecisionInput {
  taskId: string; type: typeof TASK_PAIR_DECISION_MSG.HISTORY | typeof TASK_PAIR_DECISION_MSG.FEEDBACK;
  round?: number; revision?: string; questionId?: string | null; optionId?: string; feedback?: string;
}
let send: ((input: TaskPairDecisionInput & { requestId: string }) => void) | undefined;
const pending = new Map<string, { resolve: (reply: TaskPairDecisionReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
export function bindTaskPairDecisions(next: NonNullable<typeof send>): () => void {
  send = next;
  return () => {
    if (send !== next) return;
    send = undefined;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Decision connection changed')); }
    pending.clear();
  };
}
export function requestTaskPairDecision(input: TaskPairDecisionInput, requestId: string = crypto.randomUUID()): Promise<TaskPairDecisionReply> {
  if (!send) return Promise.reject(new Error('Decision API unavailable; reconnect or upgrade daemon'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Decision request timed out; retry is safe')); }, 15_000);
    pending.set(requestId, { resolve, reject, timer });
    try { send!({ ...input, requestId }); } catch (cause) {
      clearTimeout(timer); pending.delete(requestId); reject(cause);
    }
  });
}
export function receiveTaskPairDecision(requestId: string, result: unknown): void {
  const item = pending.get(requestId);
  if (!item) return;
  clearTimeout(item.timer); pending.delete(requestId);
  const reply = result as { ok?: boolean; error?: string } & TaskPairDecisionReply;
  if (!reply?.ok || !Array.isArray(reply.decisions)) item.reject(new Error(reply?.error || 'Invalid decision response'));
  else item.resolve(reply);
}
