#ifndef IMCODES_REMOTE_DESKTOP_UNLOCK_SECRET_H_
#define IMCODES_REMOTE_DESKTOP_UNLOCK_SECRET_H_

#include <windows.h>

#include <string>

namespace imcodes::rd {

// Optional sign-in secret used to answer the lock screen while an authorized
// controller is watching. It is stored machine-scoped through DPAPI in a
// LOCAL_SYSTEM-only file on the node itself: it never reaches the Server, the
// database, a log line, a process command line, or any browser. Reading it back
// out is deliberately impossible from anywhere but this worker.
//
// Enabling this trades one property away, and callers should present it that
// way: with a stored secret, whoever may start a remote-desktop session on the
// node can reach the signed-in desktop, so the lock screen stops being a second
// gate for remote viewers.
class UnlockSecret {
 public:
  // Absolute path of the encrypted blob. Kept next to the node's own state
  // rather than beside the verified worker artifact, which is replaced whole on
  // every upgrade.
  static std::wstring Path();

  // Encrypt and persist. `secret` is wiped by the caller; this never logs it.
  // An empty secret clears the stored value instead.
  static bool Store(const std::wstring& secret);

  // Remove any stored secret. Succeeds when nothing was stored.
  static bool Clear();

  // True when a secret is present, without decrypting it.
  static bool Configured();

  // Decrypt for a single use. The caller must SecureZeroMemory the result.
  // Returns false when nothing is stored or the blob cannot be decrypted on
  // this machine, which is what happens if the file is copied elsewhere.
  static bool Load(std::wstring* secret);
};

}  // namespace imcodes::rd

#endif  // IMCODES_REMOTE_DESKTOP_UNLOCK_SECRET_H_
