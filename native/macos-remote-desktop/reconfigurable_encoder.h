#ifndef IMCODES_MACOS_REMOTE_DESKTOP_RECONFIGURABLE_ENCODER_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_RECONFIGURABLE_ENCODER_H_

#include <functional>
#include <optional>

#include "../remote-desktop-common/platform_interfaces.h"
#include "../remote-desktop-common/quality_ladder.h"

namespace imcodes::remote_desktop::macos {

// What the session needs from an encoder beyond common::EncoderAdapter: it
// applies the quality ladder's selection, reports the size it is now producing
// (so a capture that can scale follows it), and tells the session when that size
// changes by itself. Free of Apple and libwebrtc types, so the encoder that
// hands frames to libvpx and the one that drives VideoToolbox are interchangeable
// behind one switch and testable without either.
class ReconfigurableEncoder : public common::EncoderAdapter {
 public:
  virtual bool ReconfigureFromQualitySelection(
      const imcodes::rd::QualitySelection& selection) = 0;
  [[nodiscard]] virtual std::optional<common::EncoderConfiguration>
  Configuration() const = 0;
  // Called outside every encoder lock. Set before use.
  virtual void SetConfigurationObserver(std::function<void()> observer) = 0;
};

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_RECONFIGURABLE_ENCODER_H_
