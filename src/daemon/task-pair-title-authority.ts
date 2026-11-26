import { AUTHORIZATION_HEADER, SERVER_ID_HEADER } from '../../shared/http-header-names.js';
import { SHARED_MACHINE_AUTHORITY_HEADER } from '../../shared/shared-machine-authority.js';
import { TASK_PAIR_TITLE_AUTHORITY_PATH, TASK_PAIR_TITLE_AUTHORITY_TIMEOUT_MS, type TaskPairTitleTurn } from '../../shared/task-pair-title-access.js';
import { loadDaemonCredential, type DaemonCredential } from './machine-mcp-deps.js';
import { readBoundedText } from './machine-exec-client.js';

/** No cross-turn cache or client JWT decoding. Recheck the same origin after the network await. */
export async function resolveTaskPairTitleTurn(input: {
  postAuthorityHook: () => Promise<Record<string, unknown>>;
  sessionName: string;
  loadCredential?: () => Promise<DaemonCredential | null>;
  fetchImpl?: typeof fetch;
}): Promise<TaskPairTitleTurn> {
  const closed: TaskPairTitleTurn = { participantView: true };
  try {
    const answer = await input.postAuthorityHook();
    if (answer.ok === true && answer.required === false) return { participantView: false };
    if (answer.ok !== true || answer.required !== true || typeof answer.authority !== 'string' || !answer.authority) return closed;
    const credential = await (input.loadCredential ?? loadDaemonCredential)();
    if (!credential) return closed;
    const res = await (input.fetchImpl ?? fetch)(`${credential.serverUrl.replace(/\/+$/, '')}${TASK_PAIR_TITLE_AUTHORITY_PATH}?serverId=${encodeURIComponent(credential.serverId)}`, {
      headers: {
        [AUTHORIZATION_HEADER]: `Bearer ${credential.token}`,
        [SERVER_ID_HEADER]: credential.serverId,
        [SHARED_MACHINE_AUTHORITY_HEADER]: answer.authority,
      },
      signal: AbortSignal.timeout(TASK_PAIR_TITLE_AUTHORITY_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!res.ok) return closed;
    const body = await readBoundedText(res, 16_384);
    const actor = body ? JSON.parse(body) as Record<string, unknown> : null;
    if (!actor || actor.serverId !== credential.serverId || actor.sessionName !== input.sessionName
      || typeof actor.userId !== 'string' || !actor.userId || typeof actor.projectName !== 'string' || !actor.projectName) return closed;
    const current = await input.postAuthorityHook();
    if (current.ok !== true || current.required !== true || current.authority !== answer.authority) return closed;
    return { participantView: true, actor: { serverId: credential.serverId, userId: actor.userId, sessionName: input.sessionName, projectName: actor.projectName } };
  } catch { return closed; }
}
