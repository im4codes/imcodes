import { EventEmitter } from 'node:events';
import * as fsPromises from 'node:fs/promises';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPcAppDownloadController,
  PC_APP_DOWNLOAD_CHANNELS,
  PC_APP_DOWNLOAD_MAX_CHUNK_BYTES,
  sanitizeDownloadFilename,
} from '../src/download-ipc.js';
import { createPcAppShell, type ShellWindowLike } from '../src/shell.js';
import type { WindowOpenHandlerResult } from '../src/security.js';
import type { PcAppIpcInvokeEventLike, PcAppIpcMainLike } from '../src/voice-ipc.js';

class MockWebContents extends EventEmitter {
  url = 'https://app.im.codes/chat';
  destroyed = false;
  windowOpenHandler: ((details: { url: string }) => WindowOpenHandlerResult) | null = null;
  session = {
    permissionRequestHandler: null as unknown,
    permissionCheckHandler: null as unknown,
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
    clearStorageData: vi.fn(async () => {}),
  };

  getURL(): string {
    return this.url;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  setWindowOpenHandler(handler: (details: { url: string }) => WindowOpenHandlerResult): void {
    this.windowOpenHandler = handler;
  }

  reload(): void {}
  reloadIgnoringCache(): void {}
  toggleDevTools(): void {}
}

function createMockIpcMain() {
  const handlers = new Map<string, (event: PcAppIpcInvokeEventLike, ...args: unknown[]) => Promise<unknown> | unknown>();
  const ipcMain: PcAppIpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };
  const invoke = async (channel: string, event: PcAppIpcInvokeEventLike, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`missing handler ${channel}`);
    return await handler(event, ...args);
  };
  return { ipcMain, handlers, invoke };
}

