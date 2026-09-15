// Reads one grant line on stdin and reports what the NATIVE grammar made of it.
// Used by the cross-layer test so "the two sides agree" is demonstrated rather
// than asserted twice in two languages.
#include "macos_virtual_display_grant.h"

#include <cstdio>
#include <iostream>
#include <string>

int main() {
  std::string line;
  std::getline(std::cin, line);
  imcodes::remote_desktop::macos::VirtualDisplayGrant grant;
  std::string error;
  if (!imcodes::remote_desktop::macos::ParseVirtualDisplayGrant(line, &grant,
                                                                &error)) {
    // The DIAGNOSIS is printed, not just the verdict. A matrix that only sees
    // "REJECTED" cannot tell "refused for the reason under test" from "refused
    // because the fixture was malformed in some unrelated way", and would pass
    // just as happily if every rule collapsed into one.
    std::printf("REJECTED\nwhy=%s\n", error.c_str());
    return 1;
  }
  std::printf("ACCEPTED\nuid=%u\nasid=%u\nsession=%s\nsvcgen=%llu\narch=%s\n"
              "helpersha=%s\nrelease=%s\ndr=%s\n",
              grant.uid, grant.audit_session_id, grant.session_type.c_str(),
              static_cast<unsigned long long>(grant.service_generation),
              grant.arch.c_str(), grant.helper_sha256.c_str(),
              grant.release_identity.c_str(),
              grant.helper_designated_requirement.c_str());
  // Re-serialised, so the caller can prove TS-serialize -> native-parse ->
  // native-serialize is byte-identical. Two grammars that merely accept each
  // other can still disagree about the canonical spelling, and a canonical
  // spelling both sides do not share is where a signature-bypass lives.
  std::printf("canon=%s\n",
              imcodes::remote_desktop::macos::SerializeVirtualDisplayGrant(grant)
                  .c_str());
  return 0;
}
