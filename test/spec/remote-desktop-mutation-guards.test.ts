import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

const SOURCE_PATHS = [
  'shared/remote-desktop.ts',
  'server/src/ws/remote-desktop-router.ts',
  'web/src/remote-desktop-client.ts',
  'web/src/components/RemoteDesktopPanel.tsx',
  'native/windows-remote-desktop/worker_main.cc',
  'native/windows-remote-desktop/local_indicator.cc',
  'native/windows-remote-desktop/input_injector.cc',
  'native/windows-remote-desktop/peer_session.cc',
  'native/windows-remote-desktop/display_capture.cc',
  'native/windows-remote-desktop/mf_h264_encoder.cc',
  'native/windows-remote-desktop/mf_h264_encoder.h',
  'native/windows-remote-desktop/virtual_display_controller.cc',
  'native/windows-remote-desktop/worker_policy.cc',
  'native/windows-remote-desktop/worker_policy.h',
  'native/windows-virtual-display/virtual_display_driver.cc',
  'native/windows-virtual-display/imcodes-virtual-display.inf',
  'src/node/remote-desktop-worker-host.ts',
  'src/node/self-upgrade.ts',
  'src/node/windows-user-session.ts',
  'scripts/build-node-exe.mjs',
  'scripts/windows-sign-release-artifact.ps1',
] as const;

type SourcePath = (typeof SOURCE_PATHS)[number];
type Sources = Record<SourcePath, string>;

interface Guard {
  path: SourcePath;
  needle: string;
  minimum?: number;
}

interface Contract {
  name: string;
  guards: Guard[];
}

interface Mutation {
  name: string;
  contract: string;
  path: SourcePath;
  needle: string;
}

function loadSources(): Sources {
  return Object.fromEntries(SOURCE_PATHS.map((path) => [
    path,
    readFileSync(resolve(ROOT, path), 'utf8'),
  ])) as Sources;
}

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

