/** Node-side privacy context. No session content is retained in this registry. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isIncognitoSession } from './session-incognito-types.js';
const privacy = new AsyncLocalStorage<boolean>();
const privateSessions = new Set<string>();
export function setSessionIncognito(name: string, enabled: boolean): void {
  if (enabled) privateSessions.add(name); else privateSessions.delete(name);
}
export function isIncognitoSessionName(name: unknown): boolean {
  return typeof name === 'string' && privateSessions.has(name);
}
export function inIncognitoContext(): boolean { return privacy.getStore() === true; }
export function withSessionPrivacy<T>(name: unknown, enabled: boolean, action: () => T): T {
  return privacy.run(enabled || isIncognitoSessionName(name), action);
}
/** Drop the entire log record, including Error.message/stack and printf arguments. */
export function suppressIncognitoLog(args: unknown[]): boolean {
  if (inIncognitoContext()) return true;
  const seen = new Set<object>();
  const privateValue = (value: unknown, depth: number): boolean => {
    if (isIncognitoSessionName(value)) return true;
    if (!value || typeof value !== 'object' || depth > 3 || seen.has(value)) return false;
    if (isIncognitoSession(value)) return true;
    seen.add(value);
    return Object.values(value).some(item => privateValue(item, depth + 1));
  };
  return args.some(value => privateValue(value, 0));
}
