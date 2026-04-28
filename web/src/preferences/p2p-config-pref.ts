import { isP2pSavedConfig, type P2pSavedConfig } from '@shared/p2p-modes.js';
import { parseJsonValue } from '../hooks/usePref.js';

export interface P2pRootSubSessionRef {
  sessionName: string;
  parentSession?: string | null;
}

export function parseP2pSavedConfig(raw: unknown): P2pSavedConfig | null {
  return parseJsonValue<P2pSavedConfig>(raw, (value) => isP2pSavedConfig(value) ? value : null);
}

export function serializeP2pSavedConfig(config: P2pSavedConfig): string {
  return JSON.stringify(config);
}

export function p2pSubSessionParentSignature(subSessions: readonly P2pRootSubSessionRef[]): string {
  return subSessions
    .map((sub) => `${sub.sessionName}\u0000${sub.parentSession ?? ''}`)
    .join('\u0001');
}

export function resolveP2pRootSession(
  activeSession: string | null | undefined,
  subSessions: readonly P2pRootSubSessionRef[],
): string {
  const activeSub = subSessions.find((sub) => sub.sessionName === activeSession);
  return activeSub?.parentSession || activeSession || '';
}
