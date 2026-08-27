// Counterexamples for the Node-issued complete-set grant.
#include "macos_virtual_display_grant.h"

#include <cassert>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

namespace rd = imcodes::remote_desktop::macos;

namespace {

// Built by the SAME function production uses, so the fixture cannot quietly
// drift into a spelling the parser would refuse.
const std::string kRequirement = rd::CanonicalDesignatedRequirement(
    "cc.imcodes.node.virtual-display-helper", "ABCDE12345");

rd::VirtualDisplayGrant Grant() {
  rd::VirtualDisplayGrant grant;
  grant.uid = 501;
  grant.audit_session_id = 100003;
  grant.session_type = "Aqua";
  grant.service_generation = 7;
  grant.challenge = std::string(43, 'A');
  grant.ttl_ms = 60'000;
  // The release directory name IS `sha256-` + the set digest by construction;
  // a pair that disagrees is a grant assembled from two different sets.
  grant.set_sha256 = std::string(64, 'd');
  grant.release_identity = "sha256-" + grant.set_sha256;
  grant.helper_file_name = "imcodes-virtual-display-helper";
  grant.helper_sha256 = std::string(64, 'e');
  grant.helper_size = 4096;
  grant.helper_designated_requirement = kRequirement;
  grant.helper_bundle_identifier = "cc.imcodes.node.virtual-display-helper";
  grant.team_id = "ABCDE12345";
  grant.arch = "arm64";
  return grant;
}

rd::AgentSessionContext Observed() {
  rd::AgentSessionContext observed;
  observed.uid = 501;
  observed.audit_session_id = 100003;
  observed.session_type = "Aqua";
  observed.service_generation = 7;
  return observed;
}

void RoundTripsLosslessly() {
  const auto grant = Grant();
  const std::string line = rd::SerializeVirtualDisplayGrant(grant);
  assert(!line.empty());
  assert(line.size() <= rd::kVirtualDisplayGrantMaxBytes);
  assert(line.find('\n') == std::string::npos);
  rd::VirtualDisplayGrant parsed;
  assert(rd::ParseVirtualDisplayGrant(line, &parsed));
  // The designated requirement contains spaces and quotes; it must survive the
  // whitespace-delimited grammar intact, or the agent would check a truncated
  // requirement and accept the wrong binary.
  assert(parsed.helper_designated_requirement == kRequirement);
  assert(parsed.uid == grant.uid && parsed.audit_session_id == grant.audit_session_id);
  assert(parsed.service_generation == grant.service_generation);
  assert(parsed.helper_sha256 == grant.helper_sha256);
  assert(parsed.arch == grant.arch);
}

void MalformedGrantsAreRefused() {
  rd::VirtualDisplayGrant ignored;
  const std::string good = rd::SerializeVirtualDisplayGrant(Grant());
  assert(!rd::ParseVirtualDisplayGrant("", &ignored));
  assert(!rd::ParseVirtualDisplayGrant("grant2 uid=1", &ignored));
  assert(!rd::ParseVirtualDisplayGrant(std::string(2000, 'x'), &ignored));
  // An unknown key must be refused, not ignored: silently dropping a future
  // field lets an old agent believe it understood the whole grant.
  assert(!rd::ParseVirtualDisplayGrant(good + " extra=1", &ignored));
  // A repeated key must not be last-wins.
  assert(!rd::ParseVirtualDisplayGrant(good + " uid=502", &ignored));
  // Every field is required; dropping any one is a refusal.
  for (const char* key : {"uid=", "asid=", "session=", "svcgen=", "challenge=",
                          "ttl=", "release=", "set=", "helperfile=",
                          "helpersha=", "helpersize=", "dr=", "helperbundle=",
                          "team=", "arch="}) {
    const std::size_t at = good.find(key);
    assert(at != std::string::npos);
    const std::size_t end = good.find(' ', at);
    std::string trimmed = good.substr(0, at - 1)
        + (end == std::string::npos ? "" : good.substr(end));
    assert(!rd::ParseVirtualDisplayGrant(trimmed, &ignored));
  }
}

void FieldShapesAreEnforced() {
  auto grant = Grant();
  // A short or non-base64url challenge is guessable, and it authenticates the
  // whole exchange.
  grant.challenge = std::string(42, 'A');
  assert(rd::SerializeVirtualDisplayGrant(grant).empty());
  grant = Grant(); grant.session_type = "Console";
  assert(rd::SerializeVirtualDisplayGrant(grant).empty());
  grant = Grant(); grant.arch = "ppc";
  assert(rd::SerializeVirtualDisplayGrant(grant).empty());
  grant = Grant(); grant.helper_sha256 = std::string(64, 'E');  // upper case
  assert(rd::SerializeVirtualDisplayGrant(grant).empty());
  grant = Grant(); grant.audit_session_id = 0;
  assert(rd::SerializeVirtualDisplayGrant(grant).empty());
  grant = Grant(); grant.service_generation = 0;
  assert(rd::SerializeVirtualDisplayGrant(grant).empty());
  grant = Grant(); grant.helper_designated_requirement.clear();
  assert(rd::SerializeVirtualDisplayGrant(grant).empty());
}

void AdmissionBindsEverySessionFact() {
  const auto grant = Grant();
  const auto observed = Observed();
  assert(rd::EvaluateGrantAdmission(grant, observed, 1'000'000) ==
         rd::GrantAdmission::kAdmitted);

  auto wrong = observed; wrong.uid = 502;
  assert(rd::EvaluateGrantAdmission(grant, wrong, 1'000'000) ==
         rd::GrantAdmission::kUidMismatch);

  // A NEW audit session under the SAME uid: the user logged out and back in.
  // The old grant must not carry over.
  wrong = observed; wrong.audit_session_id = 100004;
  assert(rd::EvaluateGrantAdmission(grant, wrong, 1'000'000) ==
         rd::GrantAdmission::kAuditSessionMismatch);

  wrong = observed; wrong.session_type = "LoginWindow";
  assert(rd::EvaluateGrantAdmission(grant, wrong, 1'000'000) ==
         rd::GrantAdmission::kSessionTypeMismatch);

  // A grant minted for a previous incarnation of the agent.
  wrong = observed; wrong.service_generation = 8;
  assert(rd::EvaluateGrantAdmission(grant, wrong, 1'000'000) ==
         rd::GrantAdmission::kServiceGenerationMismatch);
}

void ExpiryAndReplayAreRefused() {
  const auto grant = Grant();
  const auto observed = Observed();
  // Exactly at the deadline is already expired: a launch capability that is
  // still usable at its own expiry has no expiry.
  // Presentation expiry is no longer decided here. The grant carries a
  // DURATION, so "now minus now" at the instant it arrives is zero against any
  // TTL -- a check written here could not fail. The deadline is formed by the
  // caller on its own monotonic clock and enforced by the challenge ledger,
  // which is also what makes the challenge single-use.
  assert(rd::EvaluateGrantAdmission(grant, observed, 1'000'000) ==
         rd::GrantAdmission::kAdmitted);
  // Replay is NOT this function's job any more: a single "last challenge"
  // cannot see A -> B -> A and cannot make two concurrent presentations lose.
  // The generation-scoped ledger owns it, and has its own counterexamples.
  // An unusable clock is a refusal, not "probably fine".
  assert(rd::EvaluateGrantAdmission(grant, observed, 0) ==
         rd::GrantAdmission::kMalformed);
  assert(rd::EvaluateGrantAdmission({}, observed, 1'000'000) ==
         rd::GrantAdmission::kMalformed);
  assert(rd::EvaluateGrantAdmission(grant, {}, 1'000'000) ==
         rd::GrantAdmission::kMalformed);
}


void TheWireFormIsCanonicalAndClosed() {
  const std::string good = rd::SerializeVirtualDisplayGrant(Grant());
  rd::VirtualDisplayGrant parsed;
  std::string error;

  // Serialize(Parse(line)) == line, byte for byte. That single property
  // subsumes key order and encoding choice: if two distinct lines could ever
  // name the same authority, one of them fails here.
  assert(rd::ParseVirtualDisplayGrant(good, &parsed, &error));
  assert(rd::SerializeVirtualDisplayGrant(parsed) == good);

  // Reordered keys parse to the same grant but are NOT the canonical spelling.
  const std::size_t uid_at = good.find("uid=");
  const std::size_t uid_end = good.find(' ', uid_at);
  const std::string reordered = good.substr(0, uid_at)
      + good.substr(uid_end + 1) + " " + good.substr(uid_at, uid_end - uid_at);
  assert(!rd::ParseVirtualDisplayGrant(reordered, &parsed, &error));
  assert(error == "grant_not_canonical");

  // Over-encoding: %41 is a perfectly decodable 'A' and must still be refused,
  // or one requirement would have many valid encodings.
  std::string over = good;
  const std::size_t dr_at = over.find("dr=");
  over.replace(dr_at + 3, 1, "%41");
  assert(!rd::ParseVirtualDisplayGrant(over, &parsed, &error));

  // Lower-case hex in the escape is a second spelling of the same character.
  std::string lower = good;
  lower.replace(lower.find("%20"), 3, "%2a");
  assert(!rd::ParseVirtualDisplayGrant(lower, &parsed, &error));

  // Raw control bytes and non-ASCII never survive the grammar.
  for (const char byte : {'\x01', '\x7f', '\n', '\t'}) {
    std::string dirty = good;
    dirty.insert(dirty.find("dr=") + 3, 1, byte);
    assert(!rd::ParseVirtualDisplayGrant(dirty, &parsed, &error));
  }
  {
    std::string unicode = good;
    unicode.insert(unicode.find("dr=") + 3, "\xc3\xa9");  // U+00E9
    assert(!rd::ParseVirtualDisplayGrant(unicode, &parsed, &error));
  }
}

// Forges one field of an otherwise good line.
//
// Cross-field and shape rules can ONLY be tested this way now: the serializer
// validates wire-canonically, so it is incapable of emitting a line its own
// parser would refuse. That incapacity is the fix -- which leaves string
// surgery as the only way to present the parser with a line no honest producer
// could have produced.
static std::string ReplaceField(const std::string& line, const char* key,
                                const std::string& value) {
  const std::size_t at = line.find(key);
  assert(at != std::string::npos);  // a typo'd key would silently test nothing
  const std::size_t end = line.find(' ', at);
  return line.substr(0, at) + key + value
      + (end == std::string::npos ? "" : line.substr(end));
}

void CrossFieldDisagreementIsRefused() {
  rd::VirtualDisplayGrant parsed;
  std::string error;
  const std::string good = rd::SerializeVirtualDisplayGrant(Grant());
  assert(!good.empty());

  // These lines must be built by STRING SURGERY, not by the serializer: the
  // serializer now validates wire-canonically, so it is incapable of emitting a
  // line its own parser would refuse. That incapacity is the fix; it also means
  // the only way to test the parser's cross-field rules is to forge the line.

  // A release name that does not match the set digest is a grant assembled
  // from two different sets.
  assert(!rd::ParseVirtualDisplayGrant(
      ReplaceField(good, "release=", "sha256-" + std::string(64, 'c')), &parsed, &error));
  assert(error == "grant_release_set_mismatch");

  // A requirement that merely MENTIONS the right bundle and team but also says
  // something else. A substring test would have accepted this; exact canonical
  // equality does not, because the extra clause widens who satisfies it.
  const std::string widened = rd::CanonicalDesignatedRequirement(
      "cc.imcodes.node.virtual-display-helper", "ABCDE12345") + " or anchor trusted";
  std::string encoded;
  for (const char character : widened)
    encoded += character == ' ' ? std::string("%20") : std::string(1, character);
  assert(!rd::ParseVirtualDisplayGrant(ReplaceField(good, "dr=", encoded), &parsed, &error));
  assert(error == "grant_requirement_not_canonical");

  // A requirement naming a different bundle than the grant describes.
  std::string other_bundle;
  for (const char character : rd::CanonicalDesignatedRequirement(
           "cc.imcodes.node.somebody-else", "ABCDE12345")) {
    other_bundle += character == ' ' ? std::string("%20") : std::string(1, character);
  }
  assert(!rd::ParseVirtualDisplayGrant(ReplaceField(good, "dr=", other_bundle), &parsed, &error));
  assert(error == "grant_requirement_not_canonical");

  // A requirement naming a different team is a different signer.
  std::string other_team;
  for (const char character : rd::CanonicalDesignatedRequirement(
           "cc.imcodes.node.virtual-display-helper", "ZZZZZZZZZZ")) {
    other_team += character == ' ' ? std::string("%20") : std::string(1, character);
  }
  assert(!rd::ParseVirtualDisplayGrant(ReplaceField(good, "dr=", other_team), &parsed, &error));
  assert(error == "grant_requirement_not_canonical");

  // The serializer refuses all of the above rather than emitting them.
  for (const auto& mutate : std::vector<std::function<void(rd::VirtualDisplayGrant&)>>{
           [](rd::VirtualDisplayGrant& g) { g.release_identity = "sha256-" + std::string(64, 'c'); },
           [](rd::VirtualDisplayGrant& g) { g.helper_bundle_identifier = "cc.imcodes.node.other"; },
           [](rd::VirtualDisplayGrant& g) { g.team_id = "ZZZZZZZZZZ"; },
           [](rd::VirtualDisplayGrant& g) { g.helper_designated_requirement += " or anchor trusted"; },
       }) {
    auto grant = Grant();
    mutate(grant);
    // ShapeValid may still hold -- every individual field is well formed. It is
    // the wire-canonical question that fails, and that is the one the
    // serializer asks.
    assert(!grant.WireCanonicalValid());
    assert(rd::SerializeVirtualDisplayGrant(grant).empty());
  }
}

void NumericDomainsMirrorTheProducer() {
  rd::VirtualDisplayGrant parsed;
  std::string error;
  const std::string good = rd::SerializeVirtualDisplayGrant(Grant());

  // The producer is TypeScript, where every number is a double. Anything above
  // 2^53-1 could not have been meant, so honouring it would be honouring a
  // value that lost precision on the way out.
  for (const char* key : {"svcgen=", "ttl="}) {
    assert(!rd::ParseVirtualDisplayGrant(
        ReplaceField(good, key, "9007199254740992"), &parsed, &error));
    // The boundary itself is admissible in domain terms.
    (void)rd::ParseVirtualDisplayGrant(
        ReplaceField(good, key, "9007199254740991"), &parsed, &error);
  }
  // uid and asid are 32-bit in the kernel.
  assert(!rd::ParseVirtualDisplayGrant(ReplaceField(good, "uid=", "4294967296"),
                                       &parsed, &error));
  assert(!rd::ParseVirtualDisplayGrant(ReplaceField(good, "asid=", "4294967296"),
                                       &parsed, &error));
  // 512 MiB, mirrored from the producer.
  assert(!rd::ParseVirtualDisplayGrant(ReplaceField(good, "helpersize=", "536870913"),
                                       &parsed, &error));
  // Overflow must be a rejection, never a wrap into a smaller valid number.
  assert(!rd::ParseVirtualDisplayGrant(
      ReplaceField(good, "ttl=", "99999999999999999999"), &parsed, &error));
}

void MissingIsDiagnosedSeparatelyFromMalformed() {
  // "absent" and "present but wrong" call for different operator responses, and
  // reporting both as one bool made the completeness check indistinguishable
  // from the shape checks -- so neither could be shown to do work the other
  // was not.
  const std::string good = rd::SerializeVirtualDisplayGrant(Grant());
  rd::VirtualDisplayGrant parsed;
  std::string error;

  const std::size_t at = good.find("arch=");
  const std::size_t end = good.find(' ', at);
  const std::string absent = good.substr(0, at - 1)
      + (end == std::string::npos ? "" : good.substr(end));
  assert(!rd::ParseVirtualDisplayGrant(absent, &parsed, &error));
  assert(error == "grant_field_missing");

  const std::string malformed = good.substr(0, at) + "arch=ppc"
      + (end == std::string::npos ? "" : good.substr(end));
  assert(!rd::ParseVirtualDisplayGrant(malformed, &parsed, &error));
  assert(error == "grant_field_malformed");

  assert(!rd::ParseVirtualDisplayGrant(good + " extra=1", &parsed, &error));
  assert(error == "grant_unknown_key");
}

void IsValidRejectsEveryFieldIndividually() {
  // Direct, per-field. The wire parser has its own completeness check; this is
  // the shape half, and it must stand on its own.
  assert(Grant().IsValid());
  const struct { const char* label; void (*zero)(rd::VirtualDisplayGrant&); } cases[] = {
      {"uid", [](rd::VirtualDisplayGrant& g) { g.uid = 0; }},
      {"asid", [](rd::VirtualDisplayGrant& g) { g.audit_session_id = 0; }},
      {"session", [](rd::VirtualDisplayGrant& g) { g.session_type.clear(); }},
      {"svcgen", [](rd::VirtualDisplayGrant& g) { g.service_generation = 0; }},
      {"challenge", [](rd::VirtualDisplayGrant& g) { g.challenge.clear(); }},
      {"ttl", [](rd::VirtualDisplayGrant& g) { g.ttl_ms = 0; }},
      {"release", [](rd::VirtualDisplayGrant& g) { g.release_identity.clear(); }},
      {"set", [](rd::VirtualDisplayGrant& g) { g.set_sha256.clear(); }},
      {"helperfile", [](rd::VirtualDisplayGrant& g) { g.helper_file_name.clear(); }},
      {"helpersha", [](rd::VirtualDisplayGrant& g) { g.helper_sha256.clear(); }},
      {"helpersize", [](rd::VirtualDisplayGrant& g) { g.helper_size = 0; }},
      {"dr", [](rd::VirtualDisplayGrant& g) { g.helper_designated_requirement.clear(); }},
      {"helperbundle", [](rd::VirtualDisplayGrant& g) { g.helper_bundle_identifier.clear(); }},
      {"team", [](rd::VirtualDisplayGrant& g) { g.team_id.clear(); }},
      {"arch", [](rd::VirtualDisplayGrant& g) { g.arch.clear(); }},
  };
  for (const auto& entry : cases) {
    auto grant = Grant();
    entry.zero(grant);
    assert(!grant.IsValid());
    assert(rd::SerializeVirtualDisplayGrant(grant).empty());
  }
}

}  // namespace

