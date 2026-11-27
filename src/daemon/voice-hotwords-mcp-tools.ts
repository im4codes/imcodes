import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  VOICE_HOTWORDS_MAX_ENTRIES,
  VOICE_HOTWORDS_MAX_RAW_CHARS,
  VOICE_HOTWORDS_MAX_TERM_CHARS,
  VOICE_HOTWORDS_MCP_TOOL_NAME_LIST,
  VOICE_HOTWORDS_MCP_TOOLS,
  encodeVoiceHotwordProjectKey,
  entriesToVoiceHotwordRawText,
  getOwnDictValue,
  isValidVoiceHotwordProjectKey,
  mergeVoiceHotwords,
  type VoiceHotwordsMcpToolName,
} from '../../shared/voice-hotwords.js';
import { MCP_ERROR_REASONS } from '../../shared/memory-mcp-errors.js';
import { sanitizeMcpErrorMessage } from '../../shared/mcp-error-sanitize.js';
import type { McpRuntimeCaller } from './memory-mcp-caller.js';
import {
  voiceHotwordsMcpGet,
  voiceHotwordsMcpSet,
  type VoiceHotwordsMcpClientOptions,
} from './voice-hotwords-mcp-client.js';

type ToolResult = Record<string, unknown>;
type ToolHandler = (input?: unknown) => Promise<ToolResult>;

export interface VoiceHotwordsMcpToolDeps {
  voiceHotwordsClientOptions?: VoiceHotwordsMcpClientOptions;
  getVoiceHotwords?: typeof voiceHotwordsMcpGet;
  setVoiceHotwords?: typeof voiceHotwordsMcpSet;
}

const descriptions: Readonly<Record<VoiceHotwordsMcpToolName, string>> = {
  [VOICE_HOTWORDS_MCP_TOOLS.GET]:
    'Read synced voice ASR hotwords; project scope binds strictly to caller context.',
  [VOICE_HOTWORDS_MCP_TOOLS.SET]:
    'Write or merge synced voice ASR hotwords (supports plain terms and "wrong => right" aliases; project binds to caller).',
};

export const voiceHotwordsMcpSchemas: Record<VoiceHotwordsMcpToolName, z.ZodTypeAny> = {
  [VOICE_HOTWORDS_MCP_TOOLS.GET]: z.strictObject({
    scope: z.enum(['all', 'project', 'user']).optional().describe('Target scope (default all).'),
  }),
  [VOICE_HOTWORDS_MCP_TOOLS.SET]: z.strictObject({
    scope: z.enum(['project', 'user']),
    raw: z.string().max(VOICE_HOTWORDS_MAX_RAW_CHARS).optional().describe('Newline-separated terms/aliases; empty with replace clears.'),
    entries: z.array(z.string().max(VOICE_HOTWORDS_MAX_TERM_CHARS * 3)).max(VOICE_HOTWORDS_MAX_ENTRIES).optional()
      .describe('Alternative array of terms/aliases; empty with replace clears.'),
    mode: z.enum(['merge', 'replace']).optional().describe('Default merge; replace overwrites.'),
  }),
};

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function hasUnknownKey(args: Record<string, unknown>, allowed: readonly string[]): string | null {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(args)) {
    if (!allowedSet.has(key)) return key;
  }
  return null;
}

function errorResult(reason: string, message: string): ToolResult {
  return { status: 'error', reason, message };
}

/** Resolve project key strictly from trusted MCP caller identity (never caller args). */
function resolveCallerProjectKey(caller: McpRuntimeCaller): string | null {
  const rawProject = caller.projectName?.trim();
  if (!rawProject) return null;
  const rawServerId = caller.serverId?.trim() || null;
  const encoded = encodeVoiceHotwordProjectKey(rawProject, rawServerId);
  return encoded && isValidVoiceHotwordProjectKey(encoded) ? encoded : null;
}

function toMcpCallResult(result: ToolResult): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    ...(result.status === 'error' ? { isError: true } : {}),
  };
}

