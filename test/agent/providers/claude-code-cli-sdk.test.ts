import { chmod, mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_CLI_SDK_ARGS,
  ClaudeCodeCliSdkProvider,
  parseClaudeCliStreamJsonLine,
} from '../../../src/agent/providers/claude-code-cli-sdk.js';
import { normalizeProviderPayload } from '../../../src/agent/transport-provider.js';

describe('Claude CLI stream-json SDK provider', () => {
  it('parses JSONL frames, nested deltas and ignores diagnostics/empty lines', () => {
    expect(parseClaudeCliStreamJsonLine('')).toBeNull();
    expect(parseClaudeCliStreamJsonLine('warning: diagnostic')).toBeNull();
    expect(parseClaudeCliStreamJsonLine('[]')).toBeNull();
    expect(parseClaudeCliStreamJsonLine(JSON.stringify({
      type: 'stream_event',
      session_id: 's-1',
      event: { delta: { text: 'Hel' } },
    }))).toMatchObject({ type: 'stream_event', session_id: 's-1' });
    expect(parseClaudeCliStreamJsonLine(JSON.stringify({ type: 'result', result: 'Hello' }))).toEqual({ type: 'result', result: 'Hello' });
  });

  it('streams deltas, captures the CLI session id and completes from a real child process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-cc-cli-sdk-'));
    const script = join(dir, 'fake-claude');
    await writeFile(script, `#!/bin/sh
printf '%s\\n' '{"type":"system","session_id":"remote-session"}'
printf '%s\\n' '{"type":"stream_event","event":{"delta":{"text":"Hel"}}}'
printf '%s\\n' '{"type":"stream_event","event":{"delta":{"text":"lo"}}}'
printf '%s\\n' '{"type":"result","result":"Hello"}'
`, 'utf8');
    await chmod(script, 0o755);
    try {
      const provider = new ClaudeCodeCliSdkProvider();
      expect(provider.id).toBe('claude-code-cli-sdk');
      expect(CLAUDE_CODE_CLI_SDK_ARGS).toContain('--permission-mode');
      expect(CLAUDE_CODE_CLI_SDK_ARGS).toContain('bypassPermissions');
      await provider.connect({ binary: script });
      const deltas: string[] = [];
      const infos: string[] = [];
      const done = new Promise<{ content: string }>((resolve, reject) => {
        provider.onDelta((_id, delta) => deltas.push(delta.delta));
        provider.onSessionInfo((_id, info) => { if (info.resumeId) infos.push(info.resumeId); });
        provider.onComplete((_id, message) => resolve({ content: message.content }));
        provider.onError((_id, error) => reject(new Error(error.message)));
      });
      const id = await provider.createSession({ sessionKey: 'local-session', cwd: dir });
      await provider.send(id, 'say hello');
      await expect(done).resolves.toEqual({ content: 'Hello' });
      expect(deltas).toEqual(['Hel', 'lo']);
      expect(infos).toContain('remote-session');
      await provider.disconnect();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('delivers normalized session and turn context to the CLI while keeping slash controls clean', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-cc-cli-context-'));
    const script = join(dir, 'fake-claude');
    await writeFile(script, `#!/bin/sh
IFS= read -r line
printf '%s' "$line" > "$PWD/input.jsonl"
printf '%s\\n' '{"type":"result","result":"ok"}'
`, 'utf8');
    await chmod(script, 0o755);
    try {
      const provider = new ClaudeCodeCliSdkProvider();
      await provider.connect({ binary: script });
      const done = new Promise<void>((resolve, reject) => {
        provider.onComplete(() => resolve());
        provider.onError((_id, error) => reject(new Error(error.message)));
      });
      const payload = normalizeProviderPayload('hello context');
      payload.sessionSystemText = 'stable session guidance';
      payload.turnSystemText = 'turn-specific MCP guidance';
      payload.context.sessionSystemText = payload.sessionSystemText;
      payload.context.turnSystemText = payload.turnSystemText;
      const id = await provider.createSession({ sessionKey: 'context-session', cwd: dir });
      await provider.send(id, payload);
      await expect(done).resolves.toBeUndefined();
      const frame = JSON.parse(await readFile(join(dir, 'input.jsonl'), 'utf8')) as { message?: { content?: string } };
      expect(frame.message?.content).toContain('stable session guidance');
      expect(frame.message?.content).toContain('turn-specific MCP guidance');
      expect(frame.message?.content).toContain('hello context');
      const slashDone = new Promise<void>((resolve, reject) => {
        provider.onComplete(() => resolve());
        provider.onError((_id, error) => reject(new Error(error.message)));
      });
      await provider.send(id, '/compact');
      await expect(slashDone).resolves.toBeUndefined();
      const slashFrame = JSON.parse(await readFile(join(dir, 'input.jsonl'), 'utf8')) as { message?: { content?: string } };
      expect(slashFrame.message?.content).toBe('/compact');
      await provider.disconnect();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('re-sends stable context after a child failure before input acceptance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-cc-cli-retry-'));
    const script = join(dir, 'fake-claude');
    await writeFile(script, `#!/bin/sh
IFS= read -r line
count=0
[ -f "$PWD/count" ] && count=$(cat "$PWD/count")
count=$((count + 1)); printf '%s' "$count" > "$PWD/count"
printf '%s' "$line" > "$PWD/input.jsonl"
[ "$count" -eq 1 ] && exit 1
printf '%s\\n' '{"type":"result","result":"retry-ok"}'
`, 'utf8');
    await chmod(script, 0o755);
    try {
      const provider = new ClaudeCodeCliSdkProvider();
      await provider.connect({ binary: script });
      const firstError = new Promise<void>((resolve) => provider.onError(() => resolve()));
      const id = await provider.createSession({ sessionKey: 'retry-session', cwd: dir });
      const payload = normalizeProviderPayload('retry context');
      payload.sessionSystemText = 'stable retry guidance';
      payload.turnSystemText = 'retry MCP guidance';
      payload.context.sessionSystemText = payload.sessionSystemText;
      payload.context.turnSystemText = payload.turnSystemText;
      await provider.send(id, payload);
      await expect(firstError).resolves.toBeUndefined();
      const secondDone = new Promise<void>((resolve, reject) => {
        provider.onComplete(() => resolve());
        provider.onError((_id, error) => reject(new Error(error.message)));
      });
      await provider.send(id, payload);
      await expect(secondDone).resolves.toBeUndefined();
      const frame = JSON.parse(await readFile(join(dir, 'input.jsonl'), 'utf8')) as { message?: { content?: string } };
      expect(frame.message?.content).toContain('stable retry guidance');
      expect(frame.message?.content).toContain('retry MCP guidance');
      await provider.disconnect();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('converges a result-only stream into final message content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-cc-cli-result-only-'));
    const script = join(dir, 'fake-claude');
    await writeFile(script, `#!/bin/sh
printf '%s\\n' '{"type":"result","result":"result-only-content"}'
`, 'utf8');
    await chmod(script, 0o755);
    try {
      const provider = new ClaudeCodeCliSdkProvider();
      await provider.connect({ binary: script });
      const done = new Promise<string>((resolve, reject) => {
        provider.onComplete((_id, message) => resolve(message.content));
        provider.onError((_id, error) => reject(new Error(error.message)));
      });
      const id = await provider.createSession({ sessionKey: 'result-only-session', cwd: dir });
      await provider.send(id, 'result only');
      await expect(done).resolves.toBe('result-only-content');
      await provider.disconnect();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('filters ambient unrelated secrets while preserving explicit Claude env in a real child process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imcodes-cc-cli-env-'));
    const script = join(dir, 'fake-claude');
    await writeFile(script, `#!/bin/sh
env > "$PWD/env.txt"
printf '%s\\n' '{"type":"result","result":"env-ok"}'
`, 'utf8');
    await chmod(script, 0o755);
    const previousOpenAi = process.env.OPENAI_API_KEY;
    const previousGemini = process.env.GEMINI_API_KEY;
    const previousSecret = process.env.UNRELATED_SENTINEL_SECRET;
    process.env.OPENAI_API_KEY = 'openai-sentinel';
    process.env.GEMINI_API_KEY = 'gemini-sentinel';
    process.env.UNRELATED_SENTINEL_SECRET = 'unrelated-sentinel';
    try {
      const provider = new ClaudeCodeCliSdkProvider();
      await provider.connect({ binary: script, env: { ANTHROPIC_BASE_URL: 'https://claude.example.test' } });
      const done = new Promise<void>((resolve, reject) => {
        provider.onComplete(() => resolve());
        provider.onError((_id, error) => reject(new Error(error.message)));
      });
      const id = await provider.createSession({ sessionKey: 'env-isolation-session', cwd: dir });
      await provider.send(id, 'check env');
      await expect(done).resolves.toBeUndefined();
      const childEnv = await readFile(join(dir, 'env.txt'), 'utf8');
      expect(childEnv).toContain('ANTHROPIC_BASE_URL=https://claude.example.test');
      expect(childEnv).not.toContain('OPENAI_API_KEY=');
      expect(childEnv).not.toContain('GEMINI_API_KEY=');
      expect(childEnv).not.toContain('UNRELATED_SENTINEL_SECRET=');
      await provider.disconnect();
    } finally {
      if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousOpenAi;
      if (previousGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previousGemini;
      if (previousSecret === undefined) delete process.env.UNRELATED_SENTINEL_SECRET; else process.env.UNRELATED_SENTINEL_SECRET = previousSecret;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