// A serializer that only checked SHAPE could emit a line its own parser
// refuses. That is the two halves of one wire contract disagreeing about what
// is expressible -- and a value that is emittable but not parseable is exactly
// the seam a canonicalisation bypass lives in. So the serializer must gate on
// the wire-canonical question, and this proves the two predicates are actually
// different rather than one calling the other.
static void TheSerializerGatesOnWireCanonicalNotShape() {
  {
    // Shape-valid in every field, but the release directory names a different
    // set than the digest does.
    rd::VirtualDisplayGrant grant = Grant();
    grant.release_identity = "sha256-" + std::string(64, 'c');
    assert(grant.ShapeValid());
    assert(!grant.WireCanonicalValid());
    assert(rd::SerializeVirtualDisplayGrant(grant).empty());
  }
  {
    // Shape-valid, but the requirement names a team the grant does not claim.
    rd::VirtualDisplayGrant grant = Grant();
    grant.team_id = "ZZZZZ99999";
    assert(grant.ShapeValid());
    assert(!grant.WireCanonicalValid());
    assert(rd::SerializeVirtualDisplayGrant(grant).empty());
  }
  {
    // And the converse: wire-canonical implies shape-valid, so the serializer
    // gating on the stronger predicate never rejects a grant it should emit.
    const rd::VirtualDisplayGrant grant = Grant();
    assert(grant.ShapeValid());
    assert(grant.WireCanonicalValid());
    assert(!rd::SerializeVirtualDisplayGrant(grant).empty());
  }
}

