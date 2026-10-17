#pragma once

#include <array>
#include <cstdint>
#include <string>

namespace imcodes::remote_desktop::clipboard_watchdog {

using Sha256 = std::array<uint8_t, 32>;

struct WatchRequest {
  std::string epoch_id;
  Sha256 expected_hash{};
  uint32_t baseline_sequence = 0;
  uint64_t deadline_unix_ms = 0;
  std::wstring ready_event;
};

bool ParseSha256Hex(const std::wstring& value, Sha256* output);

// Runs independently from the account shell. It persists only a DPAPI-sealed
// marker containing epoch/hash/sequence/deadline, never clipboard text.
int Run(const WatchRequest& request);

// Startup/sign-out recovery. Zero means no marker or proven cleanup; non-zero
// means the marker remains and the Server privacy epoch must stay recovery-required.
int Sanitize();

// Future signed-shell seam. Raw text exists only in the local UI process for
// this call; it is never serialized to the watchdog, node or Worker.
bool WriteShellOwnedInvitationLink(const std::wstring& invitation_link,
                                   uint32_t* sequence,
                                   Sha256* hash);

}  // namespace imcodes::remote_desktop::clipboard_watchdog
