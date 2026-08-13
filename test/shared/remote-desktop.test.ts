import { describe, expect, it } from 'vitest';
import {
  REMOTE_DESKTOP_ACCESS_MODE,
  REMOTE_DESKTOP_CAPABILITY,
  REMOTE_DESKTOP_CHANNEL,
  REMOTE_DESKTOP_COMMON_DISPLAY_MODES,
  REMOTE_DESKTOP_CONTROL_KIND,
  REMOTE_DESKTOP_DATA_MSG,
  REMOTE_DESKTOP_DISPLAY_ROTATION,
  REMOTE_DESKTOP_ENCODER_CLASS,
  REMOTE_DESKTOP_ERROR,
  REMOTE_DESKTOP_LIMITS,
  REMOTE_DESKTOP_MSG,
  REMOTE_DESKTOP_MODE_REASON,
  REMOTE_DESKTOP_POINTER_KIND,
  REMOTE_DESKTOP_PROTOCOL_VERSION,
  REMOTE_DESKTOP_QUALITY_PRESET,
  REMOTE_DESKTOP_STATE,
  REMOTE_DESKTOP_TERMINAL_REASON,
  isRemoteDesktopSequenceAccepted,
  isRemoteDesktopDaemonMessageType,
  isRemoteDesktopPresentedFrameCompatible,
  mapRemoteDesktopPointToPhysicalPixels,
  mapRemoteDesktopVideoPoint,
  validateRemoteDesktopAuthorized,
  validateRemoteDesktopBrowserMessage,
  validateRemoteDesktopDaemonCommand,
  validateRemoteDesktopDaemonMessage,
  validateRemoteDesktopDataMessage,
  validateRemoteDesktopServerMessage,
} from '../../shared/remote-desktop.js';
import { WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN } from '../../shared/remote-desktop-qualification.js';
import { isRemoteDesktopFeatureEnabled } from '../../shared/remote-desktop-feature.js';

const requestId = 'request_12345678';
const sessionId = 'session_12345678';
const capability = 'a'.repeat(43);

const authority = {
  requestId,
  sessionId,
  capability,
  expiresAt: 100_000,
  leaseExpiresAt: 90_000,
  daemonGeneration: 7,
  mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
  inputEpoch: 0,
  iceServers: [
    'stun:stun.example.test:3478',
    { urls: ['turn:turn.example.test:3478?transport=udp'], username: 'user', credential: 'secret' },
  ],
};

const inputBase = {
  protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
  sessionId,
  sequence: 0,
  layoutRevision: 1,
  inputEpoch: 1,
};

