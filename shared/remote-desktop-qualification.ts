import { REMOTE_DESKTOP_LIMITS, REMOTE_DESKTOP_QUALITY_LADDER } from './remote-desktop.js';

/**
 * Versioned, machine-readable release gate for the Windows remote desktop.
 * Lab tooling and tests consume this object; it contains no machine identity,
 * credentials, media, or user data.
 */
export const WINDOWS_REMOTE_DESKTOP_QUALIFICATION_PLAN = {
  version: 4,
  supportedWindows: [
    { family: 'windows_10', minimumBuild: 19045, architecture: 'x64' },
    { family: 'windows_11', minimumBuild: 22631, architecture: 'x64' },
  ],
  supportedBrowsers: [
    {
      family: 'chrome',
      releaseChannels: ['current_stable', 'previous_stable'],
      mediaQualified: true,
      physicalInputQualified: false,
    },
    {
      family: 'edge',
      releaseChannels: ['current_stable', 'previous_stable'],
      mediaQualified: true,
      physicalInputQualified: true,
    },
  ],
  encoderMatrix: [
    {
      vendor: 'intel', deviceClass: 'integrated_or_discrete', mode: 'hardware',
      qualificationEvidence: 'observed',
    },
    {
      vendor: 'amd', deviceClass: 'integrated_or_discrete', mode: 'hardware',
      qualificationEvidence: 'pending_additional_matrix',
    },
    {
      vendor: 'nvidia', deviceClass: 'discrete', mode: 'hardware',
      qualificationEvidence: 'pending_additional_matrix',
    },
    {
      vendor: 'platform_software', deviceClass: 'cpu', mode: 'software',
      qualificationEvidence: 'observed',
    },
  ],
  encoderPolicy: {
    vendorLocked: false,
    discreteGpuRequired: false,
    hardwareEncodingPreferred: true,
    softwareFallbackRequired: true,
  },
  routeMatrix: ['host', 'srflx', 'turn_udp', 'turn_tcp'],
  transportPolicy: {
    directIcePreferred: true,
    turnFallbackOnly: true,
    serverMediaRelayForbidden: true,
    serverInputRelayForbidden: true,
    httpPerInputEventForbidden: true,
  },
  mediaStackDecision: {
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
  },
  scenarios: [
    'active_1080p30',
    'native_2160p15',
    'static_desktop',
    'constrained_720p',
    'packet_loss_recovery',
    'monitor_tab_switch',
    'monitor_hotplug',
    'dpi_rotation_change',
    'suspend_resume',
    'service_reconnect',
    'share_revocation',
    'local_user_stop',
    'five_minute_stability',
  ],
  thresholds: {
    legacyMinimumDecodedFps: 8,
    directFrameLatencyP95Ms: 150,
    relayedFrameLatencyP95Ms: 300,
    directInputToPhotonP95Ms: 200,
    relayedInputToPhotonP95Ms: 350,
    packetLossRecoveryMs: 2_000,
    reconnectRecoveryMs: 5_000,
    teardownMs: 2_000,
    activeProcessCpuPercent: 40,
    activeGpuVideoEncodePercent: 80,
    processWorkingSetBytes: 512 * 1024 * 1024,
    staticDesktopBitrateBps: 250_000,
    droppedFramePercent: 3,
    maxEncoderQueueFrames: REMOTE_DESKTOP_LIMITS.MAX_ENCODER_QUEUE_FRAMES,
  },
  sessionLimits: {
    negotiationTimeoutMs: REMOTE_DESKTOP_LIMITS.NEGOTIATION_TIMEOUT_MS,
    leaseDurationMs: REMOTE_DESKTOP_LIMITS.LEASE_DURATION_MS,
    leaseRenewIntervalMs: REMOTE_DESKTOP_LIMITS.LEASE_RENEW_INTERVAL_MS,
    idleTimeoutMs: REMOTE_DESKTOP_LIMITS.IDLE_TIMEOUT_MS,
    absoluteLifetimeMs: REMOTE_DESKTOP_LIMITS.ABSOLUTE_LIFETIME_MS,
    reconnectStabilityResetMs: REMOTE_DESKTOP_LIMITS.RECONNECT_STABILITY_RESET_MS,
    maxPerBrowser: REMOTE_DESKTOP_LIMITS.MAX_PER_BROWSER,
    maxPerMachine: REMOTE_DESKTOP_LIMITS.MAX_PER_MACHINE,
  },
  qualityLadder: REMOTE_DESKTOP_QUALITY_LADDER,
  prohibitedProductionMediaPaths: [
    'computer_use_screenshot_polling',
    'jpeg_frame_stream',
    'png_frame_stream',
    'webp_frame_stream',
    'raw_frame_data_channel',
    'custom_image_delta',
    'custom_video_codec',
    'custom_rtp_or_congestion_control',
  ],
} as const;
