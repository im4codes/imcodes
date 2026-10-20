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
  REMOTE_DESKTOP_CONTROL_KIND,
  REMOTE_DESKTOP_DATA_MSG,
  REMOTE_DESKTOP_ENCODER_CLASS,
  REMOTE_DESKTOP_ENCODER_CODEC,
  REMOTE_DESKTOP_ENCODER_RAW_CODECS,
  REMOTE_DESKTOP_HELD_INPUT,
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_POINTER_BUTTON,
  REMOTE_DESKTOP_MSG,
} from '../../shared/remote-desktop.js';
import { REMOTE_DESKTOP_WORKER_IPC_VERSION } from '../../shared/remote-desktop-worker.js';
import { readSource } from '../helpers/read-source.js';

const ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readSource(resolve(ROOT, path));
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
    expect(ipcTokens.get('kIpcMessageUnlockRequest'))
      .toBe(MACOS_REMOTE_DESKTOP_IPC_MESSAGE.UNLOCK_REQUEST);
    expect(ipcTokens.get('kIpcMessageUnlockReply'))
      .toBe(MACOS_REMOTE_DESKTOP_IPC_MESSAGE.UNLOCK_REPLY);
    expect(ipcTokens.get('kIpcMessagePrivacyRequest'))
      .toBe(MACOS_REMOTE_DESKTOP_IPC_MESSAGE.PRIVACY_REQUEST);
    expect(ipcTokens.get('kIpcMessagePrivacyReply'))
      .toBe(MACOS_REMOTE_DESKTOP_IPC_MESSAGE.PRIVACY_REPLY);
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
      kEncoderClassHardware: REMOTE_DESKTOP_ENCODER_CLASS.HARDWARE,
      kEncoderClassSoftware: REMOTE_DESKTOP_ENCODER_CLASS.SOFTWARE,
      kEncoderInfoType: REMOTE_DESKTOP_DATA_MSG.ENCODER,
      kEncoderCodecVp9: REMOTE_DESKTOP_ENCODER_CODEC.VP9,
      kEncoderCodecVp8: REMOTE_DESKTOP_ENCODER_CODEC.VP8,
      kEncoderCodecH264: REMOTE_DESKTOP_ENCODER_CODEC.H264,
      kEncoderCodecPending: REMOTE_DESKTOP_ENCODER_CODEC.PENDING,
      kRawCodecsAllowed: REMOTE_DESKTOP_ENCODER_RAW_CODECS.ALLOWED,
      kRawCodecsHardwareH264: REMOTE_DESKTOP_ENCODER_RAW_CODECS.HARDWARE_H264,
      kRawCodecsCaptureCannotScale: REMOTE_DESKTOP_ENCODER_RAW_CODECS.CAPTURE_CANNOT_SCALE,
      kRawCodecsDisabledBySetting: REMOTE_DESKTOP_ENCODER_RAW_CODECS.DISABLED_BY_SETTING,
      kClipboardType: REMOTE_DESKTOP_DATA_MSG.CLIPBOARD,
      kPointerType: REMOTE_DESKTOP_DATA_MSG.POINTER,
      kKeyboardType: REMOTE_DESKTOP_DATA_MSG.KEYBOARD,
      kControlType: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      kReleaseAllType: REMOTE_DESKTOP_DATA_MSG.RELEASE_ALL,
      kHeldInputType: REMOTE_DESKTOP_DATA_MSG.HELD_INPUT,
      kControlRejectedType: REMOTE_DESKTOP_DATA_MSG.CONTROL_REJECTED,
      kInputAckKind: REMOTE_DESKTOP_CONTROL_KIND.INPUT_ACK,
      kCopySelectionKind: REMOTE_DESKTOP_CONTROL_KIND.COPY_SELECTION,
      kPasteTextKind: REMOTE_DESKTOP_CONTROL_KIND.PASTE_TEXT,
      kHelloKind: REMOTE_DESKTOP_CONTROL_KIND.HELLO,
      kKeepaliveKind: REMOTE_DESKTOP_CONTROL_KIND.KEEPALIVE,
    };
    for (const [nativeName, value] of Object.entries(expected)) {
      expect(dataTokens.get(nativeName), nativeName).toBe(value);
    }
  });

  it('pins the held-input limits, silence window and button names to the shared vocabulary', () => {
    const number = (name: string): number => {
      const match = new RegExp(`constexpr (?:std::size_t|long long) ${name} =\\s*([0-9_'* ]+);`).exec(dataHeader);
      expect(match, name).not.toBeNull();
      return Function(`return (${match![1].replace(/'/g, '')});`)() as number;
    };
    expect(number('kMaxHeldInputKeys')).toBe(REMOTE_DESKTOP_LIMITS.HELD_INPUT_KEYS);
    expect(number('kMaxHeldInputListBytes')).toBe(REMOTE_DESKTOP_LIMITS.HELD_INPUT_LIST_BYTES);
    expect(number('kHeldInputSilenceMs')).toBe(REMOTE_DESKTOP_HELD_INPUT.SILENCE_MS);
    // The worker must outlast several refreshes before it calls the viewer silent.
    expect(REMOTE_DESKTOP_HELD_INPUT.SILENCE_MS).toBeGreaterThanOrEqual(REMOTE_DESKTOP_HELD_INPUT.REFRESH_MS * 3);
    const payload = read('native/remote-desktop-common/data_channel_payload.cc');
    const tokenFn = /bool IsHeldButtonToken\(std::string_view token\) \{([\s\S]*?)\n\}/.exec(payload);
    expect(tokenFn).not.toBeNull();
    const nativeButtons = [...tokenFn![1].matchAll(/"([a-z]+)"/g)].map((match) => match[1]).sort();
    expect(nativeButtons).toEqual(Object.values(REMOTE_DESKTOP_POINTER_BUTTON).sort());
    expect(payload).toContain('ReadHeldList(Find(members, "buttons"), 5,');
    expect(Object.values(REMOTE_DESKTOP_POINTER_BUTTON)).toHaveLength(5);
  });

  it('keeps the held-input safety inert for a viewer that never declares and silent drop for an unknown message', () => {
    // Skew: an older web never declares, so the worker's silence watchdog must stay
    // disarmed until the first declaration; and a held_input an older worker does
    // not know is dropped by the parser rather than failing the session.
    expect(workerMain).toMatch(/held_input_armed_ = false;/);
    expect(workerMain).toMatch(/if \(!held_input_armed_ \|\| session_ == nullptr\)\s*\n?\s*return;/);
    const armSites = [...workerMain.matchAll(/held_input_armed_ = true;/g)];
    expect(armSites).toHaveLength(1);
    expect(workerMain).toMatch(/kind == imcodes::rd::DataChannelMessageKind::kHeldInput &&\s*\n?\s*channel == rd::common::DataChannelKind::kControl/);
    // Never acknowledged: an unacknowledged declaration must not fail a session.
    const handler = /kHeldInput &&[\s\S]*?accepted = true;/.exec(workerMain)![0];
    expect(handler).not.toContain('acknowledge = true');
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