const contracts: Contract[] = [
  {
    name: 'continuous access revalidation',
    guards: [
      {
        path: 'server/src/ws/remote-desktop-router.ts',
        needle: 'this.hooks.resolveAccess ?? resolveControlledMachineAccess',
        minimum: 2,
      },
      {
        path: 'server/src/ws/remote-desktop-router.ts',
        needle: 'this.revalidationFailure(access)',
      },
    ],
  },
  {
    name: 'requester socket and daemon generation binding',
    guards: [
      {
        path: 'server/src/ws/remote-desktop-router.ts',
        needle: 'route.socket !== socket',
      },
      {
        path: 'server/src/ws/remote-desktop-router.ts',
        needle: 'route.daemonGeneration !== this.hooks.daemonGeneration()',
      },
    ],
  },
  {
    name: 'bounded lease teardown',
    guards: [
      {
        path: 'server/src/ws/remote-desktop-router.ts',
        needle: 'route.leaseExpiresAt <= this.now()',
      },
      {
        path: 'server/src/ws/remote-desktop-router.ts',
        needle: 'this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.LEASE_EXPIRED, true)',
      },
      {
        path: 'server/src/ws/remote-desktop-router.ts',
        needle: 'clearTimeout(route.leaseTimer)',
      },
    ],
  },
  {
    name: 'browser and worker release-all',
    guards: [
      {
        path: 'web/src/remote-desktop-client.ts',
        needle: 'this.releaseAll();',
        minimum: 5,
      },
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'input_->ReleaseOwner(authority_.session_id)',
      },
    ],
  },
  {
    name: 'pointer cancellation preserves held modifiers',
    guards: [
      {
        path: 'web/src/components/RemoteDesktopPanel.tsx',
        needle: 'clientRef.current?.releasePointerButtons();',
        minimum: 2,
      },
      {
        path: 'web/src/remote-desktop-client.ts',
        needle: 'releasePointerButtons(): void {',
      },
      {
        path: 'web/src/remote-desktop-client.ts',
        needle: 'kind: REMOTE_DESKTOP_POINTER_KIND.BUTTON_UP,',
      },
    ],
  },
  {
    name: 'layout-correlated input enable and explicit removed-display choice',
    guards: [
      {
        path: 'web/src/remote-desktop-client.ts',
        needle: 'const statusMatchesConsumedTopology =',
      },
      {
        path: 'web/src/remote-desktop-client.ts',
        needle: 'message.layoutRevision === this.snapshot.layoutRevision',
      },
      {
        path: 'shared/remote-desktop.ts',
        needle: "FRAME_PRESENTED: 'frame_presented',",
      },
      {
        path: 'web/src/components/RemoteDesktopPanel.tsx',
        needle: 'video.requestVideoFrameCallback(onPresentedFrame)',
        minimum: 2,
      },
      {
        path: 'web/src/remote-desktop-client.ts',
        needle: 'acknowledgePresentedFrame(frameWidth: number, frameHeight: number): boolean {',
      },
      {
        path: 'web/src/remote-desktop-client.ts',
        needle: 'const statusMatchesPresentedFrame =',
      },
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: '} else if (kind == "frame_presented") {',
      },
      {
        path: 'native/windows-remote-desktop/worker_policy.cc',
        needle: 'bool PresentedFrameMatchesDisplay(',
      },
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'DisplaySelectionRequiresExplicitChoice(candidates, previous_id)',
      },
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: '&& !selection_required_',
      },
    ],
  },
  {
    name: 'DXGI production capture wiring',
    guards: [
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'DxgiDesktopSource::Create(',
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'source->Start();',
      },
    ],
  },
  {
    name: 'display-stack reset and bounded worker recovery',
    guards: [
      {
        path: 'native/windows-remote-desktop/local_indicator.cc',
        needle: 'case WM_DWMCOMPOSITIONCHANGED:',
      },
      {
        path: 'native/windows-remote-desktop/local_indicator.cc',
        needle: 'environment_changed_(kEnvironmentCompositionChanged);',
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'AdvanceTopologyRefreshDebounce(topology_refresh_requested,',
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'CurrentDwmProcessIdForCurrentSession()',
        minimum: 2,
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'AdvanceCompositorProcessGeneration(',
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'TerminateProcess(GetCurrentProcess(), 16);',
        minimum: 2,
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'TerminateProcess(GetCurrentProcess(), 15);',
      },
    ],
  },
  {
    name: 'exact selected-display pointer positioning',
    guards: [
      {
        path: 'native/windows-remote-desktop/input_injector.cc',
        needle: 'if (move_pointer_) return move_pointer_(pixel_x, pixel_y);',
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'indicator && indicator->MovePointer(x, y)',
      },
      {
        path: 'native/windows-remote-desktop/local_indicator.cc',
        needle: 'SetCursorPos(request->x, request->y) == TRUE',
      },
    ],
  },
  {
    name: 'bounded empty-topology grace under transient DXGI dips',
    guards: [
      {
        path: 'native/windows-remote-desktop/worker_policy.h',
        needle: 'kEmptyTopologyGraceTicks',
      },
      {
        path: 'native/windows-remote-desktop/worker_policy.h',
        needle: 'AdvanceEmptyTopologyConsecutive(int* consecutive_empty_ticks)',
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'AdvanceEmptyTopologyConsecutive(&empty_topology_ticks_)',
        minimum: 2,
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'empty_topology_ticks_ = 0;',
      },
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'if (displays.empty()) return true;',
      },
    ],
  },
  {
    name: 'presentable first-frame admission',
    guards: [
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'candidate->WaitForFirstFrame(',
      },
      {
        path: 'native/windows-remote-desktop/display_capture.cc',
        needle: 'first_frame_condition_.wait_for(',
      },
    ],
  },
  {
    name: 'exact reversible virtual-display activation',
    guards: [
      {
        path: 'native/windows-virtual-display/virtual_display_driver.cc',
        needle: 'monitor.MonitorType = DISPLAYCONFIG_OUTPUT_TECHNOLOGY_HDMI;',
      },
      {
        path: 'native/windows-remote-desktop/virtual_display_controller.cc',
        needle: 'lstrcmpW(device.DeviceString, L"IM.codes Headless Display")',
      },
      {
        path: 'native/windows-remote-desktop/virtual_display_controller.cc',
        needle: 'lstrcmpiW(device.DeviceID, kEnumerator)',
      },
      {
        path: 'native/windows-remote-desktop/virtual_display_controller.cc',
        needle: 'CDS_UPDATEREGISTRY | CDS_NORESET',
      },
      {
        path: 'src/node/remote-desktop-worker-host.ts',
        needle: "launchWindowsActiveUserCommand(executable, '--activate-virtual-display')",
      },
    ],
  },
  {
    name: 'disconnected console user-session fallback',
    guards: [
      {
        path: 'src/node/windows-user-session.ts',
        needle: 'WTSGetActiveConsoleSessionId',
        minimum: 2,
      },
      {
        path: 'src/node/windows-user-session.ts',
        needle: 's.State == WTSDisconnected',
      },
      {
        path: 'src/node/windows-user-session.ts',
        needle: 's.SessionID <= 0 || !HasUserToken(s.SessionID)',
      },
      {
        path: 'src/node/windows-user-session.ts',
        needle: 'activeCandidate == -2',
      },
    ],
  },
  {
    name: 'pre-login and lock-screen secure console handoff',
    guards: [
      {
        path: 'src/node/windows-user-session.ts',
        needle: 'Process.GetProcessesByName("LogonUI")',
      },
      {
        path: 'src/node/windows-user-session.ts',
        needle: 'WindowsIdentity.GetCurrent().User.Value != "S-1-5-18"',
      },
      {
        path: 'src/node/windows-user-session.ts',
        needle: 'SetTokenInformation(primary, TokenSessionId, ref sid, sizeof(int))',
      },
      {
        path: 'src/node/windows-user-session.ts',
        needle: 'argsLine + " --secure-console"',
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'arguments->secure_console && !IsLocalSystemProcess()',
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'secure_console_ ? L"Winlogon" : L"Default"',
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'TerminateProcess(GetCurrentProcess(), 17)',
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'WorkerClipboardAllowed(secure_console_)',
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'WorkerInputDesktopAllowed(',
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'CaptureFallback::kSecureDesktopGdi',
      },
      {
        path: 'native/windows-remote-desktop/display_capture.cc',
        needle: 'CaptureSecureDesktopGdi()',
      },
    ],
  },
  {
    name: 'worker never opens the platform audio device',
    guards: [
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'dependencies.adm = webrtc::make_ref_counted<SilentAudioDeviceModule>()',
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'AudioDeviceModuleDefault<',
      },
    ],
  },
  {
    name: 'Windows 10 and 11 UMDF reflector compatibility',
    guards: [
      {
        path: 'native/windows-virtual-display/imcodes-virtual-display.inf',
        needle: 'AddService=WUDFRd,0x000001fa,WUDFRD_ServiceInstall',
      },
      {
        path: 'native/windows-virtual-display/imcodes-virtual-display.inf',
        needle: 'ServiceBinary=%12%\\WUDFRd.sys',
      },
    ],
  },
  {
    name: 'Windows WebRTC socket and trickle ICE readiness',
    guards: [
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'webrtc::WinsockInitializer winsock;',
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'if (winsock.error() != 0) return 14;',
      },
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'pending_remote_ice_.Push(mid, candidate)',
      },
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'FlushPendingRemoteIce()',
      },
    ],
  },
  {
    name: 'upstream WebRTC desktop quality allocation',
    guards: [
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'webrtc::VideoTrackInterface::ContentHint::kDetailed',
      },
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'encoding.max_bitrate_bps = static_cast<int>(kPerPeerVideoBitrateBps)',
      },
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'bitrate_settings.start_bitrate_bps =',
      },
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'webrtc::DegradationPreference::MAINTAIN_RESOLUTION',
      },
    ],
  },
  {
    name: 'sticky hardware encoder fallback across rate changes',
    guards: [
      {
        path: 'native/windows-remote-desktop/mf_h264_encoder.h',
        needle: 'bool hardware_disqualified_ = false;',
      },
      {
        path: 'native/windows-remote-desktop/mf_h264_encoder.cc',
        needle: 'ShouldAttemptHardwareEncoder(prefer_hardware_, hardware_disqualified_)',
        minimum: 2,
      },
      {
        path: 'native/windows-remote-desktop/mf_h264_encoder.cc',
        needle: 'hardware_disqualified_ = true;',
        minimum: 3,
      },
    ],
  },
  {
    name: 'signed worker software encoder qualification override',
    guards: [
      {
        path: 'native/windows-remote-desktop/mf_h264_encoder.cc',
        needle: 'IMCODES_REMOTE_DESKTOP_ENCODER_MODE',
      },
      {
        path: 'native/windows-remote-desktop/mf_h264_encoder.cc',
        needle: 'HardwareEncoderAllowedByEnvironment()',
        minimum: 2,
      },
    ],
  },
  {
    name: 'native media progress circuit breaker',
    guards: [
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'session->CheckMediaProgress();',
      },
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'MediaProgressShouldFailover(',
      },
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'DisqualifyHardwareEncoderForProcess();',
      },
    ],
  },
  {
    name: 'reconnect forces process-local software encoder recovery',
    guards: [
      {
        path: 'server/src/ws/remote-desktop-router.ts',
        needle: 'reconnectAttempt: route.reconnectAttempt',
        minimum: 2,
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'signal.authority.reconnect_attempt > 0',
      },
      {
        path: 'native/windows-remote-desktop/worker_main.cc',
        needle: 'DisqualifyHardwareEncoderForProcess();',
      },
    ],
  },
  {
    name: 'bounded native media teardown before reconnect',
    guards: [
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'SetTrack(nullptr)',
      },
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'if (source_ && release_source_) release_source_(source_->display());',
      },
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'if (previous_display && release_source_) release_source_(*previous_display);',
      },
    ],
  },
  {
    name: 'native input channel accepts initial zero sequence without replay',
    guards: [
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'InputSequenceIsFresh(previous != last_sequence_by_channel_.end()',
      },
      {
        path: 'native/windows-remote-desktop/worker_policy.cc',
        needle: 'return !has_previous || current_sequence > previous_sequence;',
      },
    ],
  },
  {
    name: 'native video rendering',
    guards: [
      {
        path: 'web/src/components/RemoteDesktopPanel.tsx',
        needle: '<video',
      },
      {
        path: 'web/src/components/RemoteDesktopPanel.tsx',
        needle: 'ref={videoRef}',
      },
    ],
  },
  {
    name: 'reviewed TURN conversion',
    guards: [
      {
        path: 'web/src/remote-desktop-client.ts',
        needle: 'toWebRtcIceServers(authority.iceServers)',
      },
    ],
  },
  {
    name: 'existing file-transfer reuse',
    guards: [
      {
        path: 'web/src/components/RemoteDesktopPanel.tsx',
        needle: 'uploadFileWithDirectFallback({',
      },
      {
        path: 'web/src/components/RemoteDesktopPanel.tsx',
        needle: 'createMachineFileHandle(machine.serverId, path, controller.signal)',
      },
    ],
  },
  {
    name: 'per-display fixed resolution switching',
    guards: [
      {
        path: 'shared/remote-desktop.ts',
        needle: "SET_DISPLAY_MODE: 'set_display_mode',",
      },
      {
        path: 'web/src/remote-desktop-client.ts',
        needle: 'kind: REMOTE_DESKTOP_CONTROL_KIND.SET_DISPLAY_MODE,',
      },
      {
        path: 'web/src/remote-desktop-client.ts',
        needle: 'const LAYOUT_TRANSITION_TIMEOUT_MS = 5_000;',
      },
      {
        path: 'web/src/components/RemoteDesktopPanel.tsx',
        needle: 'onContextMenu={(event) => {',
      },
      {
        path: 'web/src/components/RemoteDesktopPanel.tsx',
        needle: 'onPointerDown={(event) => beginDisplayTabLongPress(event, display.id)}',
      },
      {
        path: 'native/windows-remote-desktop/worker_policy.cc',
        needle: 'bool IsAllowedRemoteDisplayMode(int width, int height)',
      },
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'ChangeDisplaySettingsExW(found->device_name.c_str(), &mode, nullptr,',
        minimum: 2,
      },
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'return restore_current_status();',
        minimum: 3,
      },
    ],
  },
  {
    name: 'real-display hotplug preference',
    guards: [
      {
        path: 'native/windows-remote-desktop/worker_policy.cc',
        needle: '!preferred->imcodes_virtual || real_available == candidates.end()',
      },
      {
        path: 'native/windows-remote-desktop/peer_session.cc',
        needle: 'display.imcodes_virtual});',
      },
    ],
  },
  {
    name: 'signed Windows worker launch and driver copy boundary',
    guards: [
      {
        path: 'scripts/build-node-exe.mjs',
        needle: "runWindowsReleaseSigning('Sign', outPath, windowsReleaseSignerSha256);",
      },
      {
        path: 'scripts/windows-sign-release-artifact.ps1',
        needle: '$ActualSignerSha256 -cne $ExpectedSignerSha256.ToLowerInvariant()',
      },
      {
        path: 'scripts/build-node-exe.mjs',
        needle: "runWindowsReleaseSigning('Remove', destination);",
      },
      {
        path: 'scripts/build-node-exe.mjs',
        needle: '__IMCODES_WINDOWS_RELEASE_SIGNER_SHA256__',
      },
      {
        path: 'src/node/remote-desktop-worker-host.ts',
        needle: 'verifyRemoteDesktopWorkerArtifactForLaunch',
        minimum: 2,
      },
      {
        path: 'src/node/remote-desktop-worker-host.ts',
        needle: 'await this.verifiedArtifactForLaunch()',
        minimum: 3,
      },
      {
        path: 'src/node/self-upgrade.ts',
        needle: '& $verifyRemoteDesktopArtifactSet $pendingRemoteDesktop',
      },
      {
        path: 'src/node/self-upgrade.ts',
        needle: '& $verifyRemoteDesktopArtifactSet $dstRemoteDesktop',
      },
    ],
  },
  {
    name: 'sticky hardware fallback and null-safe encoder drain',
    guards: [
      {
        path: 'native/windows-remote-desktop/mf_h264_encoder.cc',
        needle: 'DisqualifyHardwareEncoderForProcess();',
      },
      {
        path: 'native/windows-remote-desktop/mf_h264_encoder.cc',
        needle: 'if (transform_)\n      transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);',
      },
    ],
  },
  {
    name: 'nonblocking named-pipe ACL before active-user launch',
    guards: [
      {
        path: 'src/node/windows-user-session.ts',
        needle: 'return new Promise((resolve, reject) => {',
      },
      {
        path: 'src/node/remote-desktop-worker-host.ts',
        needle: 'await (this.options.allowPipeClients',
      },
    ],
  },
];

