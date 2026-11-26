import { describe, expect, it, vi } from 'vitest';
import {
  RemoteDesktopSignedShellController,
  REMOTE_DESKTOP_SIGNED_SHELL_CONTEXT_ARG,
  REMOTE_DESKTOP_SIGNED_SHELL_BOOTSTRAP_HOST_ARG,
  REMOTE_DESKTOP_SIGNED_SHELL_LAUNCH_ARG,
  REMOTE_DESKTOP_SIGNED_SHELL_SERVER_ORIGIN_ARG,
} from '../../src/node/remote-desktop-shell-launch.js';

const HOST_ID = 'host-00000000000000000001';
const LAUNCH_ID = 'launch-000000000000000001';

function context(overrides: Record<string, unknown> = {}) {
  return {
    hostId: HOST_ID,
    launchId: LAUNCH_ID,
    issuedAt: 1_000,
    expiresAt: 61_000,
    endpointGeneration: 7,
    ...overrides,
  };
}

function createController(options: {
  hostId?: string;
  endpointGeneration?: number;
  now?: number | (() => number);
  launch?: (command: { executable: string; args: readonly string[] }) => void | Promise<void>;
  onRecoveryRequired?: (reason: string) => void;
  replayTombstoneLimit?: number;
  serverOrigin?: string;
} = {}) {
  const launches: Array<{ executable: string; args: readonly string[] }> = [];
  const terminate = vi.fn(async () => {});
  const c = new RemoteDesktopSignedShellController({
    executablePath: 'C:/Program Files/IM.codes/imcodes-remote-desktop-account-shell.exe',
    serverOrigin: options.serverOrigin ?? 'https://im.example/',
    expectedContext: () => ({
      hostId: options.hostId ?? HOST_ID,
      endpointGeneration: options.endpointGeneration ?? 7,
    }),
    now: () => (typeof options.now === 'function' ? options.now() : options.now ?? 2_000),
    launcher: {
      launch: async (command) => {
        launches.push(command);
        await options.launch?.(command);
      },
      terminate,
    },
    onRecoveryRequired: options.onRecoveryRequired as never,
    replayTombstoneLimit: options.replayTombstoneLimit,
  });
  return { controller: c, launches, terminate };
}