export function createVoiceHotwordsMcpToolHandlers(
  caller: McpRuntimeCaller,
  deps: VoiceHotwordsMcpToolDeps = {},
): Record<VoiceHotwordsMcpToolName, ToolHandler> {
  const options = deps.voiceHotwordsClientOptions ?? {};
  const getVoiceHotwords = deps.getVoiceHotwords ?? voiceHotwordsMcpGet;
  const setVoiceHotwords = deps.setVoiceHotwords ?? voiceHotwordsMcpSet;

  const handlers: Record<VoiceHotwordsMcpToolName, ToolHandler> = {
    [VOICE_HOTWORDS_MCP_TOOLS.GET]: async (input) => {
      if (caller.isParticipantTurn) {
        return errorResult(MCP_ERROR_REASONS.SCOPE_FORBIDDEN, 'voice hotwords are owner-scoped and forbidden during participant turns');
      }
      const args = asRecord(input);
      const extra = hasUnknownKey(args, ['scope']);
      if (extra) {
        return errorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, `unknown argument: ${extra}`);
      }
      const rawScope = args.scope;
      const scope = rawScope === undefined ? 'all' : rawScope === 'all' || rawScope === 'project' || rawScope === 'user' ? rawScope : null;
      if (!scope) {
        return errorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, 'scope must be all, project, or user');
      }

      const projectKey = scope === 'user' ? null : resolveCallerProjectKey(caller);
      if (scope === 'project' && !projectKey) {
        return errorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, 'project scope requires a caller bound to a project');
      }

      const res = await getVoiceHotwords(options, projectKey ?? undefined);
      if (res.status !== 'ok') return res as unknown as ToolResult;

      const userEntry = res.record.user;
      const projectEntry = projectKey
        ? (getOwnDictValue(res.record.projects, projectKey) ?? { raw: '', updatedAt: 0 })
        : null;

      if (scope === 'project') {
        return {
          status: 'ok',
          scope: 'project',
          projectKey,
          project: projectEntry,
          compiled: mergeVoiceHotwords({ projectRaw: projectEntry?.raw ?? '', globalRaw: '' }),
          projectCount: Object.keys(res.record.projects).length,
        };
      }
      if (scope === 'user') {
        return {
          status: 'ok',
          scope: 'user',
          user: userEntry,
          compiled: mergeVoiceHotwords({ projectRaw: '', globalRaw: userEntry.raw }),
          projectCount: Object.keys(res.record.projects).length,
        };
      }
      return {
        status: 'ok',
        scope: 'all',
        projectKey,
        user: userEntry,
        ...(projectEntry ? { project: projectEntry } : {}),
        compiled: mergeVoiceHotwords({ projectRaw: projectEntry?.raw ?? '', globalRaw: userEntry.raw }),
        projectCount: Object.keys(res.record.projects).length,
      };
    },

    [VOICE_HOTWORDS_MCP_TOOLS.SET]: async (input) => {
      if (caller.isParticipantTurn) {
        return errorResult(MCP_ERROR_REASONS.SCOPE_FORBIDDEN, 'voice hotwords are owner-scoped and forbidden during participant turns');
      }
      const args = asRecord(input);
      const extra = hasUnknownKey(args, ['scope', 'raw', 'entries', 'mode']);
      if (extra) {
        return errorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, `unknown argument: ${extra}`);
      }
      const scope = args.scope === 'project' || args.scope === 'user' ? args.scope : null;
      if (!scope) {
        return errorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, 'scope must be project or user');
      }

      const hasRaw = args.raw !== undefined;
      const hasEntries = args.entries !== undefined;
      if (hasRaw && hasEntries) {
        return errorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, 'provide either raw or entries, not both');
      }
      if (!hasRaw && !hasEntries) {
        return errorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, 'raw or entries is required');
      }

      let rawText: string;
      if (hasRaw) {
        if (typeof args.raw !== 'string') {
          return errorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, 'raw must be a string');
        }
        rawText = args.raw;
      } else {
        if (!Array.isArray(args.entries) || args.entries.some((e) => typeof e !== 'string')) {
          return errorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, 'entries must be an array of strings');
        }
        if (args.entries.length > VOICE_HOTWORDS_MAX_ENTRIES) {
          return errorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, `entries exceed ${VOICE_HOTWORDS_MAX_ENTRIES} items`);
        }
        rawText = entriesToVoiceHotwordRawText(args.entries as string[]);
      }

      if (rawText.length > VOICE_HOTWORDS_MAX_RAW_CHARS) {
        return errorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, `hotwords exceed ${VOICE_HOTWORDS_MAX_RAW_CHARS} characters`);
      }

      const mode: 'merge' | 'replace' | null = args.mode === undefined || args.mode === 'merge' || args.mode === 'replace'
        ? (args.mode ?? 'merge')
        : null;
      if (!mode) {
        return errorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, 'mode must be merge or replace');
      }

      let projectKey: string | null = null;
      if (scope === 'project') {
        projectKey = resolveCallerProjectKey(caller);
        if (!projectKey) {
          return errorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, 'project scope requires a caller bound to a project');
        }
      }

      const payload = scope === 'user'
        ? { scope: 'user' as const, raw: rawText, mode }
        : { scope: 'project' as const, projectKey: projectKey!, raw: rawText, mode };
      const res = await setVoiceHotwords(payload, options);
      if (res.status !== 'ok') return res as unknown as ToolResult;

      const entry = scope === 'user'
        ? res.record.user
        : (getOwnDictValue(res.record.projects, projectKey!) ?? { raw: '', updatedAt: 0 });
      const compiled = mergeVoiceHotwords({
        projectRaw: scope === 'project' ? entry.raw : '',
        globalRaw: scope === 'user' ? entry.raw : '',
      });
      return {
        status: 'ok',
        scope,
        ...(projectKey ? { projectKey } : {}),
        mode,
        entry,
        compiled,
      };
    },
  };

  const wrapped = {} as Record<VoiceHotwordsMcpToolName, ToolHandler>;
  for (const name of VOICE_HOTWORDS_MCP_TOOL_NAME_LIST) {
    wrapped[name] = async (input?: unknown) => {
      try {
        return await handlers[name](input);
      } catch (err) {
        return errorResult(
          MCP_ERROR_REASONS.INTERNAL_ERROR,
          sanitizeMcpErrorMessage(err instanceof Error ? err.message : String(err)),
        );
      }
    };
  }
  return wrapped;
}

export function registerVoiceHotwordsMcpTools(
  server: McpServer,
  caller: McpRuntimeCaller,
  deps: VoiceHotwordsMcpToolDeps = {},
): ReadonlyMap<string, RegisteredTool> {
  const handlers = createVoiceHotwordsMcpToolHandlers(caller, deps);
  const registered = new Map<string, RegisteredTool>();
  for (const name of VOICE_HOTWORDS_MCP_TOOL_NAME_LIST) {
    registered.set(name, server.registerTool(name, {
      description: descriptions[name],
      inputSchema: voiceHotwordsMcpSchemas[name],
    }, async (args: unknown) => toMcpCallResult(await handlers[name](args))));
  }
  return registered;
}
