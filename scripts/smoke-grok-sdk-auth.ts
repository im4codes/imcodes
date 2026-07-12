import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GrokSdkProvider } from '../src/agent/providers/grok-sdk.js';

if (process.env.GROK_ACP_AUTH_SMOKE !== '1') {
  console.log('[grok-auth-smoke] SKIP: set GROK_ACP_AUTH_SMOKE=1 with an already authenticated official Grok CLI');
} else {
  await runAuthenticatedSmoke();
}

let resumeId: string | undefined;

async function runTurn(provider: GrokSdkProvider, routeId: string, prompt: string): Promise<void> {
  await new Promise<void>(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('authenticated Grok smoke turn timed out')), 90_000);
    const offComplete = provider.onComplete((sessionId, message) => {
      if (sessionId !== routeId) return;
      clearTimeout(timer);
      offComplete();
      offError();
      const metadata = message.metadata as Record<string, unknown> | undefined;
      if (typeof metadata?.resumeId === 'string') resumeId = metadata.resumeId;
      resolve();
    });
    const offError = provider.onError((sessionId, error) => {
      if (sessionId !== routeId) return;
      clearTimeout(timer);
      offComplete();
      offError();
      reject(new Error(`${error.code}: ${error.message}`));
    });
    await provider.send(routeId, prompt).catch(reject);
  });
}

async function runAuthenticatedSmoke(): Promise<void> {
  const { GrokSdkProvider } = await import('../src/agent/providers/grok-sdk.js');
  const cwd = await mkdtemp(path.join(tmpdir(), 'imcodes-grok-smoke-'));
  try {
  const first = new GrokSdkProvider();
  await first.connect({});
  await first.createSession({ sessionKey: 'grok-auth-smoke-1', cwd, fresh: true });
  await runTurn(first, 'grok-auth-smoke-1', 'Reply with exactly READY and do not inspect files or run tools.');
  if (!resumeId) throw new Error('Grok did not return a provider resume id');
  await runTurn(first, 'grok-auth-smoke-1', '/compact');
  await first.disconnect();

  const restored = new GrokSdkProvider();
  await restored.connect({});
  await restored.createSession({ sessionKey: 'grok-auth-smoke-2', cwd, resumeId });
  await runTurn(restored, 'grok-auth-smoke-2', 'Reply with exactly RESTORED and do not inspect files or run tools.');
  await restored.disconnect();
  console.log('[grok-auth-smoke] PASS: prompt, compact, provider resume, and second prompt completed; content and credentials suppressed');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