describe('PC App download IPC controller', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'imcodes-pc-dl-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('sanitizes suggested filenames including path traversal and non-ASCII names', () => {
    expect(sanitizeDownloadFilename('../../evil.mp4')).toBe('evil.mp4');
    expect(sanitizeDownloadFilename('..\\..\\evil.mp4')).toBe('evil.mp4');
    expect(sanitizeDownloadFilename('报告 2026 (1).pdf')).toBe('报告 2026 (1).pdf');
    expect(sanitizeDownloadFilename('..')).toBe('download');
    expect(sanitizeDownloadFilename('')).toBe('download');
    expect(sanitizeDownloadFilename(undefined)).toBe('download');
  });

  it('streams fresh downloads to a staging .part file, rolls back cleanly on abort, and commits atomically on close', async () => {
    const trusted = new Set(['https://app.im.codes']);
    const mainWc = new MockWebContents();
    const targetPath = path.join(tempDir, 'video.mp4');
    writeFileSync(targetPath, Buffer.from('EXISTING_CONTENT'));

    const showItemInFolder = vi.fn();
    const showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: targetPath }));
    const downloads = createPcAppDownloadController({
      isAllowedWebContents: (wc) => wc === mainWc,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => trusted,
      getDefaultDownloadsDir: () => tempDir,
      showSaveDialog,
      showItemInFolder,
    });

    const { ipcMain, invoke } = createMockIpcMain();
    downloads.registerIpc(ipcMain);

    const ev: PcAppIpcInvokeEventLike = {
      sender: mainWc,
      senderFrame: { url: 'https://app.im.codes/chat' },
    };

    const picked = (await invoke(PC_APP_DOWNLOAD_CHANNELS.pickSaveFile, ev, {
      suggestedName: '../../nested/video.mp4',
    })) as { canceled: false; handleId: string; name: string };
    expect(showSaveDialog).toHaveBeenCalledWith(mainWc, {
      defaultPath: path.join(tempDir, 'video.mp4'),
    });
    expect(picked.canceled).toBe(false);
    expect(picked.name).toBe('video.mp4');

    // Fresh download -> staged write -> abort preserves pre-existing target and deletes .part
    const { writerId: abortedWriterId } = (await invoke(PC_APP_DOWNLOAD_CHANNELS.openWriter, ev, {
      handleId: picked.handleId,
      keepExistingData: false,
    })) as { writerId: string };

    const partFilesDuringWrite = readdirSync(tempDir).filter((name) => name.endsWith('.part'));
    expect(partFilesDuringWrite).toHaveLength(1);
    if (process.platform !== 'win32') {
      const mode = statSync(path.join(tempDir, partFilesDuringWrite[0]!)).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    await invoke(PC_APP_DOWNLOAD_CHANNELS.writeChunk, ev, {
      writerId: abortedWriterId,
      chunk: Buffer.from('PARTIAL_NEW'),
    });
    expect(readFileSync(targetPath, 'utf8')).toBe('EXISTING_CONTENT');

    await invoke(PC_APP_DOWNLOAD_CHANNELS.abortWriter, ev, { writerId: abortedWriterId });
    expect(readdirSync(tempDir).filter((name) => name.endsWith('.part'))).toHaveLength(0);
    expect(readFileSync(targetPath, 'utf8')).toBe('EXISTING_CONTENT');
    expect(downloads.activeCounts().writers).toBe(0);

    // Fresh download -> commit on close overwrites target atomically
    const { writerId } = (await invoke(PC_APP_DOWNLOAD_CHANNELS.openWriter, ev, {
      handleId: picked.handleId,
      keepExistingData: false,
    })) as { writerId: string };

    await invoke(PC_APP_DOWNLOAD_CHANNELS.writeChunk, ev, {
      writerId,
      chunk: Buffer.from('NEW_'),
    });
    await invoke(PC_APP_DOWNLOAD_CHANNELS.writeChunk, ev, {
      writerId,
      chunk: Buffer.from('FINAL_DATA'),
    });
    await invoke(PC_APP_DOWNLOAD_CHANNELS.closeWriter, ev, { writerId });

    expect(readdirSync(tempDir).filter((name) => name.endsWith('.part'))).toHaveLength(0);
    expect(readFileSync(targetPath, 'utf8')).toBe('NEW_FINAL_DATA');

    const fileInfo = (await invoke(PC_APP_DOWNLOAD_CHANNELS.getFileSize, ev, {
      handleId: picked.handleId,
    })) as { size: number; name: string };
    expect(fileInfo).toEqual({ size: 14, name: 'video.mp4' });

    await expect(
      invoke(PC_APP_DOWNLOAD_CHANNELS.revealFile, ev, { handleId: picked.handleId }),
    ).resolves.toBe(true);
    expect(showItemInFolder).toHaveBeenCalledWith(targetPath);

    await downloads.dispose();
  });

  it('supports O(1) resume with keepExistingData, seek, truncate, and rollback to initialSize on abort', async () => {
    const trusted = new Set(['https://app.im.codes']);
    const mainWc = new MockWebContents();
    const targetPath = path.join(tempDir, 'archive.tar.gz');
    writeFileSync(targetPath, Buffer.from('HELLO_'));

    const downloads = createPcAppDownloadController({
      isAllowedWebContents: (wc) => wc === mainWc,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => trusted,
      showSaveDialog: async () => ({ canceled: false, filePath: targetPath }),
      showItemInFolder: vi.fn(),
    });
    const { ipcMain, invoke } = createMockIpcMain();
    downloads.registerIpc(ipcMain);

    const ev: PcAppIpcInvokeEventLike = {
      sender: mainWc,
      senderFrame: { url: 'https://app.im.codes/files' },
    };
    const { handleId } = (await invoke(PC_APP_DOWNLOAD_CHANNELS.pickSaveFile, ev, {
      suggestedName: 'archive.tar.gz',
    })) as { handleId: string };

    // Aborted resume restores initial size without destroying 'HELLO_' prefix
    const { writerId: abortedResume } = (await invoke(PC_APP_DOWNLOAD_CHANNELS.openWriter, ev, {
      handleId,
      keepExistingData: true,
    })) as { writerId: string };
    await invoke(PC_APP_DOWNLOAD_CHANNELS.seekWriter, ev, { writerId: abortedResume, position: 6 });
    await invoke(PC_APP_DOWNLOAD_CHANNELS.writeChunk, ev, {
      writerId: abortedResume,
      chunk: Buffer.from('CORRUPT'),
    });
    await invoke(PC_APP_DOWNLOAD_CHANNELS.abortWriter, ev, { writerId: abortedResume });
    expect(readFileSync(targetPath, 'utf8')).toBe('HELLO_');

    // Successful resume appends from initial size and respects truncate
    const { writerId } = (await invoke(PC_APP_DOWNLOAD_CHANNELS.openWriter, ev, {
      handleId,
      keepExistingData: true,
    })) as { writerId: string };
    await invoke(PC_APP_DOWNLOAD_CHANNELS.seekWriter, ev, { writerId, position: 6 });
    await invoke(PC_APP_DOWNLOAD_CHANNELS.writeChunk, ev, {
      writerId,
      chunk: Buffer.from('WORLD_EXTRA'),
    });
    await invoke(PC_APP_DOWNLOAD_CHANNELS.truncateWriter, ev, { writerId, size: 11 });
    await invoke(PC_APP_DOWNLOAD_CHANNELS.closeWriter, ev, { writerId });
    expect(readFileSync(targetPath, 'utf8')).toBe('HELLO_WORLD');
  });

  it('rejects untrusted senders, cross-window capability access, forged ids, and oversized chunks', async () => {
    const trusted = new Set(['https://app.im.codes', 'https://other.im.codes']);
    let activeOrigin: string | null = 'https://app.im.codes';
    const winA = new MockWebContents();
    const winB = new MockWebContents();
    const evilWc = new MockWebContents();
    evilWc.url = 'https://evil.example/';

    const targetPath = path.join(tempDir, 'secret.bin');
    const downloads = createPcAppDownloadController({
      isAllowedWebContents: (wc) => wc === winA || wc === winB,
      getCurrentTrustedOrigin: () => activeOrigin,
      getActiveOrigin: () => activeOrigin,
      getTrustedOrigins: () => trusted,
      showSaveDialog: async () => ({ canceled: false, filePath: targetPath }),
      showItemInFolder: vi.fn(),
    });
    const { ipcMain, invoke } = createMockIpcMain();
    downloads.registerIpc(ipcMain);

    const evA: PcAppIpcInvokeEventLike = { sender: winA, senderFrame: { url: 'https://app.im.codes/chat' } };
    const evB: PcAppIpcInvokeEventLike = { sender: winB, senderFrame: { url: 'https://app.im.codes/cloud-doc' } };

    // Untrusted webContents / spoofed frame rejected
    await expect(
      invoke(PC_APP_DOWNLOAD_CHANNELS.pickSaveFile, { sender: evilWc, senderFrame: { url: 'https://evil.example/' } }, {}),
    ).rejects.toThrow('Untrusted origin');
    await expect(
      invoke(PC_APP_DOWNLOAD_CHANNELS.pickSaveFile, { sender: winA, senderFrame: { url: 'https://evil.example/frame' } }, {}),
    ).rejects.toThrow('Untrusted origin');

    // WinA obtains handleId + writerId
    const { handleId } = (await invoke(PC_APP_DOWNLOAD_CHANNELS.pickSaveFile, evA, {})) as { handleId: string };
    const { writerId } = (await invoke(PC_APP_DOWNLOAD_CHANNELS.openWriter, evA, { handleId })) as { writerId: string };

    // WinB (different same-origin window) cannot use WinA's handleId or writerId
    await expect(invoke(PC_APP_DOWNLOAD_CHANNELS.openWriter, evB, { handleId })).rejects.toThrow('Invalid download handle');
    await expect(invoke(PC_APP_DOWNLOAD_CHANNELS.getFileSize, evB, { handleId })).rejects.toThrow('Invalid download handle');
    await expect(invoke(PC_APP_DOWNLOAD_CHANNELS.revealFile, evB, { handleId })).rejects.toThrow('Invalid download handle');
    await expect(
      invoke(PC_APP_DOWNLOAD_CHANNELS.writeChunk, evB, { writerId, chunk: new Uint8Array([1, 2]) }),
    ).rejects.toThrow('Invalid download writer');

    // Forged handle/writer IDs rejected
    await expect(invoke(PC_APP_DOWNLOAD_CHANNELS.openWriter, evA, { handleId: 'forged' })).rejects.toThrow('Invalid download handle');
    await expect(invoke(PC_APP_DOWNLOAD_CHANNELS.closeWriter, evA, { writerId: 'forged' })).rejects.toThrow('Invalid download writer');

    // Oversized chunk rejected
    await expect(
      invoke(PC_APP_DOWNLOAD_CHANNELS.writeChunk, evA, {
        writerId,
        chunk: new Uint8Array(PC_APP_DOWNLOAD_MAX_CHUNK_BYTES + 1),
      }),
    ).rejects.toThrow('chunk_too_large');

    // Switching active server origin invalidates prior handles/writers immediately
    activeOrigin = 'https://other.im.codes';
    winA.url = 'https://other.im.codes/';
    await expect(
      invoke(PC_APP_DOWNLOAD_CHANNELS.getFileSize, { sender: winA, senderFrame: { url: 'https://other.im.codes/' } }, { handleId }),
    ).rejects.toThrow('Invalid download handle');

    await downloads.dispose();
    expect(downloads.activeCounts()).toEqual({ handles: 0, writers: 0 });
  });

  it('wires main + child BrowserWindow downloads in createPcAppShell and cleans up on child destroy / cross-origin nav', async () => {
    const userDataDir = path.join(tempDir, 'userdata');
    const saveDir = path.join(tempDir, 'downloads');
    const targetPath = path.join(saveDir, 'doc.docx');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(saveDir, { recursive: true });

    const { ipcMain, invoke } = createMockIpcMain();
    const mainWc = new MockWebContents();
    const childWc = new MockWebContents();
    const showItemInFolder = vi.fn();

    const mainWin = {
      isDestroyed: () => false,
      loadURL: vi.fn(async (url: string) => {
        mainWc.url = url;
      }),
      webContents: mainWc,
      on: vi.fn(),
      isMinimized: () => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    } as unknown as ShellWindowLike;

    const shell = createPcAppShell({
      platform: 'darwin',
      appName: 'IM.codes',
      userDataDir,
      preloadPath: '/tmp/preload.cjs',
      ipcMain,
      voiceDeps: {
        buildDevHelper: () => null,
        runHelperSync: () => '[]',
        runHelperAsync: async () => '[]',
      },
      createMainWindow: () => mainWin,
      createPromptWindow: () => {
        throw new Error('unused');
      },
      setApplicationMenu: vi.fn(),
      openExternal: vi.fn(),
      showSaveDialogSync: () => undefined,
      getDefaultDownloadsDir: () => saveDir,
      showSaveDialog: async () => ({ canceled: false, filePath: targetPath }),
      showItemInFolder,
      showMessageBox: async () => ({ response: 0 }),
    });

    await shell.addAndSelectServer('https://app.im.codes', 'Main');
    mainWc.emit('did-finish-load');

    // Child BrowserWindow created via same-origin window.open (e.g. Cloud Docs popout)
    childWc.url = 'https://app.im.codes/cloud-doc/doc1';
    mainWc.emit('did-create-window', { webContents: childWc });

    const childEv: PcAppIpcInvokeEventLike = {
      sender: childWc,
      senderFrame: { url: 'https://app.im.codes/cloud-doc/doc1' },
    };

    const picked = (await invoke(PC_APP_DOWNLOAD_CHANNELS.pickSaveFile, childEv, {
      suggestedName: 'doc.docx',
    })) as { canceled: false; handleId: string; name: string };
    expect(picked.canceled).toBe(false);

    const { writerId } = (await invoke(PC_APP_DOWNLOAD_CHANNELS.openWriter, childEv, {
      handleId: picked.handleId,
      keepExistingData: false,
    })) as { writerId: string };
    await invoke(PC_APP_DOWNLOAD_CHANNELS.writeChunk, childEv, {
      writerId,
      chunk: Buffer.from('DOC_PARTIAL'),
    });

    // Destroying the child BrowserWindow cleans up its handle & staging .part file immediately
    childWc.destroyed = true;
    childWc.emit('destroyed');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shell.downloads.activeCounts()).toEqual({ handles: 0, writers: 0 });
    expect(existsSync(targetPath)).toBe(false);
    expect(readdirSync(saveDir).filter((n) => n.endsWith('.part'))).toHaveLength(0);
  });

  it('returns canceled:true cleanly when save dialog is canceled and surfaces ENOSPC as QuotaExceededError', async () => {
    const trusted = new Set(['https://app.im.codes']);
    const mainWc = new MockWebContents();
    let canceled = true;
    const enospcWrite = vi.fn(async () => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    const fakeFd = {
      write: enospcWrite,
      truncate: vi.fn(async () => {}),
      sync: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      stat: vi.fn(async () => ({ size: 0 })),
    };
    const unlink = vi.fn(async () => {});
    const downloads = createPcAppDownloadController({
      isAllowedWebContents: (wc) => wc === mainWc,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => trusted,
      showSaveDialog: async () =>
        canceled ? { canceled: true } : { canceled: false, filePath: path.join(tempDir, 'out.bin') },
      showItemInFolder: vi.fn(),
      fsOps: {
        open: vi.fn(async () => fakeFd) as never,
        rename: vi.fn(async () => {}),
        stat: vi.fn(async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }) as never,
        unlink,
      },
    });
    const { ipcMain, invoke } = createMockIpcMain();
    downloads.registerIpc(ipcMain);

    const ev: PcAppIpcInvokeEventLike = {
      sender: mainWc,
      senderFrame: { url: 'https://app.im.codes/chat' },
    };
    await expect(invoke(PC_APP_DOWNLOAD_CHANNELS.pickSaveFile, ev, { suggestedName: 'out.bin' })).resolves.toEqual({
      canceled: true,
    });
    expect(downloads.activeCounts()).toEqual({ handles: 0, writers: 0 });

    canceled = false;
    const { handleId } = (await invoke(PC_APP_DOWNLOAD_CHANNELS.pickSaveFile, ev, {
      suggestedName: 'out.bin',
    })) as { handleId: string };
    const { writerId } = (await invoke(PC_APP_DOWNLOAD_CHANNELS.openWriter, ev, { handleId })) as {
      writerId: string;
    };
    await expect(
      invoke(PC_APP_DOWNLOAD_CHANNELS.writeChunk, ev, { writerId, chunk: new Uint8Array([1, 2, 3]) }),
    ).rejects.toMatchObject({
      name: 'QuotaExceededError',
      message: expect.stringContaining('ENOSPC'),
    });

    await invoke(PC_APP_DOWNLOAD_CHANNELS.abortWriter, ev, { writerId });
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(downloads.activeCounts().writers).toBe(0);
  });

  it('safely replaces pre-existing target files on Windows-style EPERM/EEXIST rename failures and restores backup on swap failure', async () => {
    const trusted = new Set(['https://app.im.codes']);
    const mainWc = new MockWebContents();
    const targetPath = path.join(tempDir, 'installer.exe');
    writeFileSync(targetPath, Buffer.from('OLD_BINARY'));

    const renameWithWin32Conflict = vi.fn(async (src: string, dest: string) => {
      if (dest === targetPath && src.endsWith('.part') && existsSync(targetPath)) {
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      return await fsPromises.rename(src, dest);
    });

    const downloads = createPcAppDownloadController({
      isAllowedWebContents: (wc) => wc === mainWc,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => trusted,
      showSaveDialog: async () => ({ canceled: false, filePath: targetPath }),
      showItemInFolder: vi.fn(),
      fsOps: {
        open: fsPromises.open,
        rename: renameWithWin32Conflict,
        stat: fsPromises.stat,
        unlink: fsPromises.unlink,
      },
    });
    const { ipcMain, invoke } = createMockIpcMain();
    downloads.registerIpc(ipcMain);

    const ev: PcAppIpcInvokeEventLike = {
      sender: mainWc,
      senderFrame: { url: 'https://app.im.codes/chat' },
    };

    const { handleId } = (await invoke(PC_APP_DOWNLOAD_CHANNELS.pickSaveFile, ev, {
      suggestedName: 'installer.exe',
    })) as { handleId: string };
    const { writerId } = (await invoke(PC_APP_DOWNLOAD_CHANNELS.openWriter, ev, {
      handleId,
      keepExistingData: false,
    })) as { writerId: string };
    await invoke(PC_APP_DOWNLOAD_CHANNELS.writeChunk, ev, {
      writerId,
      chunk: Buffer.from('NEW_BINARY'),
    });
    await invoke(PC_APP_DOWNLOAD_CHANNELS.closeWriter, ev, { writerId });

    expect(readFileSync(targetPath, 'utf8')).toBe('NEW_BINARY');
    expect(readdirSync(tempDir).filter((name) => name.endsWith('.part') || name.endsWith('.bak'))).toHaveLength(0);

    // If second rename (staging -> target) fails after moving target to backup, original target is restored intact.
    const failSwapDownloads = createPcAppDownloadController({
      isAllowedWebContents: (wc) => wc === mainWc,
      getCurrentTrustedOrigin: () => 'https://app.im.codes',
      getActiveOrigin: () => 'https://app.im.codes',
      getTrustedOrigins: () => trusted,
      showSaveDialog: async () => ({ canceled: false, filePath: targetPath }),
      showItemInFolder: vi.fn(),
      fsOps: {
        open: fsPromises.open,
        rename: vi.fn(async (src: string, dest: string) => {
          if (src.endsWith('.part') && dest === targetPath) {
            throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
          }
          return await fsPromises.rename(src, dest);
        }),
        stat: fsPromises.stat,
        unlink: fsPromises.unlink,
      },
    });
    const mock2 = createMockIpcMain();
    failSwapDownloads.registerIpc(mock2.ipcMain);
    const { handleId: h2 } = (await mock2.invoke(PC_APP_DOWNLOAD_CHANNELS.pickSaveFile, ev, {
      suggestedName: 'installer.exe',
    })) as { handleId: string };
    const { writerId: w2 } = (await mock2.invoke(PC_APP_DOWNLOAD_CHANNELS.openWriter, ev, {
      handleId: h2,
      keepExistingData: false,
    })) as { writerId: string };
    await mock2.invoke(PC_APP_DOWNLOAD_CHANNELS.writeChunk, ev, {
      writerId: w2,
      chunk: Buffer.from('BROKEN_BINARY'),
    });
    await expect(mock2.invoke(PC_APP_DOWNLOAD_CHANNELS.closeWriter, ev, { writerId: w2 })).rejects.toThrow('EEXIST');
    expect(readFileSync(targetPath, 'utf8')).toBe('NEW_BINARY');
    expect(readdirSync(tempDir).filter((name) => name.endsWith('.part') || name.endsWith('.bak'))).toHaveLength(0);
  });
});
