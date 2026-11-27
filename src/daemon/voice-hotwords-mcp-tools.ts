import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  VOICE_HOTWORDS_MAX_PROJECT_KEY_CHARS,
  VOICE_HOTWORDS_MAX_RAW_CHARS,
  VOICE_HOTWORDS_MCP_TOOL_NAME_LIST,
  VOICE_HOTWORDS_MCP_TOOLS,
  encodeVoiceHotwordProjectKey,
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
    'Read synced voice ASR hotwords for project or user scope.',
  [VOICE_HOTWORDS_MCP_TOOLS.SET]:
    'Write or merge synced voice ASR hotwords for project or user scope.',
};

const schemas: Record<VoiceHotwordsMcpToolName, z.ZodTypeAny> = {
  [VOICE_HOTWORDS_MCP_TOOLS.GET]: z.strictObject({
    scope: z.enum(['effective', 'project', 'user']).optional().describe('Scope (default effective).'),
    projectName: z.string().min(1).max(VOICE_HOTWORDS_MAX_PROJECT_KEY_CHARS).optional(),
    serverId: z.string().min(1).max(128).optional(),
  }),
  [VOICE_HOTWORDS_MCP_TOOLS.SET]: z.strictObject({
    scope: z.enum(['project', 'user']),
    hotwords: z.string().max(VOICE_HOTWORDS_MAX_RAW_CHARS).describe('Lines: "term" or "wrong => right".'),
    mode: z.enum(['merge', 'replace']).optional().describe('Default merge; replace overwrites.'),
    projectName: z.string().min(1).max(VOICE_HOTWORDS_MAX_PROJECT_KEY_CHARS).optional(),
    serverId: z.string().min(1).max(128).optional(),
  }),
};

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function optionalText(args: Record<string, unknown>, key: string): string | undefined {
  const val = args[key];
  return typeof val === 'string' && val.trim() ? val.trim() : undefined;
}

function errorResult(reason: string, message: string): ToolResult {
  return { status: 'error', reason, message };
}

function resolveTargetProjectKey(
  caller: McpRuntimeCaller,
  args: Record<string, unknown>,
): string | null {
  const rawProject = optionalText(args, 'projectName') ?? caller.projectName?.trim();
  if (!rawProject) return null;
  const rawServerId = optionalText(args, 'serverId') ?? caller.serverId?.trim() ?? null;
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
      const rawScope = args.scope;
      const scope = rawScope === undefined || rawScope === 'effective' || rawScope === 'project' || rawScope === 'user'
        ? (rawScope ?? 'effective')
        : null;
      if (!scope) {
        return errorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, 'scope must be effective, project, or user');
      }
      const projectKey = scope === 'user' ? null : resolveTargetProjectKey(caller, args);
      if (scope === 'project' && !projectKey) {
        return errorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, 'projectName is required when caller has no project context');
      }
      const res = await getVoiceHotwords(options, projectKey ?? undefined);
      if (res.status !== 'ok') return res as unknown as ToolResult;
      const userEntry = res.record.user;
      const projectEntry = projectKey ? (res.record.projects[projectKey] ?? { raw: '', updatedAt: 0 }) : null;
      const compiled = mergeVoiceHotwords({
        projectRaw: scope === 'user' ? '' : (projectEntry?.raw ?? ''),
        globalRaw: scope === 'project' ? '' : userEntry.raw,
      });
      return {
        status: 'ok',
        scope,
        projectKey,
        user: userEntry,
        ...(projectEntry ? { project: projectEntry } : {}),
        compiled,
        projectCount: Object.keys(res.record.projects).length,
      };
    },

    [VOICE_HOTWORDS_MCP_TOOLS.SET]: async (input) => {
      if (caller.isParticipantTurn) {
        return errorResult(MCP_ERROR_REASONS.SCOPE_FORBIDDEN, 'voice hotwords are owner-scoped and forbidden during participant turns');
      }
      const args = asRecord(input);
      const scope = args.scope === 'project' || args.scope === 'user' ? args.scope : null;
      if (!scope) {
        return errorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, 'scope must be project or user');
      }
      if (typeof args.hotwords !== 'string') {
        return errorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, 'hotwords must be a string');
      }
      if (args.hotwords.length > VOICE_HOTWORDS_MAX_RAW_CHARS) {
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
        projectKey = resolveTargetProjectKey(caller, args);
        if (!projectKey) {
          return errorResult(MCP_ERROR_REASONS.VALIDATION_FAILED, 'valid projectName/serverId is required for project scope');
        }
      }

      const payload = scope === 'user'
        ? { user: { raw: args.hotwords, mode } }
        : { project: { projectKey: projectKey!, raw: args.hotwords, mode } };
      const res = await setVoiceHotwords(payload, options);
      if (res.status !== 'ok') return res as unknown as ToolResult;

      const entry = scope === 'user'
        ? res.record.user
        : (res.record.projects[projectKey!] ?? { raw: '', updatedAt: 0 });
      const compiled = mergeVoiceHotwords({
        projectRaw: scope === 'project' ? entry.raw : '',
        globalRaw: scope === 'user' ? entry.raw : '',
      });
      return {
        status: 'ok',
        scope,
        projectKey,
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
      inputSchema: schemas[name],
    }, async (args: unknown) => toMcpCallResult(await handlers[name](args))));
  }
  return registered;
}
