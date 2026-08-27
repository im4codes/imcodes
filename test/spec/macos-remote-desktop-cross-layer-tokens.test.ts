import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MACOS_REMOTE_DESKTOP_NATIVE_COMMAND,
  MACOS_REMOTE_DESKTOP_NATIVE_READINESS_VERSION,
  MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE,
  parseMacosRemoteDesktopNativeReadiness,
} from '../../src/node/macos-remote-desktop-production.js';
import {
  MACOS_REMOTE_DESKTOP_IPC_MESSAGE,
  MACOS_REMOTE_DESKTOP_IPC_MAX_FRAME_BYTES,
} from '../../src/node/macos-remote-desktop-ipc.js';
import { MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT } from '../../src/node/macos-remote-desktop-launch-agent.js';
import {
  REMOTE_DESKTOP_CHANNEL,
  REMOTE_DESKTOP_DATA_MSG,
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_MSG,
} from '../../shared/remote-desktop.js';
import { REMOTE_DESKTOP_WORKER_IPC_VERSION } from '../../shared/remote-desktop-worker.js';

const ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

/** Extracts `inline constexpr char NAME[] = "value";` (single or wrapped line). */
function nativeStringConstants(source: string): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /constexpr char (k[A-Za-z0-9_]+)\[\]\s*=\s*\n?\s*"((?:[^"\\]|\\.)*)"\s*;/g;
  for (const match of source.matchAll(pattern)) found.set(match[1], match[2]);
  return found;
}

