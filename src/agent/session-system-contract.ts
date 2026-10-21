import { createHash } from 'node:crypto';

/**
 * Versioned identity for the daemon-assembled session contract. Providers keep
 * this short key in volatile state and compare it on every turn; the full
 * contract is still sent when the key changes. Bumping the version forces a
 * one-time reseed after a contract-format change even when text is unchanged.
 */
export const SESSION_SYSTEM_CONTRACT_VERSION = 1;

export function sessionSystemContractKey(text: string | undefined): string | undefined {
  const normalized = text?.trim();
  if (!normalized) return undefined;
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex');
  return `imcodes-session-contract:v${SESSION_SYSTEM_CONTRACT_VERSION}:${digest}`;
}

export function shouldInjectSessionSystemContract(
  previousKey: string | undefined,
  currentText: string | undefined,
): boolean {
  const currentKey = sessionSystemContractKey(currentText);
  return currentKey !== undefined && currentKey !== previousKey;
}
