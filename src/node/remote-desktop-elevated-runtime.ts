import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { REMOTE_DESKTOP_WORKER_FILENAME } from '../../shared/remote-desktop-worker.js';
import { ElevatedRemoteDesktopHost } from './remote-desktop-elevated-host.js';
import {
  elevatedRemoteDesktopRoot,
  readElevatedRemoteDesktopConfig,
  readElevatedRemoteDesktopSecret,
} from './remote-desktop-elevated-install.js';
import {
  RemoteDesktopWorkerHost,
  verifyRemoteDesktopWorkerArtifact,
} from './remote-desktop-worker-host.js';

/** `icacls` grant limiting the pipe to SYSTEM and the one served account. */
export function elevatedPipeAclCommand(
  pipePath: string,
  userSid: string,
): readonly [string, ...string[]] {
  return [pipePath, '/grant:r', '*S-1-5-18:F', '/grant:r', `*${userSid}:RW`];
}

function restrictPipeTo(userSid: string): (pipePath: string) => Promise<void> {
  return (pipePath) => new Promise((resolve, reject) => {
    execFile('icacls', [...elevatedPipeAclCommand(pipePath, userSid)], {
      windowsHide: true,
      timeout: 15_000,
    }, (error) => (error ? reject(error) : resolve()));
  });
}

export interface ElevatedRemoteDesktopRuntimeDeps {
  root?: string;
  restrictPipe?: (pipePath: string) => Promise<void> | void;
  createWorkerHost?: (
    executablePath: string,
    onMessage: (message: Record<string, unknown>) => void,
  ) => { handle(command: never): Promise<boolean>; close(): void };
  onFatal?: (error: Error) => void;
}

/**
 * Run the LocalSystem half of login-screen control.
 *
 * Everything it needs was staged by the elevated install: the worker bundle it
 * verifies, the secret a daemon must present, and the single account that secret
 * was written for. It reads no node credential and opens no outbound connection
 * — this process exists only to own a worker that can follow Windows onto the
 * sign-in desktop.
 */
export async function runElevatedRemoteDesktopHost(
  deps: ElevatedRemoteDesktopRuntimeDeps = {},
): Promise<ElevatedRemoteDesktopHost> {
  const root = deps.root ?? elevatedRemoteDesktopRoot();
  const secret = readElevatedRemoteDesktopSecret(root);
  const config = readElevatedRemoteDesktopConfig(root);
  if (!secret || !config) throw new Error('remote_desktop_elevated_not_installed');

  const executablePath = join(root, 'remote-desktop-worker', 'win32-x64', REMOTE_DESKTOP_WORKER_FILENAME);
  let host: ElevatedRemoteDesktopHost;
  const worker = deps.createWorkerHost
    ? deps.createWorkerHost(executablePath, (message) => host.publish(message))
    // No launch overrides: the privileged defaults are the point of this
    // process. They put the worker on the console session, and on the Winlogon
    // desktop when nobody is signed in.
    : new RemoteDesktopWorkerHost(
      (message) => host.publish(message as unknown as Record<string, unknown>),
      { artifact: verifyRemoteDesktopWorkerArtifact(executablePath) },
    );
  host = new ElevatedRemoteDesktopHost({
    worker: worker as never,
    secret,
    restrictPipe: deps.restrictPipe ?? restrictPipeTo(config.userSid),
    onError: (error) => deps.onFatal?.(error),
  });
  await host.listen();
  return host;
}
