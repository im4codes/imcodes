// Signed local-disclosure entry point.
//
// This binary owns the on-screen indication that a remote party is viewing or
// controlling this Mac. It is a separate signed component, and therefore a
// separate code identity and TCC subject, so the disclosure a user sees cannot
// be suppressed by tampering with the worker alone.
//
// It runs a real long-running AppKit event loop and reports Ready / Stop /
// Closed / Failed to its parent over the bounded local control seam. The
// worker refuses route admission unless this process has reported Ready for
// the current generation.
//
// Everything remote about it is two bounded counts. It holds no route
// authority and never receives a credential.

#import <AppKit/AppKit.h>

#include <sysexits.h>
#include <unistd.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>

#include "macos_disclosure_control.h"
#include "macos_local_disclosure.h"

namespace {

namespace macos = imcodes::remote_desktop::macos;

constexpr char kProbeArgument[] = "--imcodes-remote-desktop-probe";
constexpr char kViewersArgument[] = "--viewers";
constexpr char kControllersArgument[] = "--controllers";
constexpr char kGenerationArgument[] = "--generation";

// Counts and generation arrive from the daemon and are the only remotely
// influenced input. Parsing rejects anything that is not a plain bounded
// decimal, so a malformed or oversized value fails closed instead of being
// clamped into something plausible.
bool ParseBoundedCount(const char* text,
                       std::uint64_t maximum,
                       std::uint64_t* out) {
  if (text == nullptr || out == nullptr)
    return false;
  const std::size_t length = std::strlen(text);
  if (length == 0 || length > 19)
    return false;
  if (length > 1 && text[0] == '0')
    return false;
  std::uint64_t value = 0;
  for (std::size_t index = 0; index < length; ++index) {
    const char digit = text[index];
    if (digit < '0' || digit > '9')
      return false;
    value = value * 10 + static_cast<std::uint64_t>(digit - '0');
  }
  if (value > maximum)
    return false;
  *out = value;
  return true;
}

// Writes one control line and flushes immediately. The parent treats a lost
// line as a lost disclosure, so buffering here would let admission outlive the
// window it depends on.
bool EmitEvent(macos::DisclosureEvent event, std::uint64_t generation) {
  std::string line;
  if (!macos::SerializeDisclosureEvent(event, generation, &line))
    return false;
  line.push_back('\n');
  if (std::fwrite(line.data(), 1, line.size(), stdout) != line.size()) {
    return false;
  }
  return std::fflush(stdout) == 0;
}

int RunDisclosure(std::uint32_t viewers,
                  std::uint32_t controllers,
                  std::uint64_t generation,
                  bool probe_only) {
  const macos::MacosLocalDisclosureOptions options;
  if (viewers > options.max_viewers || controllers > options.max_controllers) {
    std::fprintf(stderr,
                 "macos_remote_desktop_disclosure_counts_out_of_range\n");
    return EX_DATAERR;
  }

  bool stop_requested = false;
  bool window_gone = false;
  macos::MacosLocalDisclosureAdapter adapter(
      [&](std::uint64_t) noexcept { stop_requested = true; }, options);

  const macos::DisclosureStartupOutcome startup =
      macos::RunDisclosureStartup(adapter, generation, viewers, controllers);
  switch (startup) {
    case macos::DisclosureStartupOutcome::kVisibleAndReady:
      break;
    case macos::DisclosureStartupOutcome::kBeginSessionFailed:
      std::fprintf(stderr,
                   "macos_remote_desktop_disclosure_generation_rejected\n");
      break;
    case macos::DisclosureStartupOutcome::kShowFailed:
      std::fprintf(stderr, "macos_remote_desktop_disclosure_show_failed\n");
      break;
    case macos::DisclosureStartupOutcome::kNotVisible:
      std::fprintf(stderr, "macos_remote_desktop_disclosure_not_visible\n");
      break;
    case macos::DisclosureStartupOutcome::kReadinessLost:
      std::fprintf(stderr, "macos_remote_desktop_disclosure_not_ready\n");
      break;
  }
  return macos::RunDisclosureProcessAfterStartup(
      startup, generation, probe_only, adapter,
      macos::DisclosureProcessCallbacks{
          .emit_ready = [](std::uint64_t ready_generation) {
            // Ready is emitted only after a synchronously confirmed visible
            // window, so route admission cannot race an absent disclosure.
            return EmitEvent(macos::DisclosureEvent::kReady,
                             ready_generation);
          },
          .emit_failed = [](std::uint64_t failed_generation) {
            (void)EmitEvent(macos::DisclosureEvent::kFailed,
                            failed_generation);
          },
          .report_probe_success = [] {
            // Probe mode proves the same visible property as production, but
            // emits no route authority and exits after bounded cleanup.
            std::fprintf(stdout,
                         "macos_remote_desktop_disclosure_probe_ok\n");
          },
          .run_visible_loop = [&]() {
            // Real long-running AppKit event loop. Polling with a bounded
            // timeout keeps ownership of local Stop and parent death here.
            @autoreleasepool {
              [NSApplication sharedApplication];
              [NSApp setActivationPolicy:
                         NSApplicationActivationPolicyAccessory];
            }
            while (!stop_requested && !window_gone) {
              @autoreleasepool {
                NSEvent* event = [NSApp
                    nextEventMatchingMask:NSEventMaskAny
                                untilDate:[NSDate
                                              dateWithTimeIntervalSinceNow:
                                                  0.25]
                                   inMode:NSDefaultRunLoopMode
                                  dequeue:YES];
                if (event != nil)
                  [NSApp sendEvent:event];
              }
              if (!adapter.IsVisible())
                window_gone = true;
              if (::getppid() == 1)
                break;
            }

            const auto event = stop_requested
                                   ? macos::DisclosureEvent::kStop
                                   : macos::DisclosureEvent::kClosed;
            const bool emitted = EmitEvent(event, generation);
            if (stop_requested) {
              std::fprintf(
                  stderr,
                  "macos_remote_desktop_disclosure_local_stop\n");
            }
            return emitted ? EX_OK : EX_IOERR;
          },
      });
}

}  // namespace

