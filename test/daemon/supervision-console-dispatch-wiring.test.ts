import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock WebSocket before importing ServerLink, matching test/daemon/server-link.test.ts.
const mockWsInstance = {
  send: vi.fn(),
  close: vi.fn(),
  addEventListener: vi.fn(),
  readyState: 1, // OPEN
};
const MockWebSocket = vi.fn(() => mockWsInstance);
MockWebSocket.OPEN = 1;
vi.stubGlobal('WebSocket', MockWebSocket);

vi.mock('../../src/util/daemon-status.js', () => ({
  recordDaemonServerLinkStatus: vi.fn(),
}));

import { ServerLink } from '../../src/daemon/server-link.js';
import { handleWebCommand } from '../../src/daemon/command-handler.js';
import { createProductionSupervisionConsoleBinding } from '../../src/daemon/supervision-console-binding.js';
import { SupervisionTaskRegistry } from '../../src/daemon/supervision-state-store.js';
import { SUPERVISION_TASK_CONSOLE_MSG } from '../../shared/supervision-task-console.js';
import logger from '../../src/util/logger.js';

/**
 * Reproduces the REAL production wiring from src/daemon/lifecycle.ts: one
 * `serverLink.onMessage` handler that falls through to `handleWebCommand`
 * (the same big `dispatchWebCommand` switch that only otherwise warned
 * "Unknown web command type"), and a SEPARATE `serverLink.onMessage`
 * registration owned by `createProductionSupervisionConsoleBinding` -- both
 * pushed onto the same `ServerLink`'s multi-subscriber handler list, exactly
 * as lifecycle.ts registers them (command-handler first, console binding
 * second). Every existing supervision-console test constructs its own fake
 * `SupervisionConsoleLink` and never goes through `handleWebCommand` or a
 * real `ServerLink` at all, so none of them could have caught this.
 */
describe('supervision task console wired through the real command-handler dispatch path', () => {
  let link: ServerLink;
  let dir: string;
  let databasePath: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWsInstance.readyState = 1;
    dir = mkdtempSync(join(tmpdir(), 'imcodes-console-wiring-'));
    databasePath = join(dir, 'supervision-state.sqlite');
    link = new ServerLink({ workerUrl: 'wss://test.workers.dev', serverId: 'srv-console', token: 'srv-token' });
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
  });

  afterEach(() => {
    link.disconnect();
    warnSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  function connectAndGetMessageHandler(): (raw: string) => void {
    link.connect();
    const handler = mockWsInstance.addEventListener.mock.calls.find(([type]) => type === 'message')?.[1] as
      | ((event: { data: string }) => void)
      | undefined;
    if (!handler) throw new Error('ServerLink did not register a message handler');
    return (raw: string) => handler({ data: raw });
  }

  it('delivers a real SNAPSHOT to the browser through the actual daemon dispatch chain, with no "Unknown web command type" warning', async () => {
    const registry = new SupervisionTaskRegistry({ dbPath: databasePath });
    expect(registry.createOrGet({
      taskId: 'task-wiring', projectName: 'alpha', objective: 'console wiring test',
      currentRevision: 'r1',
    }).ok).toBe(true);
    registry.close();

    const scope = { projectName: 'alpha', coordinatorSessionName: 'deck_alpha_brain' };
    // Exact production registration order from lifecycle.ts: the combined
    // capability/handleWebCommand handler is registered first, the console
    // binding second -- both onto the same ServerLink.
    link.onMessage((msg) => handleWebCommand(msg, link));
    const binding = createProductionSupervisionConsoleBinding({
      databasePath,
      serverLink: link,
      authorize: (candidate) => candidate.projectName === scope.projectName
        && candidate.coordinatorSessionName === scope.coordinatorSessionName,
    });

    const emit = connectAndGetMessageHandler();
    mockWsInstance.send.mockClear();
    warnSpy.mockClear();

    emit(JSON.stringify({
      type: SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE,
      subscriptionId: 'wiring-subscription',
      scope,
      afterEventId: null,
      reason: 'initial',
    }));
    await Promise.resolve();
    await Promise.resolve();

    const sent = mockWsInstance.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>);
    expect(sent).toContainEqual(expect.objectContaining({
      type: SUPERVISION_TASK_CONSOLE_MSG.SNAPSHOT,
      subscriptionId: 'wiring-subscription',
      scope,
      tasks: [expect.objectContaining({ taskId: 'task-wiring', currentRevision: 'r1' })],
    }));

    // The whole reason this task exists: a real, legitimate browser subscribe
    // must never fall through to the generic "Unknown web command type" warn.
    const unknownTypeWarnings = warnSpy.mock.calls.filter(([payload]) => (
      typeof payload === 'object' && payload !== null
      && (payload as Record<string, unknown>).type === SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE
    ));
    expect(unknownTypeWarnings).toEqual([]);

    binding.close();
  });

  it('acknowledges and unsubscribes through the real dispatch chain without "Unknown web command type" noise', async () => {
    const registry = new SupervisionTaskRegistry({ dbPath: databasePath });
    expect(registry.createOrGet({
      taskId: 'task-wiring-2', projectName: 'beta', objective: 'ack/unsubscribe wiring test',
      currentRevision: 'r1',
    }).ok).toBe(true);
    registry.close();

    const scope = { projectName: 'beta', coordinatorSessionName: 'deck_beta_brain' };
    link.onMessage((msg) => handleWebCommand(msg, link));
    const binding = createProductionSupervisionConsoleBinding({
      databasePath,
      serverLink: link,
      authorize: (candidate) => candidate.projectName === scope.projectName
        && candidate.coordinatorSessionName === scope.coordinatorSessionName,
    });

    const emit = connectAndGetMessageHandler();
    emit(JSON.stringify({
      type: SUPERVISION_TASK_CONSOLE_MSG.SUBSCRIBE,
      subscriptionId: 'ack-subscription', scope, afterEventId: null, reason: 'initial',
    }));
    await Promise.resolve();
    warnSpy.mockClear();

    emit(JSON.stringify({
      type: SUPERVISION_TASK_CONSOLE_MSG.ACK,
      subscriptionId: 'ack-subscription', scope, projectionVersion: 0,
    }));
    emit(JSON.stringify({
      type: SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE,
      subscriptionId: 'ack-subscription', scope,
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(binding.sessions.activeSubscriptionId(scope)).toBeUndefined();
    const unknownTypeWarnings = warnSpy.mock.calls.filter(([payload]) => (
      typeof payload === 'object' && payload !== null
      && ((payload as Record<string, unknown>).type === SUPERVISION_TASK_CONSOLE_MSG.ACK
        || (payload as Record<string, unknown>).type === SUPERVISION_TASK_CONSOLE_MSG.UNSUBSCRIBE)
    ));
    expect(unknownTypeWarnings).toEqual([]);

    binding.close();
  });
});
