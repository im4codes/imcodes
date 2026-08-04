/**
 * Protocol bounds for terminal frames — shared by daemon, server and web.
 *
 * Lives in the root `shared/` tree, not under `src/shared/`, because web imports
 * these as VALUES. A type-only import across that boundary is erased at build
 * time and therefore harmless; a value import is not — it would pull daemon
 * source into the web bundle and depends on the daemon tree being present in the
 * Docker image. See CLAUDE.md, "Shared code between daemon, server, and web".
 */

/**
 * Hard ceiling on how many terminal rows any single frame may describe.
 *
 * Both the producer and the consumer grow a line array to match `rows` (and to
 * reach the largest `lines[i]` index) with an unbounded `while (…) push('')`.
 * `rows` comes off the wire, so one malformed or corrupted frame would spin
 * that loop allocating until the tab dies — and because the loop is synchronous
 * the page cannot even service a reload while it runs. No real pane is anywhere
 * near this tall; the bound exists purely so a bad value fails small.
 */
export const TERMINAL_MAX_ROWS = 1024;

/** Companion bound for columns; a frame's width feeds the same string building. */
export const TERMINAL_MAX_COLS = 2048;
