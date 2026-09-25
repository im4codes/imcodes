/**
 * The longest text the composer sends inline. Anything longer is uploaded as
 * a file attachment and referenced from the message instead, so the chat
 * timeline and the agent's turn carry a short message plus a file rather than
 * a wall of text. One rule for every way long text enters a message -- a
 * paste, a voice-notepad transcript -- so the same text is never inline from
 * one path and a file from another.
 */
export const INLINE_PASTE_TEXT_CHAR_LIMIT = 1200;
