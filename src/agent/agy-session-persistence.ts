import { AGY_NATIVE_SESSION_STATE, AGY_SDK_PROVIDER_ID, AGY_NATIVE_START_NOT_ATTEMPTED, AGY_NATIVE_START_RECOVERY_HINT } from '../../shared/agy-agent.js';
import { PROVIDER_ERROR_CODES } from '../../shared/provider-error-codes.js';
import { isIncognitoSession } from '../../shared/session-incognito-types.js';
import { flushStore, getSession, upsertSession, listSessions, type SessionRecord } from '../store/session-store.js';

export function agyNativeStartNotAttemptedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code, recoverable: false,
    details: { [AGY_NATIVE_START_NOT_ATTEMPTED]: true } });
}

/** One local persistence barrier, not a native AG protocol or a fresh fallback. */
export async function persistAgyNativeSessionStart(
  name: string,
  expected: Pick<SessionRecord, 'sessionInstanceId' | 'runtimeEpoch' | 'providerSessionId' | 'providerResumeId' | 'createdAt'>,
  isCurrentRuntime: () => boolean,
): Promise<void> {
  const current = () => {
    const record = getSession(name);
    if (!isCurrentRuntime() || !record || record.agentType !== AGY_SDK_PROVIDER_ID
      || record.sessionInstanceId !== expected.sessionInstanceId || record.runtimeEpoch !== expected.runtimeEpoch
      || record.createdAt !== expected.createdAt || record.providerSessionId !== expected.providerSessionId
      || record.providerResumeId !== expected.providerResumeId) {
      throw agyNativeStartNotAttemptedError('AG start owner changed', PROVIDER_ERROR_CODES.CANCELLED);
    }
    return record;
  };
  const record = current();
  if (isIncognitoSession(record)) return;
  if (record.providerResumeId && listSessions().some((other) => other.name !== name
    && other.agentType === AGY_SDK_PROVIDER_ID && other.providerResumeId === record.providerResumeId)) {
    throw agyNativeStartNotAttemptedError('AG resume id belongs to another local session', PROVIDER_ERROR_CODES.CONFIG_ERROR);
  }
  if (!record.providerResumeId && record.agyNativeSessionState !== AGY_NATIVE_SESSION_STATE.UNSTARTED) {
    throw agyNativeStartNotAttemptedError(`AG conversation has no trusted resume id or unused proof. ${AGY_NATIVE_START_RECOVERY_HINT}`, PROVIDER_ERROR_CODES.CONFIG_ERROR);
  }
  upsertSession({ ...record, agyNativeSessionState: AGY_NATIVE_SESSION_STATE.STARTED });
  try {
    // Strict: a helper/unloaded store or a failed transaction is NOT a commit.
    await flushStore({ requireWrite: true });
  } catch {
    throw agyNativeStartNotAttemptedError('Cannot persist AG native start; no process was started', PROVIDER_ERROR_CODES.CONFIG_ERROR);
  }
  current(); // Stop/delete/recreate/rebind wins over a late commit completion.
}
