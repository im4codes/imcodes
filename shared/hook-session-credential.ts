/**
 * The loopback hook server identifies a caller by a session NAME the caller writes (`x-imcodes-session`, or the body's `from`). A name
 * is not a secret: any agent process on the machine can write another session's name. For process sessions the daemon therefore hands
 * each launched process a random per-launch credential through its environment and requires it back whenever a request claims that
 * session's name. The credential never leaves the daemon's session store and the launched process's own environment.
 *
 * Residual (stated, not hidden): an agent that reads its OWN environment still holds its own credential, so it can act as itself - which
 * it already is. It cannot act as another session, because it never receives that session's credential. Sessions without a stored
 * credential (transport sessions that share one provider process, and process sessions launched before this field existed) keep the
 * name-only behaviour until they are relaunched.
 */
export const HOOK_SESSION_CREDENTIAL_ENV = 'IMCODES_HOOK_CREDENTIAL';
export const HOOK_SESSION_CREDENTIAL_HEADER = 'x-imcodes-hook-credential';
export const HOOK_SESSION_CREDENTIAL_ERROR = 'hook_session_credential_invalid';

/** Headers a local hook client attaches so the daemon can verify the session name it claims. Empty when the process has no credential. */
export function hookCredentialHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const credential = env[HOOK_SESSION_CREDENTIAL_ENV];
  return credential ? { [HOOK_SESSION_CREDENTIAL_HEADER]: credential } : {};
}
