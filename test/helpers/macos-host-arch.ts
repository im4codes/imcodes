/**
 * The host's architecture as clang's `-arch` names it. Node reports an Intel Mac as `x64`, but clang (and the
 * aidesk build, AIDESK_ARCHITECTURES) only accepts `x86_64`; arm64 is the same name in both.
 */
export const HOST_CLANG_ARCH = (process.arch === 'x64' ? 'x86_64' : process.arch) as 'arm64' | 'x86_64';
