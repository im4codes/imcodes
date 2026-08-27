// Real POSIX seam for MacosVirtualDisplayAuthorityLink.
//
// Separate from the link's state machine on purpose: every authorisation rule
// is proven against a fake filesystem with no socket, no daemon and no process,
// and this file contributes only syscalls.
//
// What it must get right, and what each choice costs if it is wrong:
//
//   * lstat, never stat. A symlink anywhere in the chain means the object the
//     kernel resolves is not the object that was checked.
//   * Every wait is BOUNDED. An unbounded read on the authority link is an
//     agent that hangs forever the first time the daemon stops talking, with a
//     display held and nobody watching.
//   * Exactly one owner per descriptor. The link owns the connected fd; this
//     file hands it over on success and closes it on every failure path, so a
//     refused Establish cannot leak.

#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_AUTHORITY_LINK_POSIX_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_AUTHORITY_LINK_POSIX_H_

#include <cstdint>

#include "macos_virtual_display_authority_link.h"

namespace imcodes::remote_desktop::macos {

/** Bounded wait for one line from the daemon. */
inline constexpr std::uint32_t kAuthorityLinkReadTimeoutMs = 30'000;
/** Bounded wait for one line to the daemon. */
inline constexpr std::uint32_t kAuthorityLinkWriteTimeoutMs = 5'000;

[[nodiscard]] AuthorityLinkSeam CreatePosixAuthorityLinkSeam();

/**
 * Writes one line plus its terminator, bounded.
 *
 * Returns false on any short or failed write. A partial write is a failure
 * rather than something to resume: this wire has no resynchronisation point
 * inside a frame, so half a request would be read as a whole one.
 */
[[nodiscard]] bool WriteAuthorityLinkLine(int descriptor,
                                          const std::string& line,
                                          std::uint32_t timeout_ms);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_VIRTUAL_DISPLAY_AUTHORITY_LINK_POSIX_H_
