/**
 * IM.codes must never initiate automatic context compaction.
 *
 * Providers may still compact internally (for example agy stream-json), and
 * explicit user-issued /compact commands remain supported. This policy only
 * gates compaction requests initiated by IM.codes itself.
 */
export const IMCODES_AUTOMATIC_COMPACTION_ENABLED = false as const;
