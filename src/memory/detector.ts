import type { MemoryBackend } from './interface.js';
import { ClaudeMemBackend } from './claude-mem.js';
import { Mem0Backend } from './mem0.js';

export type MemoryMode = 'claude-mem' | 'mem0' | 'none';

export async function detectMemoryBackend(): Promise<{ backend: MemoryBackend | null; mode: MemoryMode }> {
  const claudeMem = new ClaudeMemBackend();
  if (await claudeMem.isAvailable()) {
    return { backend: claudeMem, mode: 'claude-mem' };
  }

  const mem0 = new Mem0Backend();
  if (await mem0.isAvailable()) {
    return { backend: mem0, mode: 'mem0' };
  }

  return { backend: null, mode: 'none' };
}