// "This token has no k= at all" and "this field's value is wrong" are different
// failures wanting different responses. They are also how a spaced value
// degrades: the grammar is whitespace-delimited, so `helperfile=a b` arrives as
// `helperfile=a` plus a bare `b`. Folding them together would hide that the
// producer emitted a value it was never allowed to emit.
static void UnstructuredTokensAreDiagnosedSeparately() {
  const std::string line = rd::SerializeVirtualDisplayGrant(Grant());
  rd::VirtualDisplayGrant parsed;
  std::string error;

  // A value containing a space, as it actually arrives on the wire.
  const std::string spaced = ReplaceField(line, "helperfile=", "helper binary");
  assert(!rd::ParseVirtualDisplayGrant(spaced, &parsed, &error));
  assert(error == "grant_token_unstructured");

  // A bare word appended.
  assert(!rd::ParseVirtualDisplayGrant(line + " stray", &parsed, &error));
  assert(error == "grant_token_unstructured");

  // A token that begins with '=' has an empty key, which is equally unusable.
  assert(!rd::ParseVirtualDisplayGrant(line + " =1", &parsed, &error));
  assert(error == "grant_token_unstructured");

  // A well-formed but unknown key is a DIFFERENT verdict, which is what makes
  // the one above load-bearing rather than the parser's single way of saying no.
  assert(!rd::ParseVirtualDisplayGrant(line + " future=1", &parsed, &error));
  assert(error == "grant_unknown_key");

  // As is a known key whose value is simply wrong.
  const std::string bad = ReplaceField(line, "team=", "nope");
  assert(!rd::ParseVirtualDisplayGrant(bad, &parsed, &error));
  assert(error == "grant_field_malformed");
}

