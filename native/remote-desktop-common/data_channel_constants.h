#ifndef IMCODES_REMOTE_DESKTOP_COMMON_DATA_CHANNEL_CONSTANTS_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_DATA_CHANNEL_CONSTANTS_H_

#include <cstddef>
#include <cstdint>

namespace imcodes::rd {

inline constexpr std::size_t kMaxDataMessageBytes = 16 * 1024;
inline constexpr char kControlChannel[] = "imcodes-rd-control";
inline constexpr char kKeyboardChannel[] = "imcodes-rd-keyboard";
inline constexpr char kPointerChannel[] = "imcodes-rd-pointer";

// DataChannel message type tokens. They live here rather than in
// json_protocol.h because that header pulls in JsonCpp, and the bounded payload
// parser must stay linkable without a Chromium checkout. Pinned to
// `REMOTE_DESKTOP_DATA_MSG` in shared/remote-desktop.ts by the cross-layer
// test.
inline constexpr char kTopologyType[] = "remote_desktop.data.display_topology";
inline constexpr char kQualityType[] = "remote_desktop.data.quality";
// `encoderClass` of a kQualityType message, pinned to
// REMOTE_DESKTOP_ENCODER_CLASS in shared/remote-desktop.ts by the same test. A
// worker reports what its encoder really is: claiming hardware for a software
// encoder hides exactly the machines where the picture needs explaining.
inline constexpr char kEncoderClassHardware[] = "hardware";
inline constexpr char kEncoderClassSoftware[] = "software";
// Worker to browser: which codec/encoder is actually producing the picture. A
// message type of its own, NOT extra keys on kQualityType: a viewer validates
// kQualityType with an exact key set, so an extra key would blank the status bar
// of every older web, whereas an older web silently ignores an unknown data
// message type. Pinned to REMOTE_DESKTOP_DATA_MSG.ENCODER, _ENCODER_CODEC and
// _ENCODER_RAW_CODECS in shared/remote-desktop.ts by the cross-layer test.
inline constexpr char kEncoderInfoType[] = "remote_desktop.data.encoder";
inline constexpr char kEncoderCodecVp9[] = "vp9";
inline constexpr char kEncoderCodecVp8[] = "vp8";
inline constexpr char kEncoderCodecH264[] = "h264";
inline constexpr char kEncoderCodecPending[] = "pending";
// `rawCodecs` of a kEncoderInfoType message: the node's decision on whether this
// route may send VP9/VP8, and why not when it may not.
inline constexpr char kRawCodecsAllowed[] = "allowed";
inline constexpr char kRawCodecsHardwareH264[] = "hardware_h264";
inline constexpr char kRawCodecsCaptureCannotScale[] = "capture_cannot_scale";
inline constexpr char kRawCodecsDisabledBySetting[] = "disabled_by_setting";
inline constexpr char kClipboardType[] = "remote_desktop.data.clipboard";
inline constexpr char kPointerType[] = "remote_desktop.data.pointer";
inline constexpr char kKeyboardType[] = "remote_desktop.data.keyboard";
inline constexpr char kControlType[] = "remote_desktop.data.control";
inline constexpr char kReleaseAllType[] = "remote_desktop.data.release_all";
// Worker to browser: a control command was understood but refused. Success is
// already visible in the topology and status frames; without this, a refusal is
// indistinguishable from a lost click.
inline constexpr char kControlRejectedType[] =
    "remote_desktop.data.control_rejected";

// `kind` of a kControlType message, pinned to REMOTE_DESKTOP_CONTROL_KIND in
// shared/remote-desktop.ts by the same cross-layer test. The browser keeps a
// 3 s timer after every reliable input transition (key/text, release_all,
// control-channel button) and treats a missing input_ack as a dead peer.
inline constexpr char kInputAckKind[] = "input_ack";
// Browser to worker: read the remote selection; answered with kClipboardType.
inline constexpr char kCopySelectionKind[] = "copy_selection";
// Browser to worker: paste text via bounded chunks; after assembly the host
// writes its OS clipboard once, then injects the platform paste shortcut once.
inline constexpr char kPasteTextKind[] = "paste_text";
inline constexpr char kHelloKind[] = "hello";
inline constexpr char kKeepaliveKind[] = "keepalive";

// Bounds pinned to REMOTE_DESKTOP_LIMITS in shared/remote-desktop.ts. At worst
// JSON escaping expands each byte to six, so a 2 KiB raw chunk remains below
// the 16 KiB data-frame cap.
inline constexpr std::size_t kMaxPasteTextBytes = 64 * 1024;
inline constexpr std::size_t kMaxPasteTextChunkBytes = 2 * 1024;
inline constexpr std::size_t kMaxPasteTextChunks =
    kMaxPasteTextBytes / kMaxPasteTextChunkBytes;
inline constexpr std::uint64_t kPasteTextTransferTimeoutMs = 10'000;

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_DATA_CHANNEL_CONSTANTS_H_
