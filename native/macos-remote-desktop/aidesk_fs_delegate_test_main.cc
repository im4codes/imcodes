// Test driver for aidesk_fs_delegate.cc: runs RunFsDelegateRequest with explicit options so the request-validation logic can be
// exercised on any POSIX host (test/native/aidesk-fs-delegate.test.ts builds and drives it). Not part of the shipped app.
//
// usage: aidesk_fs_delegate_test_main <request_file> <request_dir> <trusted_chain_start> <trusted_uid> <now_ms> [full_disk_access_probe_path [require]]

#include <cstdio>
#include <cstdlib>
#include <string>

#include "aidesk_fs_delegate.h"

int main(int argc, char** argv) {
  if (argc < 6 || argc > 8) {
    std::fputs("usage: <request_file> <request_dir> <trusted_chain_start> <trusted_uid> <now_ms> [probe_path [require]]\n", stderr);
    return 64;
  }
  imcodes::aidesk::fs_delegate::Options options;
  options.request_dir = argv[2];
  options.trusted_chain_start = argv[3];
  options.trusted_owner_uid = static_cast<uid_t>(std::strtoul(argv[4], nullptr, 10));
  options.now_ms = std::strtoll(argv[5], nullptr, 10);
  if (argc >= 7) options.full_disk_access_probe_path = argv[6];
  if (argc == 8) options.require_full_disk_access_probe = std::string(argv[7]) == "require";
  std::string answer;
  const int code = imcodes::aidesk::fs_delegate::RunFsDelegateRequest(argv[1], options, &answer);
  std::fwrite(answer.data(), 1, answer.size(), stdout);
  return code;
}
