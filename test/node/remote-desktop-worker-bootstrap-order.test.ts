import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('remote desktop worker bootstrap ordering', () => {
  it('authenticates the pipe and publishes its pid before fallible media initialization', () => {
    const source = readFileSync('native/windows-remote-desktop/worker_main.cc', 'utf8');
    const pipeConnect = source.indexOf('pipe_channel.Connect(arguments->pipe');
    const helloEmit = source.indexOf('writer.Emit(hello)');
    const mediaInitialization = [
      source.indexOf('webrtc::WinsockInitializer winsock'),
      source.indexOf('CoInitializeEx(nullptr, COINIT_MULTITHREADED)'),
      source.indexOf('MFStartup(MF_VERSION, MFSTARTUP_FULL)'),
      source.indexOf('webrtc::InitializeSSL()'),
    ];

    expect(pipeConnect).toBeGreaterThan(-1);
    expect(helloEmit).toBeGreaterThan(pipeConnect);
    expect(mediaInitialization.every((position) => position > helloEmit)).toBe(true);
  });
});
