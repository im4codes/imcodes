#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_MEDIA_SENDER_BINDER_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_MEDIA_SENDER_BINDER_H_

#include <cstdint>
#include <memory>
#include <mutex>

#include "h264_sender_bridge.h"

namespace imcodes::remote_desktop::macos {

// Identity of one Bind()/Unbind() pairing. Opaque; only equality is meaningful.
using MediaSenderBindingId = std::uint64_t;
inline constexpr MediaSenderBindingId kInvalidMediaSenderBinding = 0;

// Bridges an ownership-order mismatch that is inherent to upstream WebRTC, not
// an artefact of this project.
//
// MacosRemoteDesktopSession must be constructed with a live H264SenderBackend
// (CreateWithPinnedLibwebrtcSender returns nullptr without one). But the only
// legitimate EncodedImageCallback comes from libwebrtc's VideoEncoder::
// InitEncode, which upstream calls *after* the track is added and the first
// negotiation settles. The session therefore has to exist before the callback
// does.
//
// This binder resolves that without faking a sender:
//   * Before InitEncode it is a real, fail-closed backend — Start/Submit both
//     refuse, so a frame produced before there is anywhere to send it is
//     dropped explicitly rather than buffered or silently accepted.
//   * On InitEncode the transport backend calls Bind() with the backend built
//     by CreatePinnedLibwebrtcH264Sender(callback); every later Submit goes to
//     upstream's encoded-image path, which owns packetization, RTCP, PLI and
//     pacing.
//   * On ReleaseEncoder (upstream tearing the encoder down) it unbinds and
//     returns to refusing, so a submission cannot outlive its callback.
//
// BINDING IDENTITY. Unbind takes the token its own Bind returned. libwebrtc may
// construct the replacement encoder before destroying the one it replaces, so
// an unconditional Unbind() let a DEAD encoder's Release/destructor detach the
// LIVE sender that had already taken its place. Every frame after that was
// dropped with no error anywhere -- the binder looked merely "not yet bound",
// which is a normal state during negotiation. A token makes a stale teardown a
// no-op instead of a silent outage.
//
// It is deliberately free of libwebrtc headers so this fail-closed behaviour is
// compilable and testable without a pinned checkout.
class MacosMediaSenderBinder final : public H264SenderBackend {
 public:
  MacosMediaSenderBinder() = default;

  MacosMediaSenderBinder(const MacosMediaSenderBinder&) = delete;
  MacosMediaSenderBinder& operator=(const MacosMediaSenderBinder&) = delete;

  // Installs the real upstream-backed sender and returns the identity of the
  // new binding, or kInvalidMediaSenderBinding on failure. Replacing an
  // existing binding is refused: two live encoders for one session would mean
  // two packetizers.
  [[nodiscard]] MediaSenderBindingId Bind(
      std::unique_ptr<H264SenderBackend> sender);
  // Stops new submissions from reaching the sender and drops this object's
  // reference to it. An in-flight Submit/Cancel keeps its own reference, so the
  // sender is destroyed only after that call returns — never underneath it.
  //
  // Ignored unless `binding` is the CURRENT binding: a stale encoder tearing
  // itself down must not detach its successor.
  //
  // The configuration SURVIVES. It belongs to the session's generation, not to
  // the encoder instance, and only Cancel(generation) revokes it. Discarding it
  // here meant the sequence Start -> Bind -> Unbind -> Bind left the binder
  // bound but unconfigured while the bridge above stayed active and never
  // called Start again, so every later frame was dropped in silence.
  void Unbind(MediaSenderBindingId binding) noexcept;

  [[nodiscard]] bool bound() const noexcept;
  // Identity of the live binding, or kInvalidMediaSenderBinding when unbound.
  [[nodiscard]] MediaSenderBindingId binding() const noexcept;
  // True while a configuration is retained for replay onto a (re)bound sender.
  [[nodiscard]] bool configured() const noexcept;
  // Frames refused because no encoder callback existed yet. Non-zero is normal
  // during negotiation; it is exported so a caller can tell "not yet wired"
  // from "wired but failing".
  [[nodiscard]] std::uint64_t dropped_before_bind() const noexcept;

  bool Start(const H264SenderConfiguration& configuration) override;
  bool Submit(H264SenderFrame frame,
              H264SenderCompletionCallback completion) override;
  void Cancel(common::WorkerGeneration generation) noexcept override;

 private:
  mutable std::mutex mutex_;
  // shared_ptr, not unique_ptr: Submit and Cancel must call upstream WITHOUT
  // holding the mutex (upstream may invoke the completion inline, and taking
  // the lock across that would deadlock against Unbind from the encoder
  // teardown thread). Copying the shared_ptr under the lock keeps an in-flight
  // call's sender alive even if Unbind resets the member meanwhile; Unbind
  // only stops NEW submissions from finding it.
  std::shared_ptr<H264SenderBackend> sender_;
  // Monotonic, never reused, never 0 while bound. Comparing it is what makes a
  // late teardown from a replaced encoder harmless.
  MediaSenderBindingId binding_ = kInvalidMediaSenderBinding;
  MediaSenderBindingId next_binding_ = 1;
  H264SenderConfiguration configuration_{};
  bool configured_ = false;
  std::uint64_t dropped_before_bind_ = 0;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_MEDIA_SENDER_BINDER_H_
