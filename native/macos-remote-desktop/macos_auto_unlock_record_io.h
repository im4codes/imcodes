#ifndef IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_RECORD_IO_H_
#define IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_RECORD_IO_H_

#include <cstdint>
#include <string>

namespace imcodes::remote_desktop::macos {

/**
 * Reads a drop-box record, refusing anything that is not exactly expected.
 *
 * Name-based trust is not enough: the authority lives in a directory an
 * unprivileged user owns while the consumer runs as ROOT inside
 * authorizationhost. O_NOFOLLOW defeats a symlink swap, and every check is made
 * against the OPEN DESCRIPTOR rather than the path, so the file cannot be
 * exchanged between the check and the read.
 *
 * Returns empty on any refusal -- callers treat empty as absent.
 */
/**
 * The persisted retry ledger.
 *
 * `last_nonce` is what makes replay refusable across processes and across a
 * crash: single-consume is enforced by unlinking the authority, but a record
 * restored from a copy would otherwise be spendable again.
 */
struct AutoUnlockLedgerRecord {
  int attempts = 0;
  std::int64_t locked_out_until_ms = 0;
  std::string last_nonce;
};

/** Renders/parses the ledger. Returns false on anything malformed -- a torn
 *  ledger must not read as "fresh", which would forgive a spent attempt. */
[[nodiscard]] std::string SerializeAutoUnlockLedger(
    const AutoUnlockLedgerRecord& record);
[[nodiscard]] bool ParseAutoUnlockLedger(const std::string& text,
                                         AutoUnlockLedgerRecord* out);

enum class AutoUnlockDirectoryState {
  kAbsent,
  /** A real directory owned by the required user. Mode is the caller's business. */
  kUsable,
  /** A symlink, a non-directory, or owned by someone else. Never adopt it. */
  kUnsafe,
};

/**
 * Inspects a drop-box directory without following symlinks.
 *
 * Shared by the unprivileged issuer and the privileged provisioner so there is
 * exactly ONE lstat-versus-stat decision in the auto-unlock tree. Two copies
 * would mean the security property is only as good as whichever copy a given
 * test happened to exercise -- and a redundant second lstat in a caller silently
 * masked a mutation of this one until they were collapsed.
 *
 * `required_mode` of 0 means "any mode": the privileged provisioner adopts and
 * then repairs the mode, while the unprivileged issuer demands an exact match.
 */
[[nodiscard]] AutoUnlockDirectoryState InspectAutoUnlockDirectory(
    const std::string& path, std::uint32_t required_owner,
    unsigned int required_mode);

[[nodiscard]] std::string ReadValidatedAutoUnlockRecord(
    const std::string& path, std::uint32_t expected_owner_uid,
    std::size_t limit);

/**
 * Writes 0600 and replaces atomically, or reports failure.
 *
 * Shared by the unprivileged issuer and the root plug-in so the two can never
 * drift on mode, durability or replace semantics -- a reader that demands an
 * exact mode and a writer that sets a different one would refuse its own record.
 */
[[nodiscard]] bool WriteAutoUnlockRecordAtomically(const std::string& path,
                                                   const std::string& contents);

}  // namespace imcodes::remote_desktop::macos

#endif  // IMCODES_MACOS_REMOTE_DESKTOP_MACOS_AUTO_UNLOCK_RECORD_IO_H_