const mutations: Mutation[] = [
  {
    name: 'let the media engine build the platform audio device',
    contract: 'worker never opens the platform audio device',
    path: 'native/windows-remote-desktop/worker_main.cc',
    needle: 'dependencies.adm = webrtc::make_ref_counted<SilentAudioDeviceModule>()',
  },
  {
    name: 'remove access revalidation',
    contract: 'continuous access revalidation',
    path: 'server/src/ws/remote-desktop-router.ts',
    needle: 'this.hooks.resolveAccess ?? resolveControlledMachineAccess',
  },
  {
    name: 'remove requester socket binding',
    contract: 'requester socket and daemon generation binding',
    path: 'server/src/ws/remote-desktop-router.ts',
    needle: 'route.socket !== socket',
  },
  {
    name: 'remove daemon generation binding',
    contract: 'requester socket and daemon generation binding',
    path: 'server/src/ws/remote-desktop-router.ts',
    needle: 'route.daemonGeneration !== this.hooks.daemonGeneration()',
  },
  {
    name: 'remove lease expiry teardown',
    contract: 'bounded lease teardown',
    path: 'server/src/ws/remote-desktop-router.ts',
    needle: 'this.failRoute(route, REMOTE_DESKTOP_TERMINAL_REASON.LEASE_EXPIRED, true)',
  },
  {
    name: 'remove browser release-all',
    contract: 'browser and worker release-all',
    path: 'web/src/remote-desktop-client.ts',
    needle: 'this.releaseAll();',
  },
  {
    name: 'restore modifier-dropping pointer cancellation',
    contract: 'pointer cancellation preserves held modifiers',
    path: 'web/src/components/RemoteDesktopPanel.tsx',
    needle: 'clientRef.current?.releasePointerButtons();',
  },
  {
    name: 'remove selective pointer-button release',
    contract: 'pointer cancellation preserves held modifiers',
    path: 'web/src/remote-desktop-client.ts',
    needle: 'releasePointerButtons(): void {',
  },
  {
    name: 'remove browser status-layout correlation',
    contract: 'layout-correlated input enable and explicit removed-display choice',
    path: 'web/src/remote-desktop-client.ts',
    needle: 'const statusMatchesConsumedTopology =',
  },
  {
    name: 'remove browser presented-frame correlation',
    contract: 'layout-correlated input enable and explicit removed-display choice',
    path: 'web/src/remote-desktop-client.ts',
    needle: 'const statusMatchesPresentedFrame =',
  },
  {
    name: 'remove native presented-frame acknowledgement gate',
    contract: 'layout-correlated input enable and explicit removed-display choice',
    path: 'native/windows-remote-desktop/peer_session.cc',
    needle: '} else if (kind == "frame_presented") {',
  },
  {
    name: 'remove explicit selection after selected display removal',
    contract: 'layout-correlated input enable and explicit removed-display choice',
    path: 'native/windows-remote-desktop/peer_session.cc',
    needle: 'DisplaySelectionRequiresExplicitChoice(candidates, previous_id)',
  },
  {
    name: 'remove worker release-all',
    contract: 'browser and worker release-all',
    path: 'native/windows-remote-desktop/peer_session.cc',
    needle: 'input_->ReleaseOwner(authority_.session_id)',
  },
  {
    name: 'remove DXGI source creation',
    contract: 'DXGI production capture wiring',
    path: 'native/windows-remote-desktop/worker_main.cc',
    needle: 'DxgiDesktopSource::Create(',
  },
  {
    name: 'remove first-frame admission wait',
    contract: 'presentable first-frame admission',
    path: 'native/windows-remote-desktop/peer_session.cc',
    needle: 'candidate->WaitForFirstFrame(',
  },
  {
    name: 'remove exact virtual-display identity guard',
    contract: 'exact reversible virtual-display activation',
    path: 'native/windows-remote-desktop/virtual_display_controller.cc',
    needle: 'lstrcmpW(device.DeviceString, L"IM.codes Headless Display")',
  },
  {
    name: 'restore Windows 10-unavailable internal connector semantics',
    contract: 'exact reversible virtual-display activation',
    path: 'native/windows-virtual-display/virtual_display_driver.cc',
    needle: 'monitor.MonitorType = DISPLAYCONFIG_OUTPUT_TECHNOLOGY_HDMI;',
  },
  {
    name: 'remove disconnected console fallback',
    contract: 'disconnected console user-session fallback',
    path: 'src/node/windows-user-session.ts',
    needle: 's.State == WTSDisconnected',
  },
  {
    name: 'remove Windows 10 UMDF function-driver association',
    contract: 'Windows 10 and 11 UMDF reflector compatibility',
    path: 'native/windows-virtual-display/imcodes-virtual-display.inf',
    needle: 'AddService=WUDFRd,0x000001fa,WUDFRD_ServiceInstall',
  },
  {
    name: 'remove Winsock initialization',
    contract: 'Windows WebRTC socket and trickle ICE readiness',
    path: 'native/windows-remote-desktop/worker_main.cc',
    needle: 'webrtc::WinsockInitializer winsock;',
  },
  {
    name: 'remove pre-SDP trickle ICE queueing',
    contract: 'Windows WebRTC socket and trickle ICE readiness',
    path: 'native/windows-remote-desktop/peer_session.cc',
    needle: 'pending_remote_ice_.Push(mid, candidate)',
  },
  {
    name: 'remove upstream desktop bitrate allocation',
    contract: 'upstream WebRTC desktop quality allocation',
    path: 'native/windows-remote-desktop/peer_session.cc',
    needle: 'encoding.max_bitrate_bps = static_cast<int>(kPerPeerVideoBitrateBps)',
  },
  {
    name: 'remove native video element',
    contract: 'native video rendering',
    path: 'web/src/components/RemoteDesktopPanel.tsx',
    needle: '<video',
  },
  {
    name: 'remove native media progress maintenance wiring',
    contract: 'native media progress circuit breaker',
    path: 'native/windows-remote-desktop/worker_main.cc',
    needle: 'session->CheckMediaProgress();',
  },
  {
    name: 'restore rejection of the first zero sequence',
    contract: 'native input channel accepts initial zero sequence without replay',
    path: 'native/windows-remote-desktop/worker_policy.cc',
    needle: 'return !has_previous || current_sequence > previous_sequence;',
  },
  {
    name: 'remove reconnect software recovery gate',
    contract: 'reconnect forces process-local software encoder recovery',
    path: 'native/windows-remote-desktop/worker_main.cc',
    needle: 'signal.authority.reconnect_attempt > 0',
  },
  {
    name: 'remove pre-close video sender detachment',
    contract: 'bounded native media teardown before reconnect',
    path: 'native/windows-remote-desktop/peer_session.cc',
    needle: 'SetTrack(nullptr)',
  },
  {
    name: 'remove capture-source release on media teardown',
    contract: 'bounded native media teardown before reconnect',
    path: 'native/windows-remote-desktop/peer_session.cc',
    needle: 'if (source_ && release_source_) release_source_(source_->display());',
  },
  {
    name: 'remove old capture-source release after successful replacement',
    contract: 'bounded native media teardown before reconnect',
    path: 'native/windows-remote-desktop/peer_session.cc',
    needle: 'if (previous_display && release_source_) release_source_(*previous_display);',
  },
  {
    name: 'remove reviewed TURN conversion',
    contract: 'reviewed TURN conversion',
    path: 'web/src/remote-desktop-client.ts',
    needle: 'toWebRtcIceServers(authority.iceServers)',
  },
  {
    name: 'remove direct upload reuse',
    contract: 'existing file-transfer reuse',
    path: 'web/src/components/RemoteDesktopPanel.tsx',
    needle: 'uploadFileWithDirectFallback({',
  },
  {
    name: 'remove controlled fetch reuse',
    contract: 'existing file-transfer reuse',
    path: 'web/src/components/RemoteDesktopPanel.tsx',
    needle: 'createMachineFileHandle(machine.serverId, path, controller.signal)',
  },
  {
    name: 'remove fixed resolution protocol kind',
    contract: 'per-display fixed resolution switching',
    path: 'shared/remote-desktop.ts',
    needle: "SET_DISPLAY_MODE: 'set_display_mode',",
  },
  {
    name: 'remove browser resolution command',
    contract: 'per-display fixed resolution switching',
    path: 'web/src/remote-desktop-client.ts',
    needle: 'kind: REMOTE_DESKTOP_CONTROL_KIND.SET_DISPLAY_MODE,',
  },
  {
    name: 'remove bounded layout-transition timer',
    contract: 'per-display fixed resolution switching',
    path: 'web/src/remote-desktop-client.ts',
    needle: 'const LAYOUT_TRANSITION_TIMEOUT_MS = 5_000;',
  },
  {
    name: 'remove display-tab context menu gesture',
    contract: 'per-display fixed resolution switching',
    path: 'web/src/components/RemoteDesktopPanel.tsx',
    needle: 'onContextMenu={(event) => {',
  },
  {
    name: 'remove mobile display-tab long press',
    contract: 'per-display fixed resolution switching',
    path: 'web/src/components/RemoteDesktopPanel.tsx',
    needle: 'onPointerDown={(event) => beginDisplayTabLongPress(event, display.id)}',
  },
  {
    name: 'remove native display-mode allowlist',
    contract: 'per-display fixed resolution switching',
    path: 'native/windows-remote-desktop/worker_policy.cc',
    needle: 'bool IsAllowedRemoteDisplayMode(int width, int height)',
  },
  {
    name: 'remove native unsupported-mode recovery',
    contract: 'per-display fixed resolution switching',
    path: 'native/windows-remote-desktop/peer_session.cc',
    needle: 'return restore_current_status();',
  },
  {
    name: 'remove real-display hotplug preference',
    contract: 'real-display hotplug preference',
    path: 'native/windows-remote-desktop/worker_policy.cc',
    needle: '!preferred->imcodes_virtual || real_available == candidates.end()',
  },
  {
    name: 'remove runtime Authenticode verification',
    contract: 'signed Windows worker launch and driver copy boundary',
    path: 'src/node/remote-desktop-worker-host.ts',
    needle: 'verifyRemoteDesktopWorkerArtifactForLaunch',
  },
  {
    name: 'remove copied driver-package verification',
    contract: 'signed Windows worker launch and driver copy boundary',
    path: 'src/node/self-upgrade.ts',
    needle: '& $verifyRemoteDesktopArtifactSet $pendingRemoteDesktop',
  },
  {
    name: 'remove process-level encoder fuse',
    contract: 'sticky hardware fallback and null-safe encoder drain',
    path: 'native/windows-remote-desktop/mf_h264_encoder.cc',
    needle: 'DisqualifyHardwareEncoderForProcess();',
  },
  {
    name: 'remove post-drain null guard',
    contract: 'sticky hardware fallback and null-safe encoder drain',
    path: 'native/windows-remote-desktop/mf_h264_encoder.cc',
    needle: 'if (transform_)\n      transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);',
  },
  {
    name: 'restore synchronous pipe ACL wait',
    contract: 'nonblocking named-pipe ACL before active-user launch',
    path: 'src/node/windows-user-session.ts',
    needle: 'return new Promise((resolve, reject) => {',
  },
  {
    name: 'remove DWM restart observation',
    contract: 'display-stack reset and bounded worker recovery',
    path: 'native/windows-remote-desktop/local_indicator.cc',
    needle: 'case WM_DWMCOMPOSITIONCHANGED:',
  },
  {
    name: 'remove DWM media-reset dispatch',
    contract: 'display-stack reset and bounded worker recovery',
    path: 'native/windows-remote-desktop/local_indicator.cc',
    needle: 'environment_changed_(kEnvironmentCompositionChanged);',
  },
  {
    name: 'remove topology stabilization debounce',
    contract: 'display-stack reset and bounded worker recovery',
    path: 'native/windows-remote-desktop/worker_main.cc',
    needle: 'AdvanceTopologyRefreshDebounce(topology_refresh_requested,',
  },
  {
    name: 'remove bounded native worker teardown',
    contract: 'display-stack reset and bounded worker recovery',
    path: 'native/windows-remote-desktop/worker_main.cc',
    needle: 'TerminateProcess(GetCurrentProcess(), 15);',
  },
  {
    name: 'remove active DWM process restart detection',
    contract: 'display-stack reset and bounded worker recovery',
    path: 'native/windows-remote-desktop/worker_main.cc',
    needle: 'AdvanceCompositorProcessGeneration(',
  },
  {
    name: 'remove bounded DWM recovery teardown',
    contract: 'display-stack reset and bounded worker recovery',
    path: 'native/windows-remote-desktop/worker_main.cc',
    needle: 'TerminateProcess(GetCurrentProcess(), 16);',
  },
  {
    name: 'restore normalized pointer movement on the production path',
    contract: 'exact selected-display pointer positioning',
    path: 'native/windows-remote-desktop/input_injector.cc',
    needle: 'if (move_pointer_) return move_pointer_(pixel_x, pixel_y);',
  },
  {
    name: 'remove exact interactive-desktop pointer dispatch',
    contract: 'exact selected-display pointer positioning',
    path: 'native/windows-remote-desktop/local_indicator.cc',
    needle: 'SetCursorPos(request->x, request->y) == TRUE',
  },
  {
    name: 'remove empty-topology grace helper declaration',
    contract: 'bounded empty-topology grace under transient DXGI dips',
    path: 'native/windows-remote-desktop/worker_policy.h',
    needle: 'kEmptyTopologyGraceTicks',
  },
  {
    name: 'remove empty-topology grace wiring in worker_main',
    contract: 'bounded empty-topology grace under transient DXGI dips',
    path: 'native/windows-remote-desktop/worker_main.cc',
    needle: 'AdvanceEmptyTopologyConsecutive(&empty_topology_ticks_)',
  },
  {
    name: 'restore hard-fail on transient empty topology in peer_session',
    contract: 'bounded empty-topology grace under transient DXGI dips',
    path: 'native/windows-remote-desktop/peer_session.cc',
    needle: 'if (displays.empty()) return true;',
  },
];

