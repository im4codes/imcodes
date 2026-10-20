import { createHash } from 'node:crypto';

/** SHA-256 (hex) of identity text exactly as given: the digest an explicitly provisioned Agent identity is reused by. */
export function identityContentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The digest a session record keeps INSTEAD of its rendered identity prompt: enough to tell "the identity changed" and
 * nothing else (the text is derived from the identity store, never stored with the session).
 */
export function identityPromptHash(prompt: string | undefined): string | undefined {
  const normalized = prompt?.trim();
  return normalized ? identityContentHash(normalized) : undefined;
}