describe('macOS remote-desktop cross-layer token agreement', () => {
  const commandHeader = read('native/macos-remote-desktop/macos_native_command_v1.h');
  const ipcHeader = read('native/macos-remote-desktop/macos_worker_ipc_client.h');
  const workerMain = read('native/macos-remote-desktop/macos_remote_desktop_worker_main.mm');
  // The common protocol header is the single native vocabulary used by both
  // Windows and macOS dispatch. Platform dispatchers consume typed signals;
  // they must not create a second copy of these wire strings.
  const protocolHeader = read('native/remote-desktop-common/json_protocol.h');
  const dataHeader = read('native/remote-desktop-common/data_channel_constants.h');
  const commandTokens = nativeStringConstants(commandHeader);
  const ipcTokens = nativeStringConstants(ipcHeader);
  const workerTokens = nativeStringConstants(workerMain);
  const protocolTokens = nativeStringConstants(protocolHeader);
  const dataTokens = nativeStringConstants(dataHeader);

  it('uses the exact daemon command argv tokens', () => {
    // These are the argv the daemon actually execs. A drift here means the
    // native binary silently stops answering the command the daemon sends.
    expect(commandTokens.get('kNativeCommandReadinessV1'))
      .toBe(MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.readiness);
    expect(commandTokens.get('kNativeCommandRequestPermissionsV1'))
      .toBe(MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.requestPermissions);
    expect(commandTokens.get('kNativeCommandReleaseInputV1'))
      .toBe(MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.releaseInput);
    expect(commandTokens.get('kNativeCommandStopCaptureV1'))
      .toBe(MACOS_REMOTE_DESKTOP_NATIVE_COMMAND.stopCapture);
  });

  it('mirrors the readiness version and the closed session-state set', () => {
    expect(commandHeader).toContain(
      `kNativeReadinessVersionV1 = ${MACOS_REMOTE_DESKTOP_NATIVE_READINESS_VERSION}`,
    );
    const states = new Set(Object.values(MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE));
    const nativeStates = new Set([
      commandTokens.get('kNativeSessionStateActiveUnlocked'),
      commandTokens.get('kNativeSessionStateLocked'),
      commandTokens.get('kNativeSessionStateSleeping'),
      commandTokens.get('kNativeSessionStateInactive'),
    ]);
    // Exact set equality in both directions: an extra native value would be
    // rejected by the parser, a missing one would be unreachable.
    expect(nativeStates).toEqual(states);
  });

  it('mirrors the IPC message types, version and frame bound', () => {
    expect(ipcTokens.get('kIpcMessageHello')).toBe(MACOS_REMOTE_DESKTOP_IPC_MESSAGE.HELLO);
    expect(ipcTokens.get('kIpcMessageHostCommand'))
      .toBe(MACOS_REMOTE_DESKTOP_IPC_MESSAGE.HOST_COMMAND);
    expect(ipcTokens.get('kIpcMessageWorkerMessage'))
      .toBe(MACOS_REMOTE_DESKTOP_IPC_MESSAGE.WORKER_MESSAGE);
    expect(ipcHeader).toContain(`kWorkerIpcVersion = ${REMOTE_DESKTOP_WORKER_IPC_VERSION}`);
    // The native bound must not exceed the host's, or the worker would emit a
    // frame the host refuses to decode.
    const boundMatch = ipcHeader.match(/kIpcMaxFrameBytes = ([^;]+);/);
    expect(boundMatch).not.toBeNull();
    const nativeBound = Function(`"use strict";return (${boundMatch![1]});`)() as number;
    expect(nativeBound).toBe(MACOS_REMOTE_DESKTOP_IPC_MAX_FRAME_BYTES);
  });

  it('bounds native SDP exactly like the host', () => {
    // A larger native bound would accept an offer the daemon already refused;
    // a smaller one would reject a legitimate answer.
    const adapter = read('native/macos-remote-desktop/macos_transport_session_adapter.h');
    const match = adapter.match(/kMacosTransportMaximumSdpBytes = ([^;]+);/);
    expect(match).not.toBeNull();
    const nativeBound = Function(`"use strict";return (${match![1]});`)() as number;
    expect(nativeBound).toBe(REMOTE_DESKTOP_LIMITS.SDP_BYTES);
  });

  it('mirrors the fixed launch-agent environment variable names', () => {
    const env = MACOS_REMOTE_DESKTOP_LAUNCH_AGENT_ENVIRONMENT;
    expect(ipcTokens.get('kEnvSocketPath')).toBe(env.socketPath);
    expect(ipcTokens.get('kEnvLaunchChallenge')).toBe(env.launchChallenge);
    expect(ipcTokens.get('kEnvWorkerGeneration')).toBe(env.workerGeneration);
    expect(ipcTokens.get('kEnvRuntimeDirectory')).toBe(env.runtimeDirectory);
    expect(ipcTokens.get('kEnvLaunchAgentLabel')).toBe(env.label);
    expect(ipcTokens.get('kEnvBundleIdentifier')).toBe(env.bundleIdentifier);
    expect(ipcTokens.get('kEnvTeamId')).toBe(env.teamId);
  });

  it('mirrors every daemon command type the worker dispatches on', () => {
    const expected: Record<string, string> = {
      kPrepareType: REMOTE_DESKTOP_MSG.PREPARE,
      kOfferType: REMOTE_DESKTOP_MSG.OFFER,
      kIceType: REMOTE_DESKTOP_MSG.ICE,
      kLeaseType: REMOTE_DESKTOP_MSG.LEASE,
      kModeStateType: REMOTE_DESKTOP_MSG.MODE_STATE,
      kCancelType: REMOTE_DESKTOP_MSG.CANCEL,
      kStopType: REMOTE_DESKTOP_MSG.STOP,
      kStatusType: REMOTE_DESKTOP_MSG.STATUS,
    };
    for (const [nativeName, value] of Object.entries(expected)) {
      expect(protocolTokens.get(nativeName), nativeName).toBe(value);
    }
    expect(workerMain).not.toMatch(/constexpr char kMsg(?:Prepare|Offer|Ice|Lease|Mode|Stop)/);
    expect(read('native/macos-remote-desktop/macos_host_command_dispatch.h'))
      .not.toMatch(/constexpr char kMsg(?:Prepare|Offer|Ice|Lease|Mode|Stop)/);
  });

  it('uses the browser-owned channel labels and common data-message tokens', () => {
    expect(dataTokens.get('kControlChannel')).toBe(REMOTE_DESKTOP_CHANNEL.CONTROL);
    expect(dataTokens.get('kKeyboardChannel')).toBe(REMOTE_DESKTOP_CHANNEL.KEYBOARD);
    expect(dataTokens.get('kPointerChannel')).toBe(REMOTE_DESKTOP_CHANNEL.POINTER);
    const expected: Record<string, string> = {
      kTopologyType: REMOTE_DESKTOP_DATA_MSG.DISPLAY_TOPOLOGY,
      kQualityType: REMOTE_DESKTOP_DATA_MSG.QUALITY,
      kClipboardType: REMOTE_DESKTOP_DATA_MSG.CLIPBOARD,
      kPointerType: REMOTE_DESKTOP_DATA_MSG.POINTER,
      kKeyboardType: REMOTE_DESKTOP_DATA_MSG.KEYBOARD,
      kControlType: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      kReleaseAllType: REMOTE_DESKTOP_DATA_MSG.RELEASE_ALL,
      kControlRejectedType: REMOTE_DESKTOP_DATA_MSG.CONTROL_REJECTED,
    };
    for (const [nativeName, value] of Object.entries(expected)) {
      expect(dataTokens.get(nativeName), nativeName).toBe(value);
    }
  });

  it('accepts a native-shaped readiness payload through the real TS parser', () => {
    // End-to-end shape agreement: this is the exact byte sequence the native
    // serializer emits for a fully-ready machine.
    const encoded = '{"version":1,"activeAquaUserUids":[501],'
      + '"sessionState":"active_unlocked",'
      + '"screenRecording":true,"encoder":true,"accessibility":true,'
      + '"clipboard":true,"disclosure":true,"lifecycleObservation":true,'
      + '"releaseInput":true,"stopCapture":true,"virtualDisplay":true}';
    const parsed = parseMacosRemoteDesktopNativeReadiness(encoded);
    expect(parsed.version).toBe(MACOS_REMOTE_DESKTOP_NATIVE_READINESS_VERSION);
    expect(parsed.activeAquaUserUids).toEqual([501]);
    expect(parsed.sessionState).toBe(MACOS_REMOTE_DESKTOP_NATIVE_SESSION_STATE.ACTIVE_UNLOCKED);
    expect(parsed.disclosure).toBe(true);
  });

  it('rejects a payload with a key the native serializer must never emit', () => {
    // Guards the other direction: if the native side ever grew a field, the
    // daemon would fail closed rather than accept a widened advertisement.
    const widened = '{"version":1,"activeAquaUserUids":[501],'
      + '"sessionState":"active_unlocked",'
      + '"screenRecording":true,"encoder":true,"accessibility":true,'
      + '"clipboard":true,"disclosure":true,"lifecycleObservation":true,'
      + '"releaseInput":true,"stopCapture":true,"virtualDisplay":true,"extra":true}';
    expect(() => parseMacosRemoteDesktopNativeReadiness(widened))
      .toThrow('macos_remote_desktop_native_readiness_invalid');
  });
});