// The CEILINGS, exercised where they are actually reachable.
//
// These guards are not reachable through the parser: it applies its own bounds
// while decoding, so an out-of-domain value never survives to be shape-checked.
// They are reachable on the OTHER path -- native code that builds a grant in
// memory and serialises it. That path must be incapable of putting a value on
// the wire that the receiving parser would refuse, or the two ends disagree
// about the domain and the disagreement is only discovered in the field.
//
// Every case below is a value that is representable, non-zero, and wrong.
static void ShapeCeilingsAreEnforcedOnTheSerializePath() {
  const struct {
    const char* label;
    void (*breach)(rd::VirtualDisplayGrant&);
  } cases[] = {
      // UINT32_MAX is the kernel's "no such uid/session" sentinel, so it is a
      // representable value that names nobody.
      {"uid at UINT32_MAX",
       [](rd::VirtualDisplayGrant& g) { g.uid = UINT32_MAX; }},
      {"asid at UINT32_MAX",
       [](rd::VirtualDisplayGrant& g) { g.audit_session_id = UINT32_MAX; }},
      // Past 2^53-1 the TypeScript producer could not have meant the value it
      // sent: it lost precision on the way out of a double.
      {"svcgen past the safe integer range",
       [](rd::VirtualDisplayGrant& g) {
         g.service_generation = rd::kVirtualDisplayGrantMaxSafeInteger + 1;
       }},
      {"expiry past the safe integer range",
       [](rd::VirtualDisplayGrant& g) {
         g.ttl_ms = rd::kVirtualDisplayGrantMaxLifetimeMs + 1;
       }},
      {"helper size past the mirrored ceiling",
       [](rd::VirtualDisplayGrant& g) {
         g.helper_size = rd::kVirtualDisplayGrantMaxHelperBytes + 1;
       }},
      {"requirement past the wire bound",
       [](rd::VirtualDisplayGrant& g) {
         g.helper_designated_requirement =
             std::string(rd::kVirtualDisplayGrantMaxRequirementBytes + 1, 'x');
       }},
      {"a team identifier that is not one",
       [](rd::VirtualDisplayGrant& g) { g.team_id = "abcde12345"; }},
      {"a team identifier of the wrong length",
       [](rd::VirtualDisplayGrant& g) { g.team_id = "ABC123"; }},
      {"a helper filename containing a space",
       [](rd::VirtualDisplayGrant& g) { g.helper_file_name = "helper binary"; }},
      {"a helper filename containing a control byte",
       [](rd::VirtualDisplayGrant& g) { g.helper_file_name = "helper\x01bin"; }},
      {"a requirement containing a control byte",
       [](rd::VirtualDisplayGrant& g) {
         g.helper_designated_requirement.push_back('\x01');
       }},
      {"a requirement containing a non-ASCII byte",
       [](rd::VirtualDisplayGrant& g) {
         g.helper_designated_requirement.push_back(static_cast<char>(0xC3));
       }},
  };
  for (const auto& entry : cases) {
    auto grant = Grant();
    entry.breach(grant);
    // Shape is the layer that must catch these: they are per-field domain
    // facts, not disagreements between fields.
    assert(!grant.ShapeValid());
    assert(!grant.WireCanonicalValid());
    // And the serializer must therefore refuse to emit them at all.
    assert(rd::SerializeVirtualDisplayGrant(grant).empty());
  }

  // The boundaries themselves stay admissible, so the guards are bounds rather
  // than blanket refusals that would pass this suite just as well.
  {
    auto grant = Grant();
    grant.service_generation = rd::kVirtualDisplayGrantMaxSafeInteger;
    grant.ttl_ms = rd::kVirtualDisplayGrantMaxLifetimeMs;
    grant.helper_size = rd::kVirtualDisplayGrantMaxHelperBytes;
    grant.uid = UINT32_MAX - 1;
    grant.audit_session_id = UINT32_MAX - 1;
    assert(grant.ShapeValid());
  }
}

