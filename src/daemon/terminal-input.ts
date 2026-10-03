import type { TerminalBackend } from '../agent/tmux.js';

/**
 * ConPTY writes are synchronous node-pty operations and must not wait behind
 * the process-send mutex.  tmux/WezTerm writes remain serialized because their
 * backend calls involve an external process or socket.
 */
export function terminalInputNeedsSessionMutex(backend: TerminalBackend): boolean {
  return backend !== 'conpty';
}