describe('RemoteDesktopSignedShellController', () => {
  it('strictly consumes one current launch context and passes only bounded non-secret context to the signed shell', async () => {
    const { controller, launches } = createController();
    await expect(controller.start(context())).resolves.toEqual({ ok: true, launchId: LAUNCH_ID });
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      executable: expect.stringContaining('imcodes-remote-desktop-account-shell.exe'),
    });
    expect(launches[0]!.executable).not.toContain('worker');
    expect(launches[0]!.args[0]).toBe(REMOTE_DESKTOP_SIGNED_SHELL_LAUNCH_ARG);
    expect(launches[0]!.args.slice(1, 4)).toEqual([
      REMOTE_DESKTOP_SIGNED_SHELL_SERVER_ORIGIN_ARG,
      'https://im.example',
      REMOTE_DESKTOP_SIGNED_SHELL_CONTEXT_ARG,
    ]);
    expect(launches[0]!.args).toHaveLength(5);
    expect(launches[0]!.args).not.toContain(REMOTE_DESKTOP_SIGNED_SHELL_BOOTSTRAP_HOST_ARG);
    const decoded = JSON.parse(Buffer.from(String(launches[0]!.args[4]), 'base64url').toString('utf8'));
    expect(Object.keys(decoded).sort()).toEqual(['endpointGeneration', 'expiresAt', 'hostId', 'issuedAt', 'launchId']);
    expect(decoded).toEqual(context());
    expect(JSON.stringify(launches[0])).not.toMatch(/token|password|privateKey|bootstrap/i);
  });

  it.each([
    'http://im.example',
    'https://user:pass@im.example',
    'https://im.example/api',
    'https://im.example/?query=1',
  ])('refuses unsafe public Server origin %s', async (serverOrigin) => {
    const { controller, launches } = createController({ serverOrigin });
    await expect(controller.startBootstrap()).resolves.toMatchObject({
      ok: false,
      reason: 'shell_launch_failed',
    });
    await expect(controller.start(context())).resolves.toMatchObject({
      ok: false,
      reason: 'shell_launch_failed',
    });
    expect(launches).toEqual([]);
  });

  it('rejects stale, wrong-host, replayed or secret-bearing contexts fail closed', async () => {
    const reasons: string[] = [];
    const { controller, launches } = createController({ onRecoveryRequired: (reason) => reasons.push(reason) });
    await expect(controller.start(context({ hostId: 'host-00000000000000000002' }))).resolves.toMatchObject({ ok: false, reason: 'launch_context_stale' });
    await expect(controller.start(context({ endpointGeneration: 8 }))).resolves.toMatchObject({ ok: false, reason: 'launch_context_stale' });
    await expect(controller.start(context({ expiresAt: 1_500 }))).resolves.toMatchObject({ ok: false, reason: 'launch_context_stale' });
    await expect(controller.start({ ...context(), token: 'A'.repeat(43) })).resolves.toMatchObject({ ok: false, reason: 'launch_context_invalid' });
    await expect(controller.start({
      ...context({ launchId: 'launch-000000000000000002' }),
      privacy_epoch_id: 'epoch-0000000000000000001',
      revision: 1,
    })).resolves.toMatchObject({ ok: false, reason: 'launch_context_invalid' });
    await expect(controller.start(context())).resolves.toMatchObject({ ok: true });
    await expect(controller.start(context())).resolves.toMatchObject({ ok: false, reason: 'launch_context_replay' });
    expect(launches).toHaveLength(1);
    expect(reasons).toEqual(expect.arrayContaining(['launch_context_stale', 'launch_context_invalid', 'launch_context_replay']));
  });



  it('bounds replay tombstones and documents that durable one-use remains Server authority', async () => {
    let now = 2_000;
    const { controller, launches } = createController({
      now: () => now,
      replayTombstoneLimit: 2,
    });
    await expect(controller.start(context({ launchId: 'launch-000000000000000101', expiresAt: 60_000 }))).resolves.toMatchObject({ ok: true });
    await expect(controller.start(context({ launchId: 'launch-000000000000000102', expiresAt: 60_000 }))).resolves.toMatchObject({ ok: true });
    await expect(controller.start(context({ launchId: 'launch-000000000000000103', expiresAt: 60_000 }))).resolves.toMatchObject({ ok: true });
    expect(controller.replayTombstoneCount()).toBe(2);
    // The oldest in-process tombstone is evicted by design; durable one-use is
    // enforced by the Server redemption layer, not by this bounded Node cache.
    await expect(controller.start(context({ launchId: 'launch-000000000000000101', expiresAt: 60_000 }))).resolves.toMatchObject({ ok: true });
    expect(controller.replayTombstoneCount()).toBe(2);
    expect(launches).toHaveLength(4);

    now = 61_000;
    expect(controller.replayTombstoneCount()).toBe(0);
    await expect(controller.start(context({ launchId: 'launch-000000000000000102', expiresAt: 60_000 }))).resolves.toMatchObject({ ok: false, reason: 'launch_context_stale' });

    const restarted = createController({ now: 2_000 });
    await expect(restarted.controller.start(context())).resolves.toMatchObject({ ok: true });
    await expect(restarted.controller.start(context())).resolves.toMatchObject({ ok: false, reason: 'launch_context_replay' });
  });

  it('allows only invite-link clipboard cleanup metadata and maps watchdog uncertainty to recovery', async () => {
    const reasons: string[] = [];
    const { controller } = createController({ onRecoveryRequired: (reason) => reasons.push(reason), now: 10_000 });
    await expect(controller.start(context({ issuedAt: 9_000, expiresAt: 69_000 }))).resolves.toMatchObject({ ok: true });
    expect(controller.validateInviteClipboardCopyRequest({
      kind: 'invite_link',
      epochId: 'epoch-0000000000000000001',
      launchId: LAUNCH_ID,
      textHash: 'a'.repeat(64),
      deadlineAt: 70_000,
    })).toBe(true);
    expect(controller.validateInviteClipboardCopyRequest({
      kind: 'password',
      epochId: 'epoch-0000000000000000001',
      launchId: LAUNCH_ID,
      textHash: 'a'.repeat(64),
      deadlineAt: 70_000,
    })).toBe(false);
    expect(controller.validateInviteClipboardCopyRequest({
      kind: 'invite_link',
      epochId: 'epoch-0000000000000000001',
      launchId: LAUNCH_ID,
      text: 'raw invite must not enter node watchdog',
      textHash: 'a'.repeat(64),
      deadlineAt: 70_000,
    })).toBe(false);
    controller.markClipboardCleanupUncertain('clipboard_watchdog_crashed');
    controller.markLogoutUncertain();
    expect(controller.recoveryPending()).toBe(true);
    expect(reasons).toEqual(['clipboard_watchdog_crashed', 'shell_logout']);
  });

  it('starts a non-authorizing logged-out bootstrap with only origin and canonical host', async () => {
    const { controller, launches } = createController({ serverOrigin: 'https://im.example' });

    await expect(controller.startBootstrap()).resolves.toEqual({ ok: true, launchId: '' });
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({
      executable: expect.stringContaining('imcodes-remote-desktop-account-shell.exe'),
      serverOrigin: 'https://im.example',
      context: null,
      hostId: HOST_ID,
      args: [
        REMOTE_DESKTOP_SIGNED_SHELL_LAUNCH_ARG,
        REMOTE_DESKTOP_SIGNED_SHELL_SERVER_ORIGIN_ARG,
        'https://im.example',
        REMOTE_DESKTOP_SIGNED_SHELL_BOOTSTRAP_HOST_ARG,
        HOST_ID,
      ],
    });
    expect(launches[0]!.args.join('\0')).not.toMatch(
      /token|password|privateKey|cookie|bearer|accountSession|stepUp|grant|privacyEpoch|bootstrapTicket/i,
    );
    // The bootstrap is presentation-less: it owns no launch identity and
    // therefore cannot use the only local secret-bearing clipboard seam.
    expect(controller.activeLaunch()).toBeNull();
    expect(controller.validateInviteClipboardCopyRequest({
      kind: 'invite_link',
      epochId: 'epoch-0000000000000000001',
      launchId: LAUNCH_ID,
      textHash: 'a'.repeat(64),
      deadlineAt: 30_000,
    })).toBe(false);
  });

  it('burns a one-use bound context when process launch fails instead of retrying it as authority', async () => {
    const { controller, launches } = createController({
      launch: async () => { throw new Error('process_failed'); },
    });

    await expect(controller.start(context())).resolves.toEqual({
      ok: false,
      reason: 'shell_launch_failed',
    });
    await expect(controller.start(context())).resolves.toEqual({
      ok: false,
      reason: 'launch_context_replay',
    });
    expect(launches).toHaveLength(1);
  });
});
