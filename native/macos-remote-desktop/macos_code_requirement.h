// Copyright (c) IM.codes contributors.
//
// The ONE place the canonical Developer ID designated requirement is spelled
// on the native side.
//
// There were three copies of this string: here, in the peer identity
// validator, and in the virtual-display grant. They drifted -- two of them
// still demanded a requirement without the Developer ID marker extensions,
// which no signed component has emitted since those markers were required, so
// both validators rejected every identity the daemon actually builds. A
// mismatch in a string that is compared for byte equality is not a style
// problem; it is a component that never authenticates.
//
// This must agree byte for byte with `shared/macos-code-requirement.ts` and
// with `macosCodeRequirementLiteral` in `src/node/macos-apple-trust.mjs`. A
// test asserts all of them produce identical text for the same inputs.

#ifndef NATIVE_MACOS_REMOTE_DESKTOP_MACOS_CODE_REQUIREMENT_H_
#define NATIVE_MACOS_REMOTE_DESKTOP_MACOS_CODE_REQUIREMENT_H_

#include <cstddef>
#include <string>

namespace imcodes::remote_desktop::macos {

// Quote a requirement literal exactly as codesign does.
//
// Bare only when the WHOLE literal is a letter followed by letters and digits.
// An underscore, a hyphen, a leading digit or a dot quotes it -- so every
// bundle identifier is quoted and only a team ID is ever bare. Established by
// signing a probe with a real Developer ID certificate and reading
// `codesign -d -r-` back; the observed table is in
// shared/macos-code-requirement.ts.
inline std::string CodeRequirementLiteral(const std::string& value) {
  bool bare = !value.empty();
  for (std::size_t index = 0; bare && index < value.size(); ++index) {
    const unsigned char character = static_cast<unsigned char>(value[index]);
    const bool alpha = (character >= 'A' && character <= 'Z') ||
                       (character >= 'a' && character <= 'z');
    const bool digit = character >= '0' && character <= '9';
    bare = index == 0 ? alpha : (alpha || digit);
  }
  return bare ? value : "\"" + value + "\"";
}

// Exactly what codesign derives for a Developer ID Application certificate.
//
// Every clause is load-bearing. `anchor apple generic` is what demands an
// Apple-issued chain -- without it a self-signed binary with the right
// identifier and OU satisfies the requirement. The two marker OIDs
// (1.2.840.113635.100.6.2.6 on the intermediate, 1.2.840.113635.100.6.1.13 on
// the leaf) are what distinguish a Developer ID leaf from an Apple Development
// certificate issued to the same team.
inline std::string AppleDesignatedRequirement(const std::string& bundle_identifier,
                                              const std::string& team_id) {
  return "identifier " + CodeRequirementLiteral(bundle_identifier) +
         " and anchor apple generic"
         " and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */"
         " and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */"
         " and certificate leaf[subject.OU] = " +
         CodeRequirementLiteral(team_id);
}

}  // namespace imcodes::remote_desktop::macos

#endif  // NATIVE_MACOS_REMOTE_DESKTOP_MACOS_CODE_REQUIREMENT_H_
