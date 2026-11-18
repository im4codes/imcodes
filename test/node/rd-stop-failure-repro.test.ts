import { describe, expect, it, vi } from 'vitest';
import { RemoteDesktopWorkerHost } from '../../src/node/remote-desktop-worker-host.js';
import { REMOTE_DESKTOP_MSG } from '../../shared/remote-desktop.js';
import net from 'node:net';

// Helper to mock the host environment
const artifact = {
    executablePath: 'dummy.exe',
    manifestPath: 'worker.manifest.json',
    virtualDisplayDirectory: 'dummy',
    manifest: {
        manifestVersion: 2,
        workerVersion: '1.0.0',
        protocolVersion: 2,
        ipcVersion: 1,
        os: 'win32',
        arch: 'x64',
        fileName: 'worker.exe',
        size: 1024,
        sha256: 'b'.repeat(64),
        authenticodeSignerSha256: 'c'.repeat(64),
        virtualDisplay: {
            archiveFileName: 'virtual-display.zip',
            packageManifestFileName: 'virtual-display.manifest.json',
            size: 2048,
            sha256: 'd'.repeat(64),
        },
        toolchain: {
            msvc: '19.44',
            windowsSdk: '10.0.26100.0',
            cmake: '3.31.6',
            ninja: '1.12.1',
            depotTools: '1',
        },
    }
};

describe('RemoteDesktopWorkerHost instability', () => {
    it('reaps worker process on failed stop', async () => {
        const socket = new net.Socket();
        vi.spyOn(socket, 'write').mockImplementation((_data, cb) => {
            if (cb) cb(new Error('Socket write failed'));
            socket.emit('error', new Error('Socket write failed'));
            return false;
        });

        const terminateProcess = vi.fn();
        const host = new RemoteDesktopWorkerHost(() => {}, {
            platform: 'win32',
            artifact,
            trustedSignerSha256: 'c'.repeat(64),
            terminateProcess,
        });
        // Inject an already-authenticated connection. This keeps the test
        // focused on failed STOP cleanup rather than the named-pipe handshake.
        (host as any).socket = socket;
        (host as any).workerConnectionBySocket.set(socket, {
            generation: 1,
            workerPid: 1234,
            correlationId: 'test-correlation',
            startedAt: Date.now(),
        });

        // Set up a tracked session
        const sessionId = 'session_test_123456';
        const core = (host as any).core;
        core.track({
            requestId: 'request_12345678',
            sessionId,
            capability: 'c'.repeat(43),
            expiresAt: Date.now() + 60_000,
            leaseExpiresAt: Date.now() + 60_000,
            daemonGeneration: 1,
            mode: 'view',
            inputEpoch: 0,
            iceServers: [],
        }, {
            virtualRetryAttempted: false,
            usesVirtualDisplay: false,
            secureConsoleRetryAttempted: false,
            correlationId: 'test-correlation',
            startedAt: Date.now(),
        });


        // Try to stop
        await host.handle({
            type: REMOTE_DESKTOP_MSG.STOP,
            requestId: 'request_12345678',
            sessionId,
            capability: 'c'.repeat(43),
        });

        // A failed write must still reap the detached worker process.
        expect(terminateProcess).toHaveBeenCalledWith(1234);
    });
});