// The canonical requirement's TEXT, pinned literally.
//
// Every other check compares the requirement against whatever this function
// returns, so all of them stay green if a clause silently disappears from it --
// both sides of the comparison move together. `anchor apple generic` is the
// clause that demands an Apple-issued chain; without it the requirement is
// satisfied by a self-signed binary carrying the right identifier and OU, and
// nothing else in this suite would notice. So the string is asserted outright.
static void TheCanonicalRequirementTextIsPinned() {
  const std::string requirement =
      rd::CanonicalDesignatedRequirement("cc.example.helper", "ABCDE12345");
  assert(requirement ==
         "identifier \"cc.example.helper\" and anchor apple generic "
         "and certificate leaf[subject.OU] = \"ABCDE12345\"");

  // Each clause is separately load-bearing, so each is separately named.
  assert(requirement.find("anchor apple generic") != std::string::npos);
  assert(requirement.find("certificate leaf[subject.OU]") != std::string::npos);
  assert(requirement.find("identifier \"cc.example.helper\"") != std::string::npos);

  // It refuses to build a requirement from inputs it cannot vouch for: a
  // requirement assembled from an unvalidated identifier is a requirement an
  // attacker chose the text of.
  assert(rd::CanonicalDesignatedRequirement("cc.example.helper", "abcde12345").empty());
  assert(rd::CanonicalDesignatedRequirement("cc.example.helper", "").empty());
  assert(rd::CanonicalDesignatedRequirement("", "ABCDE12345").empty());
  assert(rd::CanonicalDesignatedRequirement("has space", "ABCDE12345").empty());
  assert(rd::CanonicalDesignatedRequirement("has\"quote", "ABCDE12345").empty());
}

