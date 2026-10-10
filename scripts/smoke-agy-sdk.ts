import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgySdkProvider } from '../src/agent/providers/agy-sdk.js';
import { fetchAgyUsageQuota } from '../src/agent/agy-usage-quota.js';
import { PROVIDER_ERROR_CODES } from '../src/agent/transport-provider.js';
import type { AgentMessage, MessageDelta, ToolCallEvent } from '../shared/agent-message.js';

interface TurnWaitResult {
  promise: Promise<AgentMessage[]>;
  cleanup: () => void;
}

function waitForCompletions(
  provider: AgySdkProvider,
  sessionId: string,
  expectedCount: number,
  timeoutMs: number,
  onDelta?: (delta: MessageDelta) => void,
): TurnWaitResult {
  let timer: NodeJS.Timeout | null = null;
  let offComplete: (() => void) | null = null;
  let offError: (() => void) | null = null;
  let offDelta: (() => void) | null = null;

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (offComplete) offComplete();
    if (offError) offError();
    if (offDelta) offDelta();
  };

  const promise = new Promise<AgentMessage[]>((resolve, reject) => {
    const received: AgentMessage[] = [];

    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${expectedCount} completion(s); received ${received.length}`));
    }, timeoutMs);

    offComplete = provider.onComplete((sId, message) => {
      if (sId !== sessionId) return;
      received.push(message);
      if (received.length >= expectedCount) {
        cleanup();
        resolve(received);
      }
    });

    offError = provider.onError((sId, error) => {
      if (sId !== sessionId) return;
      cleanup();
      reject(new Error(`Provider error: ${error.code} - ${error.message}`));
    });

    if (onDelta) {
      offDelta = provider.onDelta((sId, delta) => {
        if (sId === sessionId) {
          onDelta(delta);
        }
      });
    }
  });

  return { promise, cleanup };
}

async function main(): Promise<void> {
  const sessionKey = 'smoke-agy';
  const agentId = 'gemini-3.8-flash-low';
  let tempDir: string | undefined;
  const provider = new AgySdkProvider();

  let capturedResumeId: string | undefined;
  const allToolCalls: Array<{ sessionId: string; tool: ToolCallEvent }> = [];

  provider.onSessionInfo((sessionId, info) => {
    if (sessionId === sessionKey && info.resumeId) {
      capturedResumeId = info.resumeId;
    }
  });

  provider.onToolCall((sessionId, tool) => {
    allToolCalls.push({ sessionId, tool });
  });

  const onlyStep9 = process.argv.includes('--step=9') || process.env.SMOKE_STEP === '9';

  try {
    if (!onlyStep9) {
    // ── (1) Connect ──
    try {
      await provider.connect({});
      console.log('[Step 1] Connect: PASS');
    } catch (err) {
      console.error('[Step 1] Connect: FAIL', err);
      process.exitCode = 1;
      return;
    }

    // ── (2) List Models ──
    try {
      const modelList = await provider.listModels(true);
      const models = modelList.models ?? [];
      if (models.length === 0) {
        throw new Error(`Model list is empty: ${modelList.error ?? 'unknown error'}`);
      }
      const first3 = models.slice(0, 3).map((m) => m.id).join(', ');
      console.log(`[Step 2] List Models: PASS (count=${models.length}, first 3: ${first3})`);
    } catch (err) {
      console.error('[Step 2] List Models: FAIL', err);
      process.exitCode = 1;
      return;
    }

    // ── (3) Create Session ──
    let sid: string;
    try {
      tempDir = await mkdtemp(path.join(tmpdir(), 'agy-smoke-'));
      sid = await provider.createSession({
        sessionKey,
        cwd: tempDir,
        agentId,
      });
      console.log(`[Step 3] Create Session: PASS (sid=${sid}, cwd=${tempDir})`);
    } catch (err) {
      console.error('[Step 3] Create Session: FAIL', err);
      process.exitCode = 1;
      return;
    }

    // ── (4) Simple Turn & Streaming Deltas (PONG) ──
    try {
      const deltas: string[] = [];
      const waiter = waitForCompletions(provider, sid, 1, 120_000, (delta) => {
        if (delta.delta) deltas.push(delta.delta);
      });
      await provider.send(sid, 'Reply with exactly the word PONG and nothing else.');
      const [pongMsg] = await waiter.promise;
      if (!pongMsg.content.includes('PONG')) {
        throw new Error(`Expected completion to contain PONG, got: "${pongMsg.content}"`);
      }
      if (deltas.length === 0 || deltas.join('').trim().length === 0) {
        throw new Error(`Expected streaming deltas to be received, got ${deltas.length} deltas`);
      }
      console.log(`[Step 4] Simple Turn & Streaming: PASS (deltas=${deltas.length}, content="${pongMsg.content.trim()}")`);
    } catch (err) {
      console.error('[Step 4] Simple Turn & Streaming: FAIL', err);
      process.exitCode = 1;
      return;
    }

    // ── (5) Append Test: back to back messages without waiting (ONE, TWO) ──
    try {
      const waiter = waitForCompletions(provider, sid, 2, 120_000);
      await Promise.all([
        provider.send(sid, 'Reply with exactly: ONE'),
        provider.send(sid, 'Reply with exactly: TWO'),
      ]);
      const completions = await waiter.promise;
      if (completions.length !== 2) {
        throw new Error(`Expected 2 completions, got ${completions.length}`);
      }
      if (!completions[0].content.includes('ONE')) {
        throw new Error(`Expected first completion to contain "ONE", got: "${completions[0].content}"`);
      }
      if (!completions[1].content.includes('TWO')) {
        throw new Error(`Expected second completion to contain "TWO", got: "${completions[1].content}"`);
      }
      console.log(`[Step 5] Append Back-to-Back: PASS (c1="${completions[0].content.trim()}", c2="${completions[1].content.trim()}")`);
    } catch (err) {
      console.error('[Step 5] Append Back-to-Back: FAIL', err);
      process.exitCode = 1;
      return;
    }

    // ── (6) Tool Test (run_command & permissions) ──
    try {
      const toolStartIdx = allToolCalls.length;
      const waiter = waitForCompletions(provider, sid, 1, 120_000);
      await provider.send(sid, 'Use run_command to run: echo agy-smoke-ok  — then reply with its output only.');
      const [toolMsg] = await waiter.promise;
      const turnTools = allToolCalls.slice(toolStartIdx).map((e) => e.tool);
      const hasCompleteRunCommand = turnTools.some(
        (t) => t.status === 'complete' && t.name.toLowerCase().includes('run_command'),
      );
      if (!hasCompleteRunCommand) {
        throw new Error(
          `Expected at least one complete run_command tool call. Recorded tools: ${JSON.stringify(turnTools)}`,
        );
      }
      if (!toolMsg.content.includes('agy-smoke-ok')) {
        throw new Error(`Expected completion text to contain "agy-smoke-ok", got: "${toolMsg.content}"`);
      }
      console.log(`[Step 6] Tool Execution: PASS (toolCalls=${turnTools.length}, output="${toolMsg.content.trim()}")`);
    } catch (err) {
      console.error('[Step 6] Tool Execution: FAIL', err);
      process.exitCode = 1;
      return;
    }

    // ── (7) Resume Test ──
    try {
      if (!capturedResumeId) {
        throw new Error('No resumeId was captured from onSessionInfo in earlier steps');
      }
      await provider.endSession(sid);
      const restoredSid = await provider.createSession({
        sessionKey,
        cwd: tempDir,
        agentId,
        resumeId: capturedResumeId,
      });
      const waiter = waitForCompletions(provider, restoredSid, 1, 120_000);
      await provider.send(
        restoredSid,
        'What was the exact output of the echo command earlier? one short sentence',
      );
      const [resumeMsg] = await waiter.promise;
      if (!resumeMsg.content.includes('agy-smoke-ok')) {
        throw new Error(`Expected response to mention "agy-smoke-ok", got: "${resumeMsg.content}"`);
      }
      console.log(`[Step 7] Session Resume: PASS (resumeId=${capturedResumeId}, answer="${resumeMsg.content.trim()}")`);
    } catch (err) {
      console.error('[Step 7] Session Resume: FAIL', err);
      process.exitCode = 1;
      return;
    }

    // ── (8) Cancel Test & Resume after Cancel ──
    try {
      let cancelErrorCode: string | null = null;
      let cancelErrorReceived = false;
      const offError = provider.onError((sId, error) => {
        if (sId === sid && error.code === PROVIDER_ERROR_CODES.CANCELLED) {
          cancelErrorCode = error.code;
          cancelErrorReceived = true;
        }
      });

      try {
        await provider.send(
          sid,
          'Count slowly from 1 to 200, one number per line, using run_command with sleep 1 between each',
        );
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        await provider.cancel(sid);
        if (!cancelErrorReceived || cancelErrorCode !== PROVIDER_ERROR_CODES.CANCELLED) {
          throw new Error(
            `Expected onError with code CANCELLED after calling provider.cancel(), received: ${cancelErrorCode}`,
          );
        }
      } finally {
        offError();
      }

      const waiter = waitForCompletions(provider, sid, 1, 120_000);
      await provider.send(sid, 'Reply with exactly: BACK');
      const [backMsg] = await waiter.promise;
      if (!backMsg.content.includes('BACK')) {
        throw new Error(`Expected resume after cancel to contain "BACK", got: "${backMsg.content}"`);
      }
      console.log(`[Step 8] Cancel & Resume: PASS (code=${cancelErrorCode}, answer="${backMsg.content.trim()}")`);
    } catch (err) {
      console.error('[Step 8] Cancel & Resume: FAIL', err);
      process.exitCode = 1;
      return;
    }
    }

    // ── (9) Quota Probe ──
    try {
      const quota = await fetchAgyUsageQuota({ forceRefresh: true });
      const groupsCount = quota?.quotaMeta?.groups?.length ?? 0;
      if (!quota || groupsCount < 1) {
        throw new Error(`Expected at least 1 quota group parsed, got ${groupsCount}`);
      }
      console.log(`[Step 9] Quota Probe: PASS (groups=${groupsCount}, label="${quota.quotaLabel}")`);
    } catch (err) {
      console.error('[Step 9] Quota Probe: FAIL', err);
      process.exitCode = 1;
      return;
    }

    console.log(onlyStep9 ? '\nSmoke test step 9 (Quota Probe) PASSED!' : '\nAll 9 smoke test steps PASSED!');
  } finally {
    try {
      await provider.disconnect();
    } catch (err) {
      console.error('Failed to cleanly disconnect provider:', err);
    }
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (err) {
        console.error('Failed to clean up temp dir:', err);
      }
    }
  }
}

await main();
