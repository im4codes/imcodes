import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('p2p workflow launch wiring', () => {
  const commandHandler = readFileSync(resolve(process.cwd(), 'src/daemon/command-handler.ts'), 'utf8');

  it('keeps the production advanced launch path wired to the workflow pipeline', () => {
    for (const symbol of [
      'validateP2pWorkflowLaunchEnvelope',
      'materializeOldAdvancedConfigToWorkflowDraft',
      'compileP2pWorkflowDraft',
      'bindP2pCompiledWorkflow',
    ]) {
      expect(commandHandler).toMatch(new RegExp(`\\b${symbol}\\b`));
    }
  });

  it('rejects implicit file token bootstrap before advanced launch execution', () => {
    expect(commandHandler).toContain('Advanced workflow launch requires explicit startContext file references');
    expect(commandHandler).toContain('tokens.files');
  });

  it('builds bind policy from daemon-advertised capabilities, not workflow requirements', () => {
    expect(commandHandler).toContain('getP2pWorkflowCapabilities');
    expect(commandHandler).not.toContain('for (const capability of workflow.derivedRequiredCapabilities)');
  });
});