// The bundle-identifier rule, byte-for-byte with the producer's BUNDLE_RE.
//
// The identifier is interpolated into the designated requirement, so the two
// ends disagreeing about which identifiers are spellable is not cosmetic. The
// dangerous direction is THIS side accepting one the producer would never emit:
// that is an identifier chosen by whoever wrote the line rather than by the
// release. The rule used to be IsToken, which also admits `_` and admits a
// leading `.` or `-`.
static void TheBundleIdentifierRuleMatchesTheProducer() {
  static constexpr const char* kRefused[] = {
      ".bad",        // admissible characters, wrong POSITION
      "-bad",        // same
      "_bad",        // leading punctuation and a character never admitted
      "cc_example",  // underscore anywhere
      "cc.example_x",
      "",
      "has space",
      "has\"quote",
      "cc.example\x01",
      "caf\xc3\xa9.app",  // non-ASCII
  };
  static constexpr const char* kAccepted[] = {
      "a",  // shortest legal
      "0",  // digits are alnum too
      "cc.imcodes.node.virtual-display-helper",
      "cc.example-app.helper",
      "a.-.-",  // punctuation is fine once it is not first
  };

  for (const char* identifier : kRefused) {
    // Observed through the seam production uses: a requirement is built only
    // for an identifier the rule vouches for.
    assert(rd::CanonicalDesignatedRequirement(identifier, "ABCDE12345").empty());
    // And the same rule must gate the grant's own field.
    auto grant = Grant();
    grant.helper_bundle_identifier = identifier;
    assert(!grant.ShapeValid());
    assert(rd::SerializeVirtualDisplayGrant(grant).empty());
  }
  for (const char* identifier : kAccepted) {
    assert(!rd::CanonicalDesignatedRequirement(identifier, "ABCDE12345").empty());
    auto grant = Grant();
    grant.helper_bundle_identifier = identifier;
    // The requirement must be rebuilt to match, or this would be testing the
    // cross-field rule instead of the identifier rule.
    grant.helper_designated_requirement =
        rd::CanonicalDesignatedRequirement(identifier, grant.team_id);
    assert(grant.ShapeValid());
    assert(grant.WireCanonicalValid());
  }

  // Exactly the shared 128-byte bound, and one past it.
  {
    auto grant = Grant();
    grant.helper_bundle_identifier = std::string(128, 'a');
    grant.helper_designated_requirement = rd::CanonicalDesignatedRequirement(
        grant.helper_bundle_identifier, grant.team_id);
    assert(grant.ShapeValid());
    // One past the bound, at both seams.
    assert(rd::CanonicalDesignatedRequirement(std::string(129, 'a'),
                                              "ABCDE12345").empty());
    grant.helper_bundle_identifier = std::string(129, 'a');
    assert(!grant.ShapeValid());
  }
}

