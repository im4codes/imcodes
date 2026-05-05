import { describe, expect, it } from 'vitest';
import { __testing__ } from '../../src/context/summary-compressor.js';

const { classifyCompressionError } = __testing__;

/**
 * Regression: missing-agent-CLI errors must classify as PERMANENT (not retryable).
 *
 * Real-world hit: 213 (`big@172.16.253.213`) ran imcodes daemon configured with
 * `claude-code-sdk` as the primary compression backend, but had no `claude` CLI
 * installed. The Anthropic Claude Agent SDK threw
 *   "Claude Code native binary not found at claude. Please ensure Claude Code
 *    is installed via native installer or specify a valid path with
 *    options.pathToClaudeCodeExecutable."
 * Without classification, this fell through to the default `transient` branch
 * and triggered 3 retries × 1-8 s = up to ~27 s of wasted active time per
 * compression call. With the next materialization tick at 10 s, the
 * compression queue stayed `active=true, queued>=1, idle=false` indefinitely.
 *
 * That made `getCompressionQueueState().idle` permanently false, which made
 * the daemon-upgrade gate (`if (!compressionState.idle) block`) reject every
 * server-pushed upgrade. The daemon was thus pinned at an old version that
 * also had a phantom-SIGTERM bug, producing a 13-second restart loop and a
 * 4-hour outage on host 213 before manual intervention.
 *
 * Fix locked here: an agent-CLI-missing error MUST be permanent. The retry
 * loop fails fast, the circuit breaker opens after one tick, control falls
 * through to the backup backend (then local fallback), and the compression
 * lane releases in <50 ms instead of holding for tens of seconds.
 */
describe('classifyCompressionError — agent CLI missing is permanent', () => {
  it.each([
    {
      name: 'Claude Code native binary not found (raw Anthropic SDK)',
      err: new ReferenceError(
        'Claude Code native binary not found at claude. Please ensure Claude Code '
        + 'is installed via native installer or specify a valid path with '
        + 'options.pathToClaudeCodeExecutable.',
      ),
    },
    {
      name: 'Codex binary not found (imcodes provider wrapper)',
      err: new Error('Codex binary not found: spawn codex ENOENT'),
    },
    {
      name: 'Cursor binary not found (imcodes provider wrapper)',
      err: new Error('Cursor binary not found: ENOENT'),
    },
    {
      name: 'spawn ENOENT from Node child_process',
      err: new Error('spawn claude ENOENT'),
    },
    {
      name: 'spawn ENOENT for a different agent name',
      err: new Error('spawn /usr/local/bin/qwen ENOENT'),
    },
    {
      name: 'shell-level command not found',
      err: new Error('claude: command not found'),
    },
    {
      name: 'PROVIDER_NOT_FOUND error code from imcodes shared taxonomy',
      err: new Error('PROVIDER_NOT_FOUND: gemini binary missing'),
    },
  ])('classifies "$name" as permanent (agent_missing)', ({ err }) => {
    const c = classifyCompressionError(err);
    expect(c.retryable).toBe(false);
    expect(c.code).toBe('agent_missing');
  });

  it('does NOT misclassify legitimate transient errors as agent_missing', () => {
    expect(classifyCompressionError(new Error('socket timeout while reading')))
      .toEqual({ retryable: true, code: 'timeout' });
    expect(classifyCompressionError(new Error('connection reset by peer')))
      .toEqual({ retryable: true, code: 'transient' });
    expect(classifyCompressionError(new Error('empty response from provider')))
      .toEqual({ retryable: true, code: 'empty_response' });
  });

  it('still classifies auth/quota errors permanently (regression on existing rules)', () => {
    expect(classifyCompressionError(new Error('Unauthorized')))
      .toEqual({ retryable: false, code: 'auth' });
    expect(classifyCompressionError(new Error('rate limit exceeded')))
      .toEqual({ retryable: false, code: 'quota' });
  });

  it('does NOT match strings that merely mention "binary" without "not found"', () => {
    // Defensive: ensure we don't catch e.g. legitimate base64 binary payloads
    // or "binary" appearing in unrelated error text. Only the "not found"
    // shapes count.
    const c = classifyCompressionError(new Error('binary content too large for prompt'));
    expect(c.code).not.toBe('agent_missing');
  });
});
