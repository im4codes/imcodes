# macOS entitlements for the controlled-node executable

`imcodes-node.entitlements` is applied when the binary is signed with a
Developer ID identity under the hardened runtime, which notarization requires.

## Why exactly these two

V8 compiles and runs machine code at runtime, so it needs both the JIT
entitlement and permission to execute pages it wrote itself. Without them the
binary signs, notarizes, and then dies on launch — the failure appears only on
a user's machine, never in the build.

## Why `disable-library-validation` is absent

It would let this process load a dylib signed by anyone, and the SEA has no
native addons to load: the entry is esbuild-bundled native-free and
`scripts/check-node-exe-deps.mjs` keeps it that way. Adding it "just in case"
trades a real security property for an imaginary one. If a native addon is ever
introduced, that check fails first and this decision gets revisited
deliberately.

## Keep this file comment-free

`plutil -lint` accepts XML comments here; `codesign` does not. Its entitlements
parser (AMFIUnserializeXML) rejects them with `syntax error near line N`, and
the failure surfaces at signing time, not in validation. Explanations live in
this README instead.