describe('remote desktop production contract', () => {
  it('enables production by default and preserves an explicit kill switch', () => {
    expect(isRemoteDesktopFeatureEnabled(undefined, 'production')).toBe(true);
    expect(isRemoteDesktopFeatureEnabled('1', 'production')).toBe(true);
    expect(isRemoteDesktopFeatureEnabled('unexpected', 'production')).toBe(false);
    expect(isRemoteDesktopFeatureEnabled('0', 'development')).toBe(false);
    expect(isRemoteDesktopFeatureEnabled('0', 'production')).toBe(false);
  });
  it('keeps capability advertisement distinct from media-stack qualification', () => {
    expect(REMOTE_DESKTOP_CAPABILITY).toBe('remote.desktop.windows.h264.v2');
    expect(REMOTE_DESKTOP_PROTOCOL_VERSION).toBe(2);
    expect(WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.version).toBe(4);
    expect(WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.supportedWindows).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: 'windows_10', minimumBuild: 19045, architecture: 'x64' }),
      expect.objectContaining({ family: 'windows_11', architecture: 'x64' }),
    ]));
    expect(WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.supportedBrowsers.map((row) => row.family)).toEqual(['chrome', 'edge']);
    expect(WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.supportedBrowsers).toEqual([
      expect.objectContaining({ family: 'chrome', mediaQualified: true, physicalInputQualified: false }),
      expect.objectContaining({ family: 'edge', mediaQualified: true, physicalInputQualified: true }),
    ]);
    expect(WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.encoderMatrix).toEqual(expect.arrayContaining([
      expect.objectContaining({
        vendor: 'intel', deviceClass: 'integrated_or_discrete', mode: 'hardware',
        qualificationEvidence: 'observed',
      }),
      expect.objectContaining({
        vendor: 'amd', deviceClass: 'integrated_or_discrete', mode: 'hardware',
        qualificationEvidence: 'pending_additional_matrix',
      }),
      expect.objectContaining({
        vendor: 'nvidia', deviceClass: 'discrete', mode: 'hardware',
        qualificationEvidence: 'pending_additional_matrix',
      }),
      expect.objectContaining({
        vendor: 'platform_software', deviceClass: 'cpu', mode: 'software',
        qualificationEvidence: 'observed',
      }),
    ]));
    expect(WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.encoderPolicy).toEqual({
      vendorLocked: false,
      discreteGpuRequired: false,
      hardwareEncodingPreferred: true,
      softwareFallbackRequired: true,
    });
    expect(WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.transportPolicy).toEqual({
      directIcePreferred: true,
      turnFallbackOnly: true,
      serverMediaRelayForbidden: true,
      serverInputRelayForbidden: true,
      httpPerInputEventForbidden: true,
    });
    expect(WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.mediaStackDecision).toEqual({
      remoteDesktopMediaStack: 'upstream_libwebrtc',
      libwebrtcRevision: 'f20ebb8adbf4fa781830e4384c61f732bd28a217',
      depotToolsRevision: 'a1bda5b6167435ad0666191f0353f242104f5845',
      chromiumCompatibilityTag: '151.0.7922.110',
      nodeDatachannelPackageVersionEvaluated: '0.32.3',
      libdatachannelVersionEvaluated: '0.24.2',
      reuseNodeDatachannelForRemoteDesktopMedia: false,
      keepExistingNodeDatachannelConnectivityConsumers: true,
      noGoReasons: [
        'no_sender_target_bitrate_callback',
        'no_sender_keyframe_request_callback',
      ],
    });
    expect(REMOTE_DESKTOP_CHANNEL).toEqual({
      CONTROL: 'imcodes-rd-control',
      KEYBOARD: 'imcodes-rd-keyboard',
      POINTER: 'imcodes-rd-pointer',
    });
    expect(WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.qualityLadder).toHaveLength(7);
    expect(WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.qualityLadder[0]).toMatchObject({
      id: '2160p15', width: 3840, height: 2160, fps: 15,
    });
    expect(WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.scenarios).toContain('native_2160p15');
    expect(WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.scenarios).toContain('five_minute_stability');
    expect(WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.sessionLimits.reconnectStabilityResetMs)
      .toBe(REMOTE_DESKTOP_LIMITS.RECONNECT_STABILITY_RESET_MS);
    expect(WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.scenarios).not.toContain('sixty_minute_stability');
    expect(WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.thresholds.legacyMinimumDecodedFps).toBe(8);
    expect(WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN.prohibitedProductionMediaPaths).toEqual(expect.arrayContaining([
      'computer_use_screenshot_polling',
      'jpeg_frame_stream',
      'webp_frame_stream',
      'custom_video_codec',
      'custom_rtp_or_congestion_control',
    ]));
  });

  it('strictly validates start and authority envelopes', () => {
    expect(validateRemoteDesktopBrowserMessage({
      type: REMOTE_DESKTOP_MSG.START,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      requestId,
      reconnectAttempt: 2,
    })).toMatchObject({ ok: true });
    expect(validateRemoteDesktopBrowserMessage({
      type: REMOTE_DESKTOP_MSG.START,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      requestId,
      reconnectAttempt: REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS + 1,
    })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
    expect(validateRemoteDesktopBrowserMessage({
      type: REMOTE_DESKTOP_MSG.STOP,
      requestId,
      sessionId,
      capability,
      aggregateBytesReceived: 12_345,
    })).toMatchObject({ ok: true });
    expect(validateRemoteDesktopBrowserMessage({
      type: REMOTE_DESKTOP_MSG.START,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      requestId,
      serverId: 'must-be-query-scoped',
    })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
    expect(validateRemoteDesktopAuthorized({ type: REMOTE_DESKTOP_MSG.AUTHORIZED, ...authority })).toMatchObject({ ok: true });
    expect(validateRemoteDesktopDaemonCommand({ type: REMOTE_DESKTOP_MSG.PREPARE, ...authority })).toMatchObject({ ok: true });
    expect(validateRemoteDesktopDaemonCommand({
      type: REMOTE_DESKTOP_MSG.PREPARE,
      ...authority,
      reconnectAttempt: REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS,
    })).toMatchObject({ ok: true });
    expect(validateRemoteDesktopDaemonCommand({
      type: REMOTE_DESKTOP_MSG.PREPARE,
      ...authority,
      reconnectAttempt: REMOTE_DESKTOP_LIMITS.MAX_RECONNECT_ATTEMPTS + 1,
    })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
    expect(validateRemoteDesktopDaemonCommand({
      type: REMOTE_DESKTOP_MSG.PREPARE,
      ...authority,
      leaseExpiresAt: authority.expiresAt + 1,
    })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
    expect(validateRemoteDesktopAuthorized({
      type: REMOTE_DESKTOP_MSG.AUTHORIZED,
      ...authority,
      iceServers: [{ urls: ['turn:turn.example.test:3478'] }],
    })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
    expect(validateRemoteDesktopBrowserMessage({
      type: REMOTE_DESKTOP_MSG.CANCEL,
      requestId,
      sessionId,
      capability,
    })).toMatchObject({ ok: true });
    expect(validateRemoteDesktopServerMessage({
      type: REMOTE_DESKTOP_MSG.ERROR,
      requestId,
      error: REMOTE_DESKTOP_ERROR.SESSION_LIMIT,
      retryable: true,
    })).toMatchObject({ ok: true });
    expect(validateRemoteDesktopServerMessage({
      type: REMOTE_DESKTOP_MSG.ERROR,
      requestId,
      error: 'future_error',
      retryable: false,
    })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
  });

  it('bounds SDP, ICE, generations, and terminal details', () => {
    expect(validateRemoteDesktopBrowserMessage({
      type: REMOTE_DESKTOP_MSG.OFFER,
      requestId,
      sessionId,
      capability,
      sdp: 'v=0',
    })).toMatchObject({ ok: true });
    expect(validateRemoteDesktopBrowserMessage({
      type: REMOTE_DESKTOP_MSG.OFFER,
      requestId,
      sessionId,
      capability,
      sdp: 'x'.repeat(REMOTE_DESKTOP_LIMITS.SDP_BYTES + 1),
    })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
    expect(validateRemoteDesktopDaemonMessage({
      type: REMOTE_DESKTOP_MSG.TERMINAL,
      requestId,
      sessionId,
      capability,
      reason: REMOTE_DESKTOP_TERMINAL_REASON.AUTHORITY_REVOKED,
      detail: 'share revoked',
    })).toMatchObject({ ok: true });
    expect(validateRemoteDesktopDaemonCommand({
      type: REMOTE_DESKTOP_MSG.LEASE,
      requestId,
      sessionId,
      capability,
      leaseExpiresAt: 90_000,
      daemonGeneration: 0,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
    })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
  });

  it('uses independent acknowledged view/control modes with monotonic input epochs', () => {
    expect(validateRemoteDesktopBrowserMessage({
      type: REMOTE_DESKTOP_MSG.MODE_SET,
      requestId,
      sessionId,
      capability,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
    })).toMatchObject({ ok: true });
    expect(validateRemoteDesktopBrowserMessage({
      type: REMOTE_DESKTOP_MSG.MODE_SET,
      requestId,
      sessionId,
      capability,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      takeover: true,
    })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });

    const controlState = {
      type: REMOTE_DESKTOP_MSG.MODE_STATE,
      requestId,
      sessionId,
      capability,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      reason: REMOTE_DESKTOP_MODE_REASON.USER_SELECTED,
    };
    expect(validateRemoteDesktopDaemonCommand(controlState)).toMatchObject({ ok: true });
    expect(validateRemoteDesktopDaemonMessage(controlState)).toMatchObject({ ok: true });
    expect(validateRemoteDesktopDaemonCommand({ ...controlState, inputEpoch: 0 }))
      .toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
  });

  it('validates multi-monitor topology by opaque id and rejects ambiguous tabs', () => {
    const topology = {
      type: REMOTE_DESKTOP_DATA_MSG.DISPLAY_TOPOLOGY,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId,
      sequence: 0,
      layoutRevision: 1,
      displays: [
        { id: 'display-primary', label: 'Display 1', primary: true, available: true, width: 1920, height: 1080, dpiScale: 1.5, rotation: REMOTE_DESKTOP_DISPLAY_ROTATION.ROTATE_0 },
        { id: 'display-second', label: 'Display 2', primary: false, available: true, width: 1080, height: 1920, dpiScale: 1, rotation: REMOTE_DESKTOP_DISPLAY_ROTATION.ROTATE_90 },
      ],
      selectedDisplayId: 'display-primary',
    };
    expect(validateRemoteDesktopDataMessage(topology)).toMatchObject({ ok: true });
    expect(validateRemoteDesktopDataMessage({
      ...topology,
      displays: [topology.displays[0], { ...topology.displays[1], id: 'display-primary' }],
    })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
    expect(validateRemoteDesktopDataMessage({ ...topology, selectedDisplayId: 'missing-display' }))
      .toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
    expect(validateRemoteDesktopDataMessage({ ...topology, unexpected: true }))
      .toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
  });

  it('validates bounded quality diagnostics', () => {
    const quality = {
      type: REMOTE_DESKTOP_DATA_MSG.QUALITY,
      protocolVersion: REMOTE_DESKTOP_PROTOCOL_VERSION,
      sessionId,
      sequence: 4,
      preset: REMOTE_DESKTOP_QUALITY_PRESET.P1080_30,
      encoderClass: REMOTE_DESKTOP_ENCODER_CLASS.HARDWARE,
      width: 1920,
      height: 1080,
      fps: 29.97,
      bitrateBps: 5_000_000,
      droppedFrames: 2,
      rttMs: 42,
    };
    expect(validateRemoteDesktopDataMessage(quality)).toMatchObject({ ok: true });
    expect(validateRemoteDesktopDataMessage({ ...quality, bitrateBps: REMOTE_DESKTOP_LIMITS.MAX_VIDEO_BITRATE_BPS + 1 }))
      .toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
  });

  it('accepts normalized pointer input and rejects padding or mismatched shapes', () => {
    const move = {
      type: REMOTE_DESKTOP_DATA_MSG.POINTER,
      ...inputBase,
      sequence: 9,
      kind: REMOTE_DESKTOP_POINTER_KIND.MOVE,
      x: 0.25,
      y: 1,
    };
    expect(validateRemoteDesktopDataMessage(move)).toMatchObject({ ok: true });
    expect(validateRemoteDesktopDataMessage({ ...move, x: -0.01 })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
    expect(validateRemoteDesktopDataMessage({ ...move, button: 'left' })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
    expect(validateRemoteDesktopDataMessage({ ...move, sequence: Number.MAX_SAFE_INTEGER + 1 })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
    expect(validateRemoteDesktopDataMessage({ ...move, layoutRevision: 0 })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
    expect(isRemoteDesktopSequenceAccepted(move, { sessionId, layoutRevision: 1, inputEpoch: 1, lastSequence: 8 })).toBe(true);
    expect(isRemoteDesktopSequenceAccepted(move, { sessionId, layoutRevision: 1, inputEpoch: 1, lastSequence: 9 })).toBe(false);
    expect(isRemoteDesktopSequenceAccepted(move, { sessionId, layoutRevision: 2, inputEpoch: 1, lastSequence: 0 })).toBe(false);
    expect(isRemoteDesktopSequenceAccepted(move, { sessionId, layoutRevision: 1, inputEpoch: 2, lastSequence: 0 })).toBe(false);
    expect(validateRemoteDesktopDataMessage({ ...move, inputEpoch: 0 }))
      .toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
  });

  it('rejects letterbox padding and maps video content to normalized coordinates', () => {
    const mapping = {
      viewportLeft: 100,
      viewportTop: 50,
      viewportWidth: 1_000,
      viewportHeight: 1_000,
      videoWidth: 1_920,
      videoHeight: 1_080,
    };
    expect(mapRemoteDesktopVideoPoint({ ...mapping, clientX: 600, clientY: 550 })).toEqual({ x: 0.5, y: 0.5 });
    expect(mapRemoteDesktopVideoPoint({ ...mapping, clientX: 600, clientY: 100 })).toBeNull();
    expect(mapRemoteDesktopVideoPoint({ ...mapping, clientX: 99, clientY: 550 })).toBeNull();
  });

  it.each([1, 1.25, 1.5, 1.75, 2, 2.25, 2.5])(
    'maps normalized input to the same physical pixels at %sx DPI',
    (dpiScale) => {
      const display = {
        available: true,
        width: 3_840,
        height: 2_160,
        dpiScale,
        rotation: REMOTE_DESKTOP_DISPLAY_ROTATION.ROTATE_0,
      };
      expect(mapRemoteDesktopPointToPhysicalPixels({ x: 0.5, y: 0.25 }, display, 9, 9))
        .toEqual({ x: 1_920, y: 540 });
      expect(mapRemoteDesktopPointToPhysicalPixels({ x: 1, y: 1 }, display, 9, 9))
        .toEqual({ x: 3_839, y: 2_159 });
    },
  );

  it('drops stale-layout and unavailable-display input before physical mapping', () => {
    const display = {
      available: true,
      width: 1_080,
      height: 1_920,
      dpiScale: 2.25,
      rotation: REMOTE_DESKTOP_DISPLAY_ROTATION.ROTATE_90,
    };
    expect(mapRemoteDesktopPointToPhysicalPixels({ x: 0.25, y: 0.75 }, display, 10, 11)).toBeNull();
    expect(mapRemoteDesktopPointToPhysicalPixels(
      { x: 0.25, y: 0.75 },
      { ...display, available: false },
      11,
      11,
    )).toBeNull();
    expect(mapRemoteDesktopPointToPhysicalPixels(
      { x: 0.25, y: 0.75 },
      display,
      11,
      11,
    )).toEqual({ x: 270, y: 1_440 });
  });

  it('separates monitor selection, keyboard input, and release-all shapes', () => {
    expect(validateRemoteDesktopDataMessage({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      ...inputBase,
      kind: REMOTE_DESKTOP_CONTROL_KIND.FRAME_PRESENTED,
      displayId: 'display-second',
      frameWidth: 1920,
      frameHeight: 1080,
    })).toMatchObject({ ok: true });
    expect(validateRemoteDesktopDataMessage({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      ...inputBase,
      kind: REMOTE_DESKTOP_CONTROL_KIND.FRAME_PRESENTED,
      displayId: 'display-second',
      frameWidth: 0,
      frameHeight: 1080,
    })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
    expect(validateRemoteDesktopDataMessage({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      ...inputBase,
      kind: REMOTE_DESKTOP_CONTROL_KIND.KEEPALIVE,
      frameWidth: 1920,
      frameHeight: 1080,
    })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
    expect(isRemoteDesktopPresentedFrameCompatible(1920, 1080, 3840, 2160)).toBe(true);
    expect(isRemoteDesktopPresentedFrameCompatible(1080, 1920, 3840, 2160)).toBe(false);
    expect(isRemoteDesktopPresentedFrameCompatible(0, 1080, 1920, 1080)).toBe(false);
    expect(validateRemoteDesktopDataMessage({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      ...inputBase,
      kind: REMOTE_DESKTOP_CONTROL_KIND.SELECT_DISPLAY,
      displayId: 'display-second',
    })).toMatchObject({ ok: true });
    expect(REMOTE_DESKTOP_COMMON_DISPLAY_MODES.map(({ width, height }) => (
      `${width}x${height}`
    ))).toEqual(['1280x720', '1920x1080', '2560x1440', '3840x2160']);
    expect(validateRemoteDesktopDataMessage({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      ...inputBase,
      kind: REMOTE_DESKTOP_CONTROL_KIND.SET_DISPLAY_MODE,
      displayId: 'display-second',
      width: 3840,
      height: 2160,
    })).toMatchObject({ ok: true });
    expect(validateRemoteDesktopDataMessage({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      ...inputBase,
      kind: REMOTE_DESKTOP_CONTROL_KIND.SET_DISPLAY_MODE,
      displayId: 'display-second',
      width: 1024,
      height: 768,
    })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
    expect(validateRemoteDesktopDataMessage({
      type: REMOTE_DESKTOP_DATA_MSG.CONTROL,
      ...inputBase,
      kind: REMOTE_DESKTOP_CONTROL_KIND.SELECT_DISPLAY,
      displayId: 'display-second',
      width: 1920,
    })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
    expect(validateRemoteDesktopDataMessage({
      type: REMOTE_DESKTOP_DATA_MSG.KEYBOARD,
      ...inputBase,
      kind: 'key_down',
      code: 'KeyA',
      key: 'a',
      repeat: false,
    })).toMatchObject({ ok: true });
    expect(validateRemoteDesktopDataMessage({
      type: REMOTE_DESKTOP_DATA_MSG.KEYBOARD,
      ...inputBase,
      kind: 'text',
      text: '输入',
      code: 'KeyA',
    })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
    expect(validateRemoteDesktopDataMessage({
      type: REMOTE_DESKTOP_DATA_MSG.RELEASE_ALL,
      ...inputBase,
    })).toMatchObject({ ok: true });
  });

  it('recognizes only daemon-to-server message types', () => {
    expect(isRemoteDesktopDaemonMessageType(REMOTE_DESKTOP_MSG.ANSWER)).toBe(true);
    expect(isRemoteDesktopDaemonMessageType(REMOTE_DESKTOP_MSG.MODE_STATE)).toBe(true);
    expect(isRemoteDesktopDaemonMessageType(REMOTE_DESKTOP_MSG.STATUS)).toBe(true);
    expect(isRemoteDesktopDaemonMessageType(REMOTE_DESKTOP_MSG.START)).toBe(false);
    expect(validateRemoteDesktopDaemonMessage({
      type: REMOTE_DESKTOP_MSG.STATUS,
      requestId,
      sessionId,
      capability,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      state: REMOTE_DESKTOP_STATE.RELAYED,
      route: 'relay',
      inputEnabled: false,
      selectedDisplayId: 'display-primary',
      layoutRevision: 1,
    })).toMatchObject({ ok: true });
    expect(validateRemoteDesktopDaemonMessage({
      type: REMOTE_DESKTOP_MSG.STATUS,
      requestId,
      sessionId,
      capability,
      mode: REMOTE_DESKTOP_ACCESS_MODE.CONTROL,
      inputEpoch: 1,
      state: REMOTE_DESKTOP_STATE.DIRECT,
      inputEnabled: false,
      selectedDisplayId: 'display-primary',
    })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
    expect(validateRemoteDesktopDaemonMessage({
      type: REMOTE_DESKTOP_MSG.STATUS,
      requestId,
      sessionId,
      mode: REMOTE_DESKTOP_ACCESS_MODE.VIEW,
      inputEpoch: 0,
      state: REMOTE_DESKTOP_STATE.DIRECT,
    })).toEqual({ ok: false, error: REMOTE_DESKTOP_ERROR.INVALID_REQUEST });
  });
});
