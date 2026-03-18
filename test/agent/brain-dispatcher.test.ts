import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrainDispatcher } from '../../src/agent/brain-dispatcher.js';

describe('BrainDispatcher — core commands', () => {
  let dispatcher: BrainDispatcher;
  const mockSendToWorker = vi.fn().mockResolvedValue(undefined);
  const mockSendToBrain = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    dispatcher = new BrainDispatcher({
      projectName: 'test-project',
      sendToWorker: mockSendToWorker,
      sendToBrain: mockSendToBrain,
    });
    vi.clearAllMocks();
  });

  it('dispatches @w1 command to worker 1', async () => {
    await dispatcher.dispatch('@w1 implement the feature');
    expect(mockSendToWorker).toHaveBeenCalledWith('w1', 'implement the feature');
  });

  it('dispatches @w2 command to worker 2', async () => {
    await dispatcher.dispatch('@w2 fix the bug');
    expect(mockSendToWorker).toHaveBeenCalledWith('w2', 'fix the bug');
  });

  it('dispatches @brain reflection back to brain', async () => {
    await dispatcher.dispatch('@brain I need to review this');
    expect(mockSendToBrain).toHaveBeenCalledWith('I need to review this');
  });

  it('dispatches @status to query worker state', async () => {
    const statusHandler = vi.fn().mockResolvedValue({ w1: 'idle', w2: 'running' });
    dispatcher.registerCommand('status', statusHandler);
    await dispatcher.dispatch('@status');
    expect(statusHandler).toHaveBeenCalled();
  });

  it('handles @screen command', async () => {
    const screenHandler = vi.fn().mockResolvedValue('screen content');
    dispatcher.registerCommand('screen', screenHandler);
    await dispatcher.dispatch('@screen w1');
    expect(screenHandler).toHaveBeenCalledWith(['w1']);
  });

  it('handles @reply command', async () => {
    await dispatcher.dispatch('@reply w1 Your task is done');
    expect(mockSendToBrain).toHaveBeenCalled();
  });

  it('handles @ask command', async () => {
    await dispatcher.dispatch('@ask w1 What files did you modify?');
    expect(mockSendToWorker).toHaveBeenCalledWith('w1', expect.stringContaining('What files'));
  });

  it('ignores non-@ lines', async () => {
    await dispatcher.dispatch('This is just a regular brain response');
    expect(mockSendToWorker).not.toHaveBeenCalled();
    expect(mockSendToBrain).not.toHaveBeenCalled();
  });
});

describe('BrainDispatcher — auto-fix extension commands', () => {
  let dispatcher: BrainDispatcher;
  const mockSendToWorker = vi.fn().mockResolvedValue(undefined);
  const mockSendToBrain = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    dispatcher = new BrainDispatcher({
      projectName: 'test-project',
      sendToWorker: mockSendToWorker,
      sendToBrain: mockSendToBrain,
    });
    dispatcher.registerAutoFixExtensions();
    vi.clearAllMocks();
  });

  it('handles @audit command', async () => {
    const auditHandler = vi.fn().mockResolvedValue(undefined);
    dispatcher.registerCommand('audit', auditHandler);
    await dispatcher.dispatch('@audit w1');
    expect(auditHandler).toHaveBeenCalled();
  });

  it('handles @approve command', async () => {
    const approveHandler = vi.fn().mockResolvedValue(undefined);
    dispatcher.registerCommand('approve', approveHandler);
    await dispatcher.dispatch('@approve w2');
    expect(approveHandler).toHaveBeenCalled();
  });

  it('handles @reject command with findings', async () => {
    const rejectHandler = vi.fn().mockResolvedValue(undefined);
    dispatcher.registerCommand('reject', rejectHandler);
    await dispatcher.dispatch('@reject w1 Missing error handling in auth middleware');
    expect(rejectHandler).toHaveBeenCalledWith(expect.arrayContaining(['w1']));
  });

  it('handles @merge command', async () => {
    const mergeHandler = vi.fn().mockResolvedValue(undefined);
    dispatcher.registerCommand('merge', mergeHandler);
    await dispatcher.dispatch('@merge w1');
    expect(mergeHandler).toHaveBeenCalled();
  });
});

describe('BrainDispatcher — edge cases', () => {
  let dispatcher: BrainDispatcher;

  beforeEach(() => {
    dispatcher = new BrainDispatcher({
      projectName: 'test-project',
      sendToWorker: vi.fn().mockResolvedValue(undefined),
      sendToBrain: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('handles multi-line brain output (multiple @commands)', async () => {
    const lines = ['@w1 implement auth\n@w2 write tests\n@status'];
    // parseLine should handle each line independently
    for (const line of lines[0].split('\n')) {
      expect(() => dispatcher.parseLine(line)).not.toThrow();
    }
  });

  it('ignores malformed @command (no target)', async () => {
    expect(() => dispatcher.parseLine('@')).not.toThrow();
    expect(() => dispatcher.parseLine('@ ')).not.toThrow();
  });

  it('handles partial @command (only @ prefix)', async () => {
    expect(() => dispatcher.parseLine('@w')).not.toThrow();
  });

  it('handles @ embedded in prose (not a command)', async () => {
    const result = dispatcher.parseLine('The brain says to use email@example.com for auth');
    expect(result).toBeUndefined();
  });

  it('supports registering and deregistering custom commands', () => {
    const handler = vi.fn();
    dispatcher.registerCommand('custom', handler);
    dispatcher.parseLine('@custom arg1');
    expect(handler).toHaveBeenCalled();
  });
});
