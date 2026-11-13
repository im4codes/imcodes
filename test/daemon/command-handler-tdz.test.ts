import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

describe('command-handler module initialization / TDZ invariants', () => {
  it('keeps all static imports and module-level bindings hoisted above functions and avoids cron-executor static cycle', () => {
    const filePath = resolve(import.meta.dirname, '../../src/daemon/command-handler.ts');
    const source = readFileSync(filePath, 'utf8');
    const sf = ts.createSourceFile('command-handler.ts', source, ts.ScriptTarget.Latest, true);

    let firstFunctionLine = Infinity;
    const midFileImports: number[] = [];
    const postFunctionBindings: Array<{ line: number; text: string }> = [];
    let importsCronExecutorStatically = false;

    for (const st of sf.statements) {
      const line = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1;
      if (ts.isImportDeclaration(st)) {
        if (st.moduleSpecifier.getText(sf).includes('cron-executor')) {
          importsCronExecutorStatically = true;
        }
        if (firstFunctionLine < Infinity) {
          midFileImports.push(line);
        }
      } else if (ts.isFunctionDeclaration(st)) {
        firstFunctionLine = Math.min(firstFunctionLine, line);
      } else if ((ts.isVariableStatement(st) || ts.isClassDeclaration(st)) && line > firstFunctionLine) {
        postFunctionBindings.push({ line, text: st.getText(sf).split('\n')[0] ?? '' });
      }
    }

    expect(midFileImports).toEqual([]);
    expect(postFunctionBindings).toEqual([]);
    expect(importsCronExecutorStatically).toBe(false);
  });

  it('loads dynamically after cron-executor and runs clear/handoff relaunch paths without error', async () => {
    // Structural hoisting + cycle guard above eliminates the circular static edge and mid-file
    // imports; this smoke check verifies dynamic module load + clear/handoff execution end-to-end.
    vi.resetModules();

    const launchTransportSession = vi.fn(async () => undefined);
    const relaunchSessionWithSettings = vi.fn(async () => undefined);
    const stopTransportRuntimeSession = vi.fn(async () => undefined);

    vi.doMock('../../src/agent/session-manager.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/agent/session-manager.js')>('../../src/agent/session-manager.js');
      return {
        ...actual,
        launchTransportSession,
        relaunchSessionWithSettings,
        stopTransportRuntimeSession,
      };
    });

    try {
      // Import cron-executor first (reverse direction of the old static cycle), then dynamically import command-handler.
      const cronExecutor = await import('../../src/daemon/cron-executor.js');
      expect(typeof cronExecutor.executeCronJob).toBe('function');

      const commandHandler = await import('../../src/daemon/command-handler.js');
      expect(typeof commandHandler.clearTransportConversation).toBe('function');
      expect(typeof commandHandler.handoffSessionConversation).toBe('function');

      const record = {
        name: 'deck_tdz_probe_brain',
        projectName: 'tdz-probe',
        role: 'brain',
        agentType: 'claude-code-sdk',
        runtimeType: 'transport',
        projectDir: '/tmp/imcodes-tdz-probe',
        state: 'idle',
        restarts: 0,
        restartTimestamps: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any;

      const sessionStore = await import('../../src/store/session-store.js');
      sessionStore.upsertSession(record);
      const storedRecord = sessionStore.getSession(record.name) ?? record;

      await expect(commandHandler.clearTransportConversation(storedRecord)).resolves.toBeUndefined();
      await expect(commandHandler.handoffSessionConversation(storedRecord)).resolves.toBeUndefined();
      expect(stopTransportRuntimeSession).toHaveBeenCalledWith(record.name);
      expect(launchTransportSession).toHaveBeenCalledTimes(1);
      expect(relaunchSessionWithSettings).toHaveBeenCalledWith(storedRecord, { fresh: true, handoff: true });
    } finally {
      const sessionStore = await import('../../src/store/session-store.js');
      sessionStore.removeSession('deck_tdz_probe_brain');
      vi.doUnmock('../../src/agent/session-manager.js');
    }
  });
});
