import {
  CONTROLLED_NODE_ABI_GLIBC217,
  CONTROLLED_NODE_ABI_MODERN,
  CONTROLLED_NODE_ABI_PROFILES,
  type ControlledNodeAbiProfile,
} from '../../../shared/controlled-node-abi.js';

/** Runs before any executable download. Linux only; macOS/Windows keep their original paths. */
export function linuxControlledNodeAbiDetectionScript(forcedProfile?: ControlledNodeAbiProfile): string {
  const { GLIBC217: compat, MODERN: modern } = CONTROLLED_NODE_ABI_PROFILES;
  return String.raw`
  imcodes_abi='__MODERN__'
  if [ "$imcodes_host_os" = linux ]; then
    [ "$(uname -m)" = x86_64 ] || { echo "IM.codes: Linux controlled nodes require x86_64." >&2; exit 1; }
    imcodes_ver_at_least() {
      awk -v got="$1" -v minimum="$2" 'BEGIN {
        if (got !~ /^[0-9]+(\.[0-9]+)+$/) exit 1
        n=split(got,a,"."); m=split(minimum,b,".")
        for(i=1;i<=n || i<=m;i++) { if(a[i]+0>b[i]+0) exit 0; if(a[i]+0<b[i]+0) exit 1 }
        exit 0
      }'
    }
    imcodes_glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '$1=="glibc" {print $2}')
    imcodes_kernel=$(uname -r | cut -d- -f1)
    imcodes_libstdcpp=''
    for imcodes_lib in /lib64/libstdc++.so.6 /usr/lib64/libstdc++.so.6 /usr/lib/x86_64-linux-gnu/libstdc++.so.6; do
      if [ -r "$imcodes_lib" ]; then imcodes_libstdcpp=$imcodes_lib; break; fi
    done
    [ -n "$imcodes_libstdcpp" ] || { echo "IM.codes: libstdc++ could not be inspected." >&2; exit 1; }
    imcodes_glibcxx=$(LC_ALL=C grep -ao 'GLIBCXX_[0-9]*\.[0-9]*\.[0-9]*' "$imcodes_libstdcpp" | sort -Vu | tail -n 1 | cut -d_ -f2)
    imcodes_ver_at_least "$imcodes_glibc" '__MIN_GLIBC__' &&
      imcodes_ver_at_least "$imcodes_kernel" '__MIN_KERNEL__' &&
      imcodes_ver_at_least "$imcodes_glibcxx" '__MIN_GLIBCXX__' || {
      echo "IM.codes: this machine is below the supported Linux x64 ABI minimum." >&2; exit 1;
    }
    if ! imcodes_ver_at_least "$imcodes_glibc" '__MODERN_GLIBC__' ||
       ! imcodes_ver_at_least "$imcodes_kernel" '__MODERN_KERNEL__' ||
       ! imcodes_ver_at_least "$imcodes_glibcxx" '__MODERN_GLIBCXX__'; then
      imcodes_abi='__COMPAT__'
    fi
    __FORCE_COMPAT__
    if [ "$imcodes_abi" = '__COMPAT__' ]; then
      # The legacy SELinux-safe watchdog uses a unit-owned standard-library sender.
      # Ignore Python environment/site hooks and never import from the caller's cwd.
      imcodes_python=''
      for imcodes_candidate in /usr/bin/python3 /usr/bin/python; do
        if [ -x "$imcodes_candidate" ]; then imcodes_python=$imcodes_candidate; break; fi
      done
      [ -n "$imcodes_python" ] && (cd /; "$imcodes_python" -E -S -c 'import socket') || {
        echo "IM.codes: the compatibility profile requires system Python (2.7 or 3) with socket." >&2; exit 1;
      }
      command -v curl >/dev/null 2>&1 || {
        echo "IM.codes: the compatibility profile requires curl for response ABI verification." >&2; exit 1;
      }
    fi
  fi
`
    .replace('__FORCE_COMPAT__', forcedProfile === CONTROLLED_NODE_ABI_GLIBC217 ? `imcodes_abi='${CONTROLLED_NODE_ABI_GLIBC217}'` : '')
    .replace(/__MODERN__/g, CONTROLLED_NODE_ABI_MODERN)
    .replace(/__COMPAT__/g, CONTROLLED_NODE_ABI_GLIBC217)
    .replace(/__MIN_GLIBC__/g, compat.minimumGlibc)
    .replace(/__MIN_KERNEL__/g, compat.minimumKernel)
    .replace(/__MIN_GLIBCXX__/g, compat.minimumGlibcxx)
    .replace(/__MODERN_GLIBC__/g, modern.minimumGlibc)
    .replace(/__MODERN_KERNEL__/g, modern.minimumKernel)
    .replace(/__MODERN_GLIBCXX__/g, modern.minimumGlibcxx);
}