int main(int argc, const char* argv[]) {
  // The disclosure must render in the console user's session. A root process
  // has no Aqua session, so its window would never appear while remote access
  // proceeded — exactly the failure this component exists to prevent.
  if (geteuid() == 0) {
    std::fprintf(stderr, "macos_remote_desktop_disclosure_refuses_root\n");
    return EX_NOPERM;
  }

  bool probe_only = false;
  std::uint64_t viewers = 1;
  std::uint64_t controllers = 0;
  std::uint64_t generation = 0;
  const macos::MacosLocalDisclosureOptions limits;
  for (int index = 1; index < argc; ++index) {
    if (argv[index] == nullptr)
      continue;
    if (std::strcmp(argv[index], kProbeArgument) == 0) {
      probe_only = true;
      continue;
    }
    if (std::strcmp(argv[index], kViewersArgument) == 0) {
      if (index + 1 >= argc ||
          !ParseBoundedCount(argv[++index], limits.max_viewers, &viewers)) {
        std::fprintf(stderr, "macos_remote_desktop_disclosure_bad_viewers\n");
        return EX_USAGE;
      }
      continue;
    }
    if (std::strcmp(argv[index], kControllersArgument) == 0) {
      if (index + 1 >= argc ||
          !ParseBoundedCount(argv[++index], limits.max_controllers,
                             &controllers)) {
        std::fprintf(stderr,
                     "macos_remote_desktop_disclosure_bad_controllers\n");
        return EX_USAGE;
      }
      continue;
    }
    if (std::strcmp(argv[index], kGenerationArgument) == 0) {
      if (index + 1 >= argc ||
          !ParseBoundedCount(argv[++index], UINT64_MAX, &generation) ||
          generation == 0) {
        std::fprintf(stderr,
                     "macos_remote_desktop_disclosure_bad_generation\n");
        return EX_USAGE;
      }
      continue;
    }
    std::fprintf(stderr, "macos_remote_desktop_disclosure_unknown_argument\n");
    return EX_USAGE;
  }
  if (generation == 0 && !probe_only) {
    // Every control line is generation-stamped; without one the parent could
    // not tell this disclosure from a replaced one.
    std::fprintf(stderr,
                 "macos_remote_desktop_disclosure_generation_required\n");
    return EX_USAGE;
  }
  // Probe mode has no route authority, but the adapter deliberately refuses
  // generation zero. Use a local synthetic generation solely to exercise
  // window readiness; it is never emitted or admitted as a route.
  const std::uint64_t effective_generation =
      probe_only && generation == 0 ? 1 : generation;
  return RunDisclosure(static_cast<std::uint32_t>(viewers),
                       static_cast<std::uint32_t>(controllers),
                       effective_generation, probe_only);
}
