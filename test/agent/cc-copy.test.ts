import { describe, it, expect, vi } from 'vitest';
import { ClaudeCodeDriver } from '../../src/agent/drivers/claude-code.js';

describe('ClaudeCodeDriver.captureLastResponse', () => {
  function makeDriver() {
    return new ClaudeCodeDriver();
  }

  it('sends /copy command and reads tmux buffer', async () => {
    const driver = makeDriver();
    const sendKeys = vi.fn().mockResolvedValue(undefined);
    const showBuffer = vi.fn().mockResolvedValue('This is the response from CC');
    const capturePane = vi.fn().mockResolvedValue(['fallback']);
    const deleteBuffer = vi.fn().mockResolvedValue(undefined);

    const result = await driver.captureLastResponse(capturePane, sendKeys, showBuffer, deleteBuffer);

    expect(sendKeys).toHaveBeenCalledWith('/copy');
    expect(showBuffer).toHaveBeenCalledOnce();
    expect(result).toBe('This is the response from CC');
  });

  it('calls deleteBuffer after reading clipboard (task 12.15 cleanup)', async () => {
    const driver = makeDriver();
    const sendKeys = vi.fn().mockResolvedValue(undefined);
    const showBuffer = vi.fn().mockResolvedValue('Response text');
    const capturePane = vi.fn().mockResolvedValue([]);
    const deleteBuffer = vi.fn().mockResolvedValue(undefined);

    await driver.captureLastResponse(capturePane, sendKeys, showBuffer, deleteBuffer);

    expect(deleteBuffer).toHaveBeenCalledOnce();
  });

  it('does NOT call deleteBuffer if deleteBuffer is not provided', async () => {
    const driver = makeDriver();
    const sendKeys = vi.fn().mockResolvedValue(undefined);
    const showBuffer = vi.fn().mockResolvedValue('Response');
    const capturePane = vi.fn().mockResolvedValue([]);

    // No error should be thrown when deleteBuffer is undefined
    await expect(
      driver.captureLastResponse(capturePane, sendKeys, showBuffer, undefined),
    ).resolves.toBe('Response');
  });

  it('falls back to capture-pane if buffer is empty', async () => {
    const driver = makeDriver();
    const sendKeys = vi.fn().mockResolvedValue(undefined);
    const showBuffer = vi.fn().mockResolvedValue(''); // empty buffer
    const capturePane = vi.fn().mockResolvedValue(['line1', 'line2']);
    const deleteBuffer = vi.fn().mockResolvedValue(undefined);

    const result = await driver.captureLastResponse(capturePane, sendKeys, showBuffer, deleteBuffer);

    expect(capturePane).toHaveBeenCalledOnce();
    expect(result).toBe('line1\nline2');
    // deleteBuffer should NOT be called when falling back
    expect(deleteBuffer).not.toHaveBeenCalled();
  });

  it('falls back to capture-pane if /copy throws', async () => {
    const driver = makeDriver();
    const sendKeys = vi.fn().mockRejectedValue(new Error('tmux error'));
    const showBuffer = vi.fn();
    const capturePane = vi.fn().mockResolvedValue(['fallback line']);
    const deleteBuffer = vi.fn();

    const result = await driver.captureLastResponse(capturePane, sendKeys, showBuffer, deleteBuffer);

    expect(result).toBe('fallback line');
    expect(capturePane).toHaveBeenCalledOnce();
    expect(deleteBuffer).not.toHaveBeenCalled();
  });
});
