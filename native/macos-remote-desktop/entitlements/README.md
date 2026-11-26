# macOS remote-desktop entitlements

Each shipped component is signed with the Hardened Runtime and the exact
entitlement allowlist `{com.apple.security.get-task-allow: false}`. No other
key is accepted, even when its value is `false`. That is a deliberate security
property, not an oversight:

* Screen capture and input injection are gated by TCC (Screen Recording and
  Accessibility), which is granted to the *code identity*, not by an
  entitlement. Adding `com.apple.security.cs.*` exceptions would weaken the
  runtime without unlocking any capability this feature needs.
* Every component links its dependencies statically against the
  repository-pinned libwebrtc, so `disable-library-validation` is not needed.
  Adding it would let an attacker who can write next to the binary load an
  arbitrary dylib into a process that holds remote-control authority.
* `com.apple.security.get-task-allow` is pinned to `false` so a debugger cannot
  attach to a component that can synthesize input on the console user's
  session.

`scripts/macos-remote-desktop-build.mjs` hashes these files into the canonical
`entitlementsPlanSha256`. The release guard places that same authoritative
field in its release-identity material, so changing any entitlement byte changes
the immutable release name and cannot be slipped in without an identity change.

`test/spec/macos-remote-desktop-build-sign-package.test.ts` fails if any
component gains any unreviewed key or if `get-task-allow` is missing or not
exactly `false`.

## `virtual-display-helper.entitlements`

Deliberately minimal, and identical to the disclosure helper's.

This process owns the warm virtual display's lifetime and nothing else. It holds
no route authority, receives no credential and performs no capture, so it asks
for none of the capture, input or network entitlements the worker needs.

It deliberately does **not** request `com.apple.private.SkyLight.virtualdisplay`.
That entitlement is real — verified present on exactly one system binary,
`ScreensharingAgent` — but it is a `com.apple.private.*` key that Apple does not
grant to third-party developers, so requesting it would produce a profile that
cannot be signed. NetEase UURemote 4.37.1 was verified read-only to ship a
working virtual display carrying only `com.apple.security.device.audio-input`,
which is direct evidence that the `CGVirtualDisplay` path needs no private
entitlement at all.