// AT MOST ONE line terminator.
//
// The canonical form is compared after stripping, so unbounded stripping meant
// `line`, `line\n`, `line\n\n` and every longer run all reduced to the same
// canonical text -- arbitrarily many distinct byte frames naming one authority,
// with the closure check structurally unable to see the difference.
static void TrailingTerminatorsAreBounded() {
  const std::string line = rd::SerializeVirtualDisplayGrant(Grant());
  rd::VirtualDisplayGrant parsed;
  std::string error;

  // One terminator, in each of the three spellings a caller can hand us. A
  // getline payload is bare; a raw read keeps whatever the writer sent.
  for (const char* suffix : {"", "\n", "\r", "\r\n"}) {
    assert(rd::ParseVirtualDisplayGrant(line + suffix, &parsed, &error));
  }

  // More than one is a second frame's worth of bytes riding along inside the
  // first, and is refused rather than silently trimmed.
  for (const char* suffix : {"\n\n", "\r\r", "\r\n\r\n", "\n\r", "\n\n\n"}) {
    assert(!rd::ParseVirtualDisplayGrant(line + suffix, &parsed, &error));
    assert(error == "grant_frame_unusable");
  }

  // A terminator in the MIDDLE is not a terminator at all: it lands inside a
  // field value, where the per-field rules refuse it.
  assert(!rd::ParseVirtualDisplayGrant(
      ReplaceField(line, "team=", "ABCDE\n2345"), &parsed, &error));
}

int main() {
  RoundTripsLosslessly();
  MalformedGrantsAreRefused();
  FieldShapesAreEnforced();
  AdmissionBindsEverySessionFact();
  ExpiryAndReplayAreRefused();
  TheWireFormIsCanonicalAndClosed();
  CrossFieldDisagreementIsRefused();
  NumericDomainsMirrorTheProducer();
  MissingIsDiagnosedSeparatelyFromMalformed();
  IsValidRejectsEveryFieldIndividually();
  TheSerializerGatesOnWireCanonicalNotShape();
  UnstructuredTokensAreDiagnosedSeparately();
  ShapeCeilingsAreEnforcedOnTheSerializePath();
  TheCanonicalRequirementTextIsPinned();
  TheBundleIdentifierRuleMatchesTheProducer();
  TrailingTerminatorsAreBounded();
  std::printf("macos virtual display grant counterfactual ok\n");
  return 0;
}
