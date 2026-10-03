#ifndef IMCODES_REMOTE_DESKTOP_COMMON_LOCAL_INDICATOR_VISUALS_H_
#define IMCODES_REMOTE_DESKTOP_COMMON_LOCAL_INDICATOR_VISUALS_H_

#include <cstdint>
#include <string>

namespace imcodes::remote_desktop::common {

inline constexpr std::uint32_t kLocalIndicatorBadgeLimit = 9;
inline constexpr int kLocalIndicatorAutoCollapseDelayMs = 4000;

enum class LocalIndicatorEdge { kRight, kLeft, kTop, kBottom };

// The arrow points away from the edge, i.e. towards the space into which the
// compact disclosure expands. All three current implementations pin to the
// right edge, but keeping the mapping here prevents a future edge move from
// leaving a misleading or unclickable affordance behind.
inline constexpr char LocalIndicatorExpandChevron(LocalIndicatorEdge edge) {
  switch (edge) {
    case LocalIndicatorEdge::kRight:
      return '<';
    case LocalIndicatorEdge::kLeft:
      return '>';
    case LocalIndicatorEdge::kTop:
      return 'v';
    case LocalIndicatorEdge::kBottom:
      return '^';
  }
  return '<';
}

inline std::string LocalIndicatorBadgeText(std::uint32_t connections) {
  if (connections == 0) return {};
  if (connections > kLocalIndicatorBadgeLimit) return "9+";
  return std::to_string(connections);
}

}  // namespace imcodes::remote_desktop::common

#endif  // IMCODES_REMOTE_DESKTOP_COMMON_LOCAL_INDICATOR_VISUALS_H_