function contractHolds(contract: Contract, sources: Sources): boolean {
  return contract.guards.every((guard) => (
    occurrences(sources[guard.path], guard.needle) >= (guard.minimum ?? 1)
  ));
}

describe('remote desktop load-bearing mutation guards', () => {
  const sources = loadSources();

  it.each(contracts)('keeps $name wired in production', (contract) => {
    expect(contractHolds(contract, sources)).toBe(true);
  });

  it.each(mutations)('$name makes its contract fail', (mutation) => {
    const contract = contracts.find((candidate) => candidate.name === mutation.contract);
    expect(contract).toBeDefined();
    const mutatedSources = {
      ...sources,
      [mutation.path]: sources[mutation.path].split(mutation.needle).join(''),
    };
    expect(contractHolds(contract!, mutatedSources)).toBe(false);
  });

  it('never clears the per-instance hardware fuse during InitEncode', () => {
    const encoder = sources['native/windows-remote-desktop/mf_h264_encoder.cc'];
    const init = encoder.slice(encoder.indexOf('int MfH264Encoder::InitEncode'), encoder.indexOf('int32_t MfH264Encoder::RegisterEncodeCompleteCallback'));
    expect(init).not.toContain('hardware_disqualified_ = false');
  });

  it('keeps the current video track during a transient display-source replacement failure', () => {
    const peer = sources['native/windows-remote-desktop/peer_session.cc'];
    const refresh = peer.slice(
      peer.indexOf('bool PeerSession::RefreshDisplays'),
      peer.indexOf('void PeerSession::OnDataChannel'),
    );
    expect(refresh).not.toContain('SetTrack(nullptr)');
    expect(refresh).toContain('if (!video_sender) return true;');
    expect(refresh).toContain('if (!next_source) return true;');
    expect(refresh.indexOf('auto next_source = acquire_source_(*selected);'))
      .toBeLessThan(refresh.indexOf('video_sender->SetTrack(next_track.get())'));
  });

  it('never invokes icacls synchronously on the remote-desktop daemon event loop', () => {
    expect(sources['src/node/windows-user-session.ts']).not.toContain('execFileSync');
    expect(sources['src/node/remote-desktop-worker-host.ts']).not.toContain('allowWindowsNamedPipeClientsSync');
  });
});
