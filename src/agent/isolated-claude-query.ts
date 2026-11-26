/**
 * Isolated one-shot Claude Agent SDK query: no tools, no persisted session, a
 * scratch cwd, a bounded env, and structured JSON-schema output. Used for
 * short side-computations (a capability audit, a generated task title) that
 * need a single model answer without any of the machinery a live agent
 * session carries (tmux, provider registry, timeline relay).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export type IsolatedClaudeQueryStream = AsyncIterable<SDKMessage> & { close?: () => void };
export type IsolatedClaudeQueryImplementation = (input: Parameters<typeof query>[0]) => IsolatedClaudeQueryStream;

// Do not clone the daemon environment: it routinely contains unrelated MCP,
// provider, deployment, and user secrets. Keep only process bootstrap values
// plus the narrowly-scoped Claude transport credential/configuration needed by
// the isolated query itself.
export const ISOLATED_CLAUDE_QUERY_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP',
  'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'NODE_EXTRA_CA_CERTS',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

export function buildIsolatedClaudeQueryEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(ISOLATED_CLAUDE_QUERY_ENV_ALLOWLIST.flatMap((key) => {
    const value = source[key];
    return typeof value === 'string' && value.length > 0 ? [[key, value]] : [];
  }));
}

export interface RunIsolatedClaudeQueryInput {
  prompt: string;
  outputSchema: Record<string, unknown>;
  queryImpl?: IsolatedClaudeQueryImplementation;
  timeoutMs: number;
  model?: string;
  /** Label used only for the timeout/ended error messages. */
  label: string;
}

/**
 * Runs one isolated query and returns its `structured_output`, or throws with
 * a message naming `label` on timeout, error, or a missing/failed result.
 * Callers decide how to treat a thrown error (this module never guesses a
 * fallback value).
 */
export async function runIsolatedClaudeQuery(input: RunIsolatedClaudeQueryInput): Promise<unknown> {
  const queryImpl = input.queryImpl ?? (query as IsolatedClaudeQueryImplementation);
  const cwd = await mkdtemp(join(tmpdir(), 'imcodes-isolated-query-'));
  const abortController = new AbortController();
  let timedOut = false;
  let stream: IsolatedClaudeQueryStream | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort(new Error(`${input.label} timed out`));
    try { stream?.close?.(); } catch { /* best-effort SDK cleanup */ }
  }, input.timeoutMs);
  timer.unref?.();
  try {
    stream = queryImpl({
      prompt: input.prompt,
      options: {
        cwd,
        env: buildIsolatedClaudeQueryEnvironment(),
        abortController,
        maxTurns: 1,
        tools: [],
        allowedTools: [],
        disallowedTools: ['*'],
        mcpServers: {},
        settingSources: [],
        skills: [],
        persistSession: false,
        permissionMode: 'dontAsk',
        canUseTool: async (_toolName, _input, permission) => ({
          behavior: 'deny',
          message: `${input.label} has no tool authority`,
          interrupt: true,
          toolUseID: permission.toolUseID,
        }),
        outputFormat: { type: 'json_schema', schema: input.outputSchema },
        ...(input.model ? { model: input.model } : {}),
      },
    });
    for await (const message of stream) {
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success' || message.is_error || message.structured_output === undefined) {
        throw new Error(`${input.label} returned no structured result`);
      }
      return message.structured_output;
    }
    throw new Error(timedOut ? `${input.label} timed out` : `${input.label} ended without a result`);
  } finally {
    clearTimeout(timer);
    try { stream?.close?.(); } catch { /* best-effort SDK cleanup */ }
    await rm(cwd, { recursive: true, force: true });
  }
}
