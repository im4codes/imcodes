import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  AIDESK_LOCAL_IPC,
  AIDESK_LOCAL_IPC_ACCESS_STATE,
  AIDESK_LOCAL_IPC_ERROR,
  AIDESK_LOCAL_IPC_MESSAGE,
  AIDESK_LOCAL_IPC_SERVICE_STATE,
} from '../../shared/aidesk-local-ipc.js';
import { REMOTE_DESKTOP_LOCAL_ACTION } from '../../shared/remote-desktop-local-management.js';

const root = new URL('../../', import.meta.url);

async function source(path: string): Promise<string> {
  return await readFile(new URL(path, root), 'utf8');
}

describe('aiDesk local IPC cross-language contract', () => {
  it('binds every TypeScript wire token and bound into the toolkit-neutral C++ core', async () => {
    const [header, implementation] = await Promise.all([
      source('native/remote-desktop-common/local_management_ipc.h'),
      source('native/remote-desktop-common/local_management_ipc.cc'),
    ]);
    const cpp = `${header}\n${implementation}`;
    const wireTokens = [
      ...Object.values(AIDESK_LOCAL_IPC_MESSAGE),
      ...Object.values(AIDESK_LOCAL_IPC_SERVICE_STATE),
      ...Object.values(AIDESK_LOCAL_IPC_ACCESS_STATE),
      ...Object.values(AIDESK_LOCAL_IPC_ERROR),
      ...Object.values(REMOTE_DESKTOP_LOCAL_ACTION),
    ];
    for (const token of wireTokens) expect(cpp, token).toContain(`"${token}"`);
    expect(header).toContain(`kLocalManagementProtocolVersion = ${AIDESK_LOCAL_IPC.PROTOCOL_VERSION}`);
    expect(header).toContain(`kLocalManagementMaximumFrameBytes = ${AIDESK_LOCAL_IPC.MAX_FRAME_BYTES}`);
    expect(cpp).not.toMatch(/#include\s+[<"](?:FL\/|AppKit|windows\.h|X11\/)/u);
  });

  it('ships the core in every worker and executes its causal suite in the Windows native matrix', async () => {
    const [commonBuild, windowsBuild, windowsBuilder, linuxBuilder, macosBuilder] = await Promise.all([
      source('native/remote-desktop-common/BUILD.gn'),
      source('native/windows-remote-desktop/BUILD.gn'),
      source('native/windows-remote-desktop/build-worker.ps1'),
      source('native/linux-remote-desktop/build-worker-from-sdk.sh'),
      source('native/macos-remote-desktop/build-worker-from-sdk.sh'),
    ]);
    expect(commonBuild).toContain('"local_management_ipc.cc"');
    expect(commonBuild).toContain('"local_management_ipc.h"');
    expect(windowsBuild).toContain('rtc_test("local_management_ipc_unittests")');
    expect(windowsBuild).toContain('"local_management_ipc_unittest.cc"');
    expect(windowsBuilder).toContain("Where-Object { $_ -like '*_unittest.cc' }");
    expect(windowsBuilder).toContain("ForEach-Object { $_ -replace '_unittest\\.cc$', '_unittests' }");
    expect(linuxBuilder).toContain('native/remote-desktop-common/local_management_ipc.cc');
    expect(macosBuilder).toContain('"$COMMON_DIR"/*.cc');
  });

  it('keeps the old loopback panel while wiring the new IPC to the same runtime authority', async () => {
    const index = await source('src/node/index.ts');
    expect(index).toContain('startRemoteDesktopLocalPanel({');
    expect(index).toContain('startAideskLocalIpcServer({');
    expect(index.match(/status: \(\) => runtime\.remoteDesktopAccessStatus\(\)/gu)).toHaveLength(2);
    expect(index.match(/applyRemoteDesktopAccessPaused\(/gu)).toHaveLength(2);
    expect(index).toContain('runtime.stopRemoteDesktopConnection(connectionId)');
  });
});
