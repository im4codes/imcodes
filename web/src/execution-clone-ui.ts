/** Browser-local event used to reveal a newly accepted execution-clone run. */
export const EXECUTION_CLONE_GROUP_REVEAL_EVENT = 'imcodes:execution-clone-group-reveal' as const;

export interface ExecutionCloneGroupRevealDetail {
  ownerSessionName: string;
  parentRunId: string;
}

export function revealExecutionCloneGroup(detail: ExecutionCloneGroupRevealDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<ExecutionCloneGroupRevealDetail>(
    EXECUTION_CLONE_GROUP_REVEAL_EVENT,
    { detail },
  ));
}

export function onExecutionCloneGroupReveal(
  listener: (detail: ExecutionCloneGroupRevealDetail) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<ExecutionCloneGroupRevealDetail>).detail;
    if (!detail?.ownerSessionName || !detail.parentRunId) return;
    listener(detail);
  };
  window.addEventListener(EXECUTION_CLONE_GROUP_REVEAL_EVENT, handler);
  return () => window.removeEventListener(EXECUTION_CLONE_GROUP_REVEAL_EVENT, handler);
}
