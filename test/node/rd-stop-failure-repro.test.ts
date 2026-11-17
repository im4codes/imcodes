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
            terminateProcess,
            launch: () => {
                // Directly inject the socket and connection when launch is called
                (host as any).socket = socket;
                (host as any).workerConnectionBySocket.set(socket, { workerPid: 1234 });
            }
        });
        
        // Remove direct injection here, as it's done in launch



        // Set up a tracked session
        const sessionId = 'session_test';
        const core = (host as any).core;
        core.tracked.set(sessionId, {
            sessionId,
            metadata: { }
        });


        // Try to stop
        await host.handle({
            type: REMOTE_DESKTOP_MSG.STOP,
            requestId: 'req_1',
            sessionId,
            capability: 'cap_1'
        });

        // Assert that untrack was called (or at least check the state)
        // AND assert that worker was reaped
        expect(terminateProcess).toHaveBeenCalledWith(1234);
    });
});
